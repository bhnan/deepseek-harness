/** Node half: registers the /api prefix route and optional password-login routes. */
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { interpolate } from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { WebServer, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  API_PATH,
  Config,
  RpcId,
  apply,
  inject,
  type ClientRequest,
  type ConnectionConfig,
  type HostConnectionHandle,
} from '../src/index.ts'
import { DEFAULT_MAX_REQUEST_BODY_BYTES } from '../src/http-bridge.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

/** Structural webServer fake recording both route registries. */
function fakeHttpServer(
  routes: WebRoute[],
  upgrades: WebUpgradeRoute[],
): Pick<WebServer, 'register' | 'registerUpgrade' | 'tapIndex' | 'port'> {
  return {
    register(route) {
      if (routes.some(candidate => candidate.kind === route.kind && candidate.path === route.path)) {
        throw new Error(`duplicate route ${route.path}`)
      }
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade(route) {
      upgrades.push(route)
      return () => { upgrades.splice(upgrades.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
  }
}

/** Bodyless GET carrying the given headers (enough for the trust fence + bridge). */
function fakeRequest(headers: Record<string, string>, url = `${API_PATH}/session.list`): IncomingMessage {
  const request = Readable.from([]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'GET', headers })
  return request
}

/** JSON POST carrying a complete client-request envelope. */
function fakePost(headers: Record<string, string>, url: string, body: unknown): IncomingMessage {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'POST', headers: { 'content-type': 'application/json', ...headers } })
  return request
}

/** Raw POST for malformed-body and media-type boundary cases. */
function fakeRawPost(headers: Record<string, string>, url: string, body: string): IncomingMessage {
  const request = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'POST', headers })
  return request
}

/** Form POST carrying the browser-native media type used by the password login page. */
function fakeFormPost(
  headers: Record<string, string>,
  url: string,
  body: string,
): IncomingMessage {
  return fakeRawPost({ 'content-type': 'application/x-www-form-urlencoded', ...headers }, url, body)
}

/** Request that records a body read so trust-fence tests can prove their short circuit. */
function unreadRequest(
  headers: Record<string, string>,
  url: string,
  method = 'POST',
): { request: IncomingMessage; reads: () => number } {
  let readCount = 0
  const request = new Readable({
    read() {
      readCount++
      this.push(Buffer.from('username=operator&password=correct'))
      this.push(null)
    },
  }) as unknown as IncomingMessage
  Object.assign(request, { url, method, headers })
  return { request, reads: () => readCount }
}

/** Response recorder compatible with both the fence's short-circuit and the bridge. */
function fakeResponse(): {
  response: ServerResponse
  state: { status?: number; headers?: Record<string, string>; body?: unknown }
} {
  const state: { status?: number; headers?: Record<string, string>; body?: unknown } = {}
  const chunks: Buffer[] = []
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(value: number, headers?: Record<string, string>) {
      state.status = value
      if (headers !== undefined) state.headers = headers
      return this
    },
    write(value: string | Uint8Array) { chunks.push(Buffer.from(value)); return true },
    end(this: { writableEnded: boolean }, value?: unknown) {
      if (typeof value === 'string' || value instanceof Uint8Array) chunks.push(Buffer.from(value))
      else if (value !== undefined) throw new TypeError('fake response only accepts string or Uint8Array bodies')
      if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

async function mounted(config?: ConnectionConfig): Promise<{
  routes: WebRoute[]
  upgrades: WebUpgradeRoute[]
  connection: HostConnectionHandle
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  const upgrades: WebUpgradeRoute[] = []
  provideBrowserCredentials(ctx)
  ctx.provide('webServer', fakeHttpServer(routes, upgrades) as WebServer)
  const fiber = ctx.plugin({ inject: [...inject], apply }, config)
  await fiber.await()
  return {
    routes,
    upgrades,
    connection: ctx.get('connection') as HostConnectionHandle,
    dispose: () => fiber.dispose(),
  }
}

/** Exchange a service's process token for one authority-bound Cookie header. */
function browserCookie(connection: HostConnectionHandle, authority: string): string {
  const url = new URL(connection.authenticatedUrl(`http://${authority}`))
  const exchanged = fakeResponse()
  connection.authorizeIndex(
    fakeRequest({ host: authority }, `${url.pathname}${url.search}`),
    exchanged.response,
  )
  const setCookie = exchanged.state.headers?.['set-cookie']
  if (setCookie === undefined) throw new Error('browser token exchange did not set a cookie')
  return setCookie.split(';', 1)[0]!
}

const LOGIN_PATH = '/auth/login'
const LOGOUT_PATH = '/auth/logout'
const PASSWORD_LOGIN = {
  username: 'operator',
  password: 'correct horse battery staple',
  sessionMaxAgeDays: 7,
  failureDelayMs: 0,
  secureCookie: true,
} satisfies NonNullable<ConnectionConfig['passwordLogin']>

function namedRoute(routes: readonly WebRoute[], path: string): WebRoute {
  const route = routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`missing ${path} route`)
  return route
}

function issuedCookie(state: { headers?: Record<string, string> }): string {
  const setCookie = state.headers?.['set-cookie']
  if (setCookie === undefined) throw new Error('password login did not set a cookie')
  return setCookie.split(';', 1)[0]!
}

/** Resolve the Web profile's Connection configuration against one launch environment. */
function webProfileConnectionConfig(environment: NodeJS.ProcessEnv): ConnectionConfig {
  const patches = yaml.load(
    readFileSync(new URL('../../../bundle/web-app/cordis.patch.yml', import.meta.url), 'utf8'),
    { schema: entryListSchema },
  ) as Array<{ insert?: Array<{ config?: Record<string, unknown>; id?: string }> }>
  const config = patches.flatMap(patch => patch.insert ?? []).find(row => row.id === 'connection')?.config
  if (config === undefined) throw new Error('web profile must configure Connection')
  return Config(interpolate({
    ctx: { webRuntime: { trustedHosts: [] } },
    process: { env: environment },
  }, config) as never)
}

describe('connection node half', () => {
  it('loads password login only from a complete Web account environment', () => {
    expect(webProfileConnectionConfig({}).passwordLogin).toBeUndefined()
    expect(() => webProfileConnectionConfig({ DSH_WEB_AUTH_USERNAME: 'operator' }))
      .toThrow(/passwordLogin/u)

    expect(webProfileConnectionConfig({
      DSH_WEB_AUTH_USERNAME: 'operator',
      DSH_WEB_AUTH_PASSWORD: 'correct horse battery staple',
    }).passwordLogin).toEqual({
      username: 'operator',
      password: 'correct horse battery staple',
      sessionMaxAgeDays: 7,
      failureDelayMs: 500,
      secureCookie: true,
    })
  })

  it.each([
    ['true', true],
    ['false', false],
  ])('loads %s as secureCookie and typed deployment values', (secureCookie, expectedSecureCookie) => {
    expect(webProfileConnectionConfig({
      DSH_WEB_AUTH_USERNAME: 'operator',
      DSH_WEB_AUTH_PASSWORD: 'correct horse battery staple',
      DSH_WEB_AUTH_SESSION_DAYS: '9',
      DSH_WEB_AUTH_FAILURE_DELAY_MS: '0',
      DSH_WEB_AUTH_SECURE_COOKIE: secureCookie,
    }).passwordLogin).toEqual({
      username: 'operator',
      password: 'correct horse battery staple',
      sessionMaxAgeDays: 9,
      failureDelayMs: 0,
      secureCookie: expectedSecureCookie,
    })
  })

  it.each([
    { DSH_WEB_AUTH_USERNAME: '' },
    { DSH_WEB_AUTH_PASSWORD: '' },
    { DSH_WEB_AUTH_SESSION_DAYS: 'not-a-number' },
    { DSH_WEB_AUTH_SESSION_DAYS: '' },
    { DSH_WEB_AUTH_SESSION_DAYS: '  ' },
    { DSH_WEB_AUTH_FAILURE_DELAY_MS: 'not-a-number' },
    { DSH_WEB_AUTH_FAILURE_DELAY_MS: '' },
    { DSH_WEB_AUTH_FAILURE_DELAY_MS: '  ' },
    { DSH_WEB_AUTH_SECURE_COOKIE: 'not-a-boolean' },
    { DSH_WEB_AUTH_SECURE_COOKIE: '' },
    { DSH_WEB_AUTH_SECURE_COOKIE: '  ' },
  ])('rejects malformed, empty, and blank Web password deployment values: %o', (environment) => {
    const username = 'review-only-operator'
    const password = 'review-only-secret'
    let message = ''
    try {
      webProfileConnectionConfig({
        DSH_WEB_AUTH_USERNAME: username,
        DSH_WEB_AUTH_PASSWORD: password,
        ...environment,
      })
    } catch (error) {
      if (!(error instanceof Error)) throw error
      message = error.message
    }
    expect(message).toMatch(/passwordLogin/u)
    expect(message).not.toContain(username)
    expect(message).not.toContain(password)
  })

  it('resolves optional password login defaults and rejects invalid deployment credentials', () => {
    expect(Config({}).passwordLogin).toBeUndefined()
    expect(Config({
      passwordLogin: { username: 'operator', password: 'correct horse battery staple' },
    } as never).passwordLogin).toEqual({
      username: 'operator',
      password: 'correct horse battery staple',
      sessionMaxAgeDays: 7,
      failureDelayMs: 500,
      secureCookie: true,
    })

    for (const passwordLogin of [
      { username: 'operator' },
      { password: 'correct horse battery staple' },
      { username: '', password: 'correct horse battery staple' },
      { username: 'operator', password: '', failureDelayMs: 500 },
      { username: 'operator', password: 'correct horse battery staple', sessionMaxAgeDays: 6 },
      { username: 'operator', password: 'correct horse battery staple', failureDelayMs: -1 },
      { username: 'operator', password: 'correct horse battery staple', failureDelayMs: 10_001 },
      { username: 'operator', password: 'correct horse battery staple', failureDelayMs: 1.5 },
    ]) {
      expect(() => Config({ passwordLogin } as never)).toThrow()
    }
  })

  it('rejects null password login configuration during parsing', () => {
    expect(() => Config({ passwordLogin: null } as never)).toThrow(/passwordLogin/u)
  })

  it('keeps credentials out of malformed password login errors', () => {
    const username = 'review-only-operator'
    const password = 'review-only-secret'
    let message = ''
    try {
      Config({
        passwordLogin: { username, password, failureDelayMs: 10_001 },
      } as never)
    } catch (error) {
      if (!(error instanceof Error)) throw error
      message = error.message
    }
    expect(message).toContain('passwordLogin')
    expect(message).not.toContain(username)
    expect(message).not.toContain(password)
  })

  it('passes configured password login to the browser-session owner', async () => {
    const { connection, dispose } = await mounted({
      passwordLogin: {
        username: 'operator',
        password: 'correct horse battery staple',
        sessionMaxAgeDays: 7,
        failureDelayMs: 500,
        secureCookie: true,
      },
    })

    expect(connection.authenticatedUrl('https://harness.example/nested?x=1#fragment'))
      .toBe('https://harness.example/')
    await dispose()
  })

  it('registers exact password routes only in password mode and removes them with the fiber', async () => {
    const { routes, upgrades, dispose } = await mounted({ passwordLogin: PASSWORD_LOGIN })

    expect(routes.map(route => [route.kind, route.path])).toEqual([
      ['prefix', API_PATH],
      ['exact', LOGIN_PATH],
      ['exact', LOGOUT_PATH],
    ])
    expect(upgrades).toHaveLength(0)
    await dispose()
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
  })

  it('serves localized host-owned password login HTML without deployment credentials', async () => {
    const { routes, dispose } = await mounted({
      trustedHosts: ['harness.example'],
      passwordLogin: PASSWORD_LOGIN,
    })
    const login = namedRoute(routes, LOGIN_PATH)
    try {
      const english = fakeResponse()
      await login.handler(fakeRequest({
        host: 'harness.example',
        'accept-language': 'en-US,en;q=0.9',
      }, LOGIN_PATH), english.response)
      const chinese = fakeResponse()
      await login.handler(fakeRequest({
        host: 'harness.example',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      }, LOGIN_PATH), chinese.response)
      const preferredEnglish = fakeResponse()
      await login.handler(fakeRequest({
        host: 'harness.example',
        'accept-language': 'zh;q=0.1,en;q=0.9',
      }, LOGIN_PATH), preferredEnglish.response)
      const excludedChinese = fakeResponse()
      await login.handler(fakeRequest({
        host: 'harness.example',
        'accept-language': 'zh;q=0',
      }, LOGIN_PATH), excludedChinese.response)

      expect(english.state).toMatchObject({
        status: 200,
        headers: {
          'cache-control': 'no-store',
          'content-type': 'text/html; charset=utf-8',
        },
      })
      expect(english.state.body).toContain('Sign in')
      expect(chinese.state.body).toContain('登录')
      expect(chinese.state.body).toContain('用户名')
      expect(preferredEnglish.state.body).toContain('Sign in')
      expect(excludedChinese.state.body).toContain('Sign in')
      for (const body of [english.state.body, chinese.state.body, preferredEnglish.state.body, excludedChinese.state.body]) {
        expect(body).not.toContain(PASSWORD_LOGIN.username)
        expect(body).not.toContain(PASSWORD_LOGIN.password)
      }
    } finally {
      await dispose()
    }
  })

  it('refuses untrusted and cross-site password routes before reading their bodies', async () => {
    const { routes, dispose } = await mounted({
      trustedHosts: ['harness.example'],
      passwordLogin: PASSWORD_LOGIN,
    })
    try {
      for (const [path, method, headers] of [
        [LOGIN_PATH, 'GET', { host: 'other.example' }],
        [LOGIN_PATH, 'POST', {
          host: 'harness.example',
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'cross-site',
        }],
        [LOGOUT_PATH, 'POST', { host: 'harness.example', origin: 'http://other.example' }],
      ] as const) {
        const unread = unreadRequest(headers, path, method)
        const response = fakeResponse()
        await namedRoute(routes, path).handler(unread.request, response.response)
        expect(response.state).toMatchObject({ status: 403, body: 'forbidden' })
        expect(response.state.headers?.['set-cookie']).toBeUndefined()
        expect(unread.reads()).toBe(0)
      }
    } finally {
      await dispose()
    }
  })

  it('refuses an untrusted Host POST before reading its password login body', async () => {
    const { routes, dispose } = await mounted({
      trustedHosts: ['harness.example'],
      passwordLogin: PASSWORD_LOGIN,
    })
    try {
      const unread = unreadRequest({
        host: 'other.example',
        'content-type': 'application/x-www-form-urlencoded',
      }, LOGIN_PATH)
      const response = fakeResponse()
      await namedRoute(routes, LOGIN_PATH).handler(unread.request, response.response)

      expect(response.state).toMatchObject({ status: 403, body: 'forbidden' })
      expect(response.state.headers?.['set-cookie']).toBeUndefined()
      expect(unread.reads()).toBe(0)
    } finally {
      await dispose()
    }
  })

  it('issues a secure password session that authenticates /api', async () => {
    const { routes, dispose } = await mounted({
      trustedHosts: ['harness.example'],
      passwordLogin: PASSWORD_LOGIN,
    })
    const login = namedRoute(routes, LOGIN_PATH)
    const api = namedRoute(routes, API_PATH)
    try {
      const submitted = fakeResponse()
      await login.handler(fakeFormPost(
        { host: 'harness.example' },
        LOGIN_PATH,
        new URLSearchParams({
          username: PASSWORD_LOGIN.username,
          password: PASSWORD_LOGIN.password,
        }).toString(),
      ), submitted.response)
      const cookie = issuedCookie(submitted.state)

      expect(submitted.state).toMatchObject({
        status: 303,
        headers: {
          'cache-control': 'no-store',
          location: '/',
          'referrer-policy': 'no-referrer',
        },
      })
      expect(submitted.state.headers?.['set-cookie']).toMatch(/; HttpOnly; Secure; SameSite=Strict$/u)
      expect(JSON.stringify(submitted.state)).not.toContain(PASSWORD_LOGIN.username)
      expect(JSON.stringify(submitted.state)).not.toContain(PASSWORD_LOGIN.password)

      const accepted = fakeResponse()
      await api.handler(fakeRequest({ host: 'harness.example', cookie }), accepted.response)
      expect(accepted.state.status).toBe(404)
      const denied = fakeResponse()
      await api.handler(fakeRequest({ host: 'harness.example' }), denied.response)
      expect(denied.state).toMatchObject({ status: 401, body: 'unauthorized' })
    } finally {
      await dispose()
    }
  })

  it('returns generic cookie-free password-login failures', async () => {
    const { routes, dispose } = await mounted({
      trustedHosts: ['harness.example'],
      passwordLogin: PASSWORD_LOGIN,
    })
    const login = namedRoute(routes, LOGIN_PATH)
    try {
      const invalidUsername = fakeResponse()
      await login.handler(fakeFormPost(
        { host: 'harness.example' },
        LOGIN_PATH,
        new URLSearchParams({ username: 'wrong', password: PASSWORD_LOGIN.password }).toString(),
      ), invalidUsername.response)
      const invalidPassword = fakeResponse()
      await login.handler(fakeFormPost(
        { host: 'harness.example' },
        LOGIN_PATH,
        new URLSearchParams({ username: PASSWORD_LOGIN.username, password: 'wrong' }).toString(),
      ), invalidPassword.response)
      const malformed = fakeResponse()
      await login.handler(fakeFormPost(
        { host: 'harness.example' },
        LOGIN_PATH,
        'username=operator&password=%',
      ), malformed.response)
      const missing = fakeResponse()
      await login.handler(fakeFormPost(
        { host: 'harness.example' },
        LOGIN_PATH,
        '',
      ), missing.response)
      const unsupported = fakeResponse()
      const unsupportedRequest = fakeFormPost(
        { host: 'harness.example' },
        LOGIN_PATH,
        new URLSearchParams({ username: PASSWORD_LOGIN.username, password: PASSWORD_LOGIN.password }).toString(),
      )
      unsupportedRequest.method = 'PUT'
      await login.handler(unsupportedRequest, unsupported.response)
      const oversized = fakeResponse()
      const oversizedRequest = fakeFormPost(
        { host: 'harness.example' },
        LOGIN_PATH,
        `username=${'x'.repeat(8 * 1024)}`,
      )
      await login.handler(oversizedRequest, oversized.response)

      expect(invalidUsername.state).toEqual(invalidPassword.state)
      expect(invalidUsername.state.status).toBe(401)
      expect(malformed.state.status).toBe(400)
      expect(missing.state.status).toBe(400)
      expect(unsupported.state.status).toBe(405)
      expect(oversized.state.status).toBe(413)
      for (const failure of [invalidUsername, invalidPassword, malformed, missing, unsupported, oversized]) {
        expect(failure.state.headers?.['set-cookie']).toBeUndefined()
        expect(failure.state.body).toBe(invalidUsername.state.body)
        expect(JSON.stringify(failure.state)).not.toContain(PASSWORD_LOGIN.username)
        expect(JSON.stringify(failure.state)).not.toContain(PASSWORD_LOGIN.password)
      }
    } finally {
      await dispose()
    }
  })

  it('expires only the logging-out browser cookie', async () => {
    const { routes, dispose } = await mounted({
      trustedHosts: ['harness.example'],
      passwordLogin: PASSWORD_LOGIN,
    })
    const login = namedRoute(routes, LOGIN_PATH)
    const logout = namedRoute(routes, LOGOUT_PATH)
    const api = namedRoute(routes, API_PATH)
    const form = new URLSearchParams({
      username: PASSWORD_LOGIN.username,
      password: PASSWORD_LOGIN.password,
    }).toString()
    try {
      const firstLogin = fakeResponse()
      await login.handler(fakeFormPost({ host: 'harness.example' }, LOGIN_PATH, form), firstLogin.response)
      const firstCookie = issuedCookie(firstLogin.state)
      const secondLogin = fakeResponse()
      await login.handler(fakeFormPost({ host: 'harness.example' }, LOGIN_PATH, form), secondLogin.response)
      const secondCookie = issuedCookie(secondLogin.state)
      const [cookieName] = firstCookie.split('=', 1)

      expect(firstCookie).not.toBe(secondCookie)
      const loggedOut = fakeResponse()
      await logout.handler(fakeFormPost({ host: 'harness.example', cookie: firstCookie }, LOGOUT_PATH, ''), loggedOut.response)
      expect(loggedOut.state).toMatchObject({
        status: 303,
        headers: {
          'cache-control': 'no-store',
          location: LOGIN_PATH,
          'referrer-policy': 'no-referrer',
        },
      })
      expect(loggedOut.state.headers?.['set-cookie'])
        .toBe(`${cookieName}=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict`)

      const loggedOutBrowser = fakeResponse()
      await api.handler(fakeRequest({ host: 'harness.example' }), loggedOutBrowser.response)
      expect(loggedOutBrowser.state.status).toBe(401)
      const otherBrowser = fakeResponse()
      await api.handler(fakeRequest({ host: 'harness.example', cookie: secondCookie }), otherBrowser.response)
      expect(otherBrowser.state.status).toBe(404)
    } finally {
      await dispose()
    }
  })

  it('reserves enough default carrier capacity for the 200 MiB image batch', () => {
    expect(DEFAULT_MAX_REQUEST_BODY_BYTES).toBe(300 * 1024 * 1024)
    expect(DEFAULT_MAX_REQUEST_BODY_BYTES).toBeGreaterThan(Math.ceil(200 * 1024 * 1024 * 4 / 3) + 1024 * 1024)
  })

  it('fails loud when the carrier cap cannot hold the configured image batch', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    ctx.provide('attachments', {
      imageLimits: { maxMessageImageBytes: 20 * 1024 * 1024 },
    } as AttachmentStore)
    await expect(apply(ctx, { maxRequestBodyBytes: 1024 }))
      .rejects.toThrow(/must be at least .* aggregate image limit/)
    expect(routes).toHaveLength(0)
  })

  it('fails the load on a trustedHosts entry that is not a bare authority', async () => {
    const routes: WebRoute[] = []
    const upgrades: WebUpgradeRoute[] = []
    const ctx = new Context()
    provideBrowserCredentials(ctx)
    ctx.provide('webServer', fakeHttpServer(routes, upgrades) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.internal/path'] })
    await expect(fiber).rejects.toThrow(/not a bare host\[:port\] authority/)
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
  })

  it('registers only the HTTP route and removes it with the fiber', async () => {
    const { routes, upgrades, dispose } = await mounted()
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: API_PATH })
    expect(upgrades).toHaveLength(0)
    await dispose()
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
  })

  it('refuses an untrusted Host on any /api path before the bridge runs', async () => {
    const { routes, dispose } = await mounted()
    const { response, state } = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: 'harness.example', origin: 'http://harness.example', 'sec-fetch-site': 'same-origin',
    }), response)
    expect(state.status).toBe(403)
    expect(state.body).toBe('forbidden')
    await dispose()
  })

  it('requires the same browser session for every method on every trusted authority', async () => {
    const { routes, connection, dispose } = await mounted({ trustedHosts: ['harness.example'] })
    const methods = [
      'session/openWorkspacePath',
      'llm/discoverModels', 'skills/list', 'settings/openAgentPresetDirectory',
    ]
    for (const method of methods) {
      const denied = fakeResponse()
      await routes[0]!.handler(fakeRequest({ host: 'harness.example' }, `${API_PATH}/${method}`), denied.response)
      expect([method, denied.state.status, denied.state.body]).toEqual([method, 401, 'unauthorized'])
    }

    const cookie = browserCookie(connection, 'harness.example')
    for (const method of methods) {
      const allowed = fakeResponse()
      await routes[0]!.handler(
        fakeRequest({ host: 'harness.example', cookie }, `${API_PATH}/${method}`),
        allowed.response,
      )
      expect([method, allowed.state.status]).toEqual([method, 404])
    }

    const forged = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: 'localhost:3080' }), forged.response)
    expect(forged.state).toMatchObject({ status: 401, body: 'unauthorized' })
    await dispose()
  })

  it('passes loopback and declared-authority requests through to the bridge', async () => {
    const { routes, connection, dispose } = await mounted({ trustedHosts: ['harness.example:3080', '192.168.1.5'] })
    // Loopback, no browser markers (curl shape): the fence passes; the carrier
    // answers 404 for a GET unary path — proof the bridge ran.
    const loopback = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: '127.0.0.1:3080',
      cookie: browserCookie(connection, '127.0.0.1:3080'),
    }), loopback.response)
    expect(loopback.state.status).toBe(404)
    // An all-interfaces composition derives port-less LAN IP literals, which
    // pass markerless curl on any port.
    const lan = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: '192.168.1.5:3080',
      cookie: browserCookie(connection, '192.168.1.5:3080'),
    }), lan.response)
    expect(lan.state.status).toBe(404)
    // Declared public authority, same-origin browser shape.
    const declared = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: 'harness.example:3080',
      origin: 'http://harness.example:3080',
      'sec-fetch-site': 'same-origin',
      cookie: browserCookie(connection, 'harness.example:3080'),
    }), declared.response)
    expect(declared.state.status).toBe(404)
    await dispose()
  })

  it('shares its configured trust and authentication policy with sibling routes', async () => {
    const { connection, dispose } = await mounted({ trustedHosts: ['harness.example'] })
    const loopback = fakeRequest({ host: '127.0.0.1:3080' })
    const declared = fakeRequest({ host: 'harness.example' })

    expect(connection.requestRejection(loopback)).toBe(401)
    expect(connection.requestRejection(declared)).toBe(401)
    expect(connection.requestRejection(fakeRequest({
      host: 'harness.example',
      cookie: browserCookie(connection, 'harness.example'),
    }))).toBeUndefined()
    await dispose()
  })

  it('provides a disposable dedicated RPC channel', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    provideBrowserCredentials(ctx)
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: API_PATH })

    const connection = ctx.get('connection') as HostConnectionHandle
    const calls: unknown[] = []
    const remove = connection.rpc.handle('/rpc', async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: { accepted: true } }
    })
    const route = routes.find(candidate => candidate.path === '/rpc')
    expect(route).toBeDefined()

    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('rpc-dedicated'),
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }
    const result = fakeResponse()
    await route!.handler(fakePost({
      host: '127.0.0.1:3080',
      cookie: browserCookie(connection, '127.0.0.1:3080'),
    }, '/rpc/goals/create', request), result.response)
    expect(result.state.status).toBe(200)
    expect(JSON.parse(String(result.state.body))).toEqual({
      type: 'server-response',
      rpcId: 'rpc-dedicated',
      result: { ok: true, value: { accepted: true } },
    })
    expect(calls).toEqual([{
      endpoint: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }])

    expect(() => connection.rpc.handle('/rpc', async () => ({ ok: true, value: null })))
      .toThrow(/duplicate route/)
    await remove()
    expect(routes.map(candidate => candidate.path)).toEqual([API_PATH])
    await fiber.dispose()
    expect(routes).toHaveLength(0)
  })

  it('dispatches claimed /api endpoints and withdraws the claim', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    provideBrowserCredentials(ctx)
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
    await fiber.await()
    const connection = ctx.get('connection') as HostConnectionHandle
    const calls: unknown[] = []
    const remove = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'goals/create',
      async (endpoint, payload) => {
        calls.push({ endpoint, payload })
        return { ok: true, value: { accepted: true } }
      },
    )
    expect(() => connection.rpc.intercept(
      '/api',
      () => true,
      async () => ({ ok: true, value: null }),
    )).toThrow('already has an interceptor')
    expect(() => connection.rpc.intercept(
      '/rpc' as '/api',
      () => true,
      async () => ({ ok: true, value: null }),
    )).toThrow('invalid shared RPC channel')
    const route = routes.find(candidate => candidate.path === API_PATH)!
    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('rpc-shared'),
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }

    const claimed = fakeResponse()
    const loopbackCookie = browserCookie(connection, '127.0.0.1:3080')
    await route.handler(fakePost({
      host: '127.0.0.1:3080', cookie: loopbackCookie,
    }, '/api/goals/create', request), claimed.response)
    expect(JSON.parse(String(claimed.state.body))).toEqual({
      type: 'server-response',
      rpcId: 'rpc-shared',
      result: { ok: true, value: { accepted: true } },
    })
    expect(calls).toEqual([{
      endpoint: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }])

    const denied = fakeResponse()
    await route.handler(fakePost({ host: 'other.example' }, '/api/goals/create', request), denied.response)
    expect(denied.state).toMatchObject({ status: 403, body: 'forbidden' })
    expect(calls).toHaveLength(1)

    const unclaimed = fakeResponse()
    await route.handler(fakeRequest({
      host: '127.0.0.1:3080', cookie: loopbackCookie,
    }, '/api/session.list'), unclaimed.response)
    expect(unclaimed.state.status).toBe(404)

    await remove()
    const withdrawn = fakeResponse()
    await route.handler(fakePost({
      host: '127.0.0.1:3080', cookie: loopbackCookie,
    }, '/api/goals/create', request), withdrawn.response)
    expect(withdrawn.state.status).toBe(404)
    expect(calls).toHaveLength(1)

    const removeAuthenticated = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'goals/create',
      async () => ({ ok: true, value: null }),
    )
    const declared = fakeResponse()
    await route.handler(fakePost({
      host: 'harness.example',
      cookie: browserCookie(connection, 'harness.example'),
    }, '/api/goals/create', request), declared.response)
    expect(declared.state.status).toBe(200)
    await removeAuthenticated()
    await fiber.dispose()
  })

  it('applies the configured trust fence and JSON envelope checks to generic channels', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    provideBrowserCredentials(ctx)
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
    await fiber.await()
    const connection = ctx.get('connection') as HostConnectionHandle
    const remove = connection.rpc.handle('/rpc', async (endpoint) => {
      if (endpoint === 'fail') throw new Error('handler broke')
      return { ok: true, value: null }
    })
    const route = routes.find(candidate => candidate.path === '/rpc')!
    const harnessHeaders = {
      host: 'harness.example',
      cookie: browserCookie(connection, 'harness.example'),
    }

    const denied = fakeResponse()
    await route.handler(fakePost({ host: 'other.example' }, '/rpc/goals/create', {}), denied.response)
    expect(denied.state).toMatchObject({ status: 403, body: 'forbidden' })

    const unauthenticated = fakeResponse()
    await route.handler(fakePost({ host: 'harness.example' }, '/rpc/goals/create', {}), unauthenticated.response)
    expect(unauthenticated.state).toMatchObject({ status: 401, body: 'unauthorized' })

    const methodMismatch = fakeResponse()
    await route.handler(fakePost(harnessHeaders, '/rpc/goals/create', {
      type: 'client-request', rpcId: 'rpc-bad', method: 'other', payload: {},
    }), methodMismatch.response)
    expect(JSON.parse(String(methodMismatch.state.body))).toMatchObject({
      rpcId: 'rpc-bad',
      result: { ok: false, error: { code: 'gateway/bad-request' } },
    })

    for (const [request, status] of [
      [fakeRequest(harnessHeaders, '/rpc/goals/create'), 404],
      [fakePost(harnessHeaders, '/outside/goals/create', {}), 404],
      [fakePost(harnessHeaders, '/rpc/goals//create', {}), 404],
      [fakeRawPost(harnessHeaders, '/rpc/goals/create', '{}'), 415],
      [fakeRawPost({ ...harnessHeaders, 'content-type': 'text/plain' }, '/rpc/goals/create', '{}'), 415],
      [fakeRawPost({ ...harnessHeaders, 'content-type': 'application/json; charset=utf-8' }, '/rpc/goals/create', '{'), 400],
    ] as const) {
      const response = fakeResponse()
      await route.handler(request, response.response)
      expect(response.state.status).toBe(status)
    }

    for (const [body, rpcId] of [
      [{ rpcId: 'retained-id' }, 'retained-id'],
      [{ rpcId: 42 }, 'invalid-request'],
      [null, 'invalid-request'],
    ] as const) {
      const response = fakeResponse()
      await route.handler(fakePost(harnessHeaders, '/rpc/goals/create', body), response.response)
      expect(JSON.parse(String(response.state.body))).toMatchObject({
        rpcId,
        result: { ok: false, error: { code: 'gateway/bad-request' } },
      })
    }

    const failed = fakeResponse()
    await route.handler(fakePost(harnessHeaders, '/rpc/fail', {
      type: 'client-request', rpcId: 'rpc-fail', method: 'fail', payload: {},
    }), failed.response)
    expect(failed.state).toMatchObject({ status: 500, body: 'handler failure: Error: handler broke' })

    expect(() => connection.rpc.handle('/api', async () => ({ ok: true, value: null })))
      .toThrow('invalid or reserved RPC channel')
    expect(() => connection.rpc.handle('api3', async () => ({ ok: true, value: null })))
      .toThrow('invalid or reserved RPC channel')
    await remove()
    await fiber.dispose()
  })
})

describe('connection node half over a real HTTP server', () => {
  /** Serve one registered route from a real server and return its port. */
  async function serve(
    routes: WebRoute[],
    route = routes[0]!,
  ): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer((request, response) => {
      void route.handler(request, response)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    return {
      port: address.port,
      close: () => new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined || error === null) resolve()
          else reject(error)
        })
      }),
    }
  }

  /** One real request; `host` spoofs the authority the way a LAN client's browser would send it. */
  function call(port: number, method: string, host: string, cookie?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: `${API_PATH}/${method}`,
          method: 'GET',
          headers: { host, ...cookie === undefined ? {} : { cookie } },
        },
        (response) => {
          response.resume()
          response.on('end', () => { resolve(response.statusCode ?? 0) })
        },
      )
      request.on('error', reject)
      request.end()
    })
  }

  /** One deliberately unfinished real HTTP request. */
  interface IncompleteRequest {
    readonly path: string
    readonly method: string
    readonly headers: Readonly<Record<string, string>>
    readonly body: string
    readonly timeoutMs?: number
  }

  /** Submit one body chunk without ending the request, then capture the server response. */
  function streamIncompleteRequest(port: number, options: IncompleteRequest): Promise<{
    status: number
    connection: string | undefined
    setCookie: string | string[] | undefined
    body: string
  }> {
    return new Promise((resolve, reject) => {
      let settled = false
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: options.path,
          method: options.method,
          headers: {
            host: 'harness.example',
            connection: 'keep-alive',
            'transfer-encoding': 'chunked',
            ...options.headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => { chunks.push(Buffer.from(chunk)) })
          response.once('error', (error) => {
            if (!settled) {
              settled = true
              reject(error)
            }
          })
          response.once('end', () => {
            if (settled) return
            settled = true
            resolve({
              status: response.statusCode ?? 0,
              connection: response.headers.connection,
              setCookie: response.headers['set-cookie'],
              body: Buffer.concat(chunks).toString(),
            })
            request.destroy()
          })
        },
      )
      request.once('error', (error) => {
        if (!settled) {
          settled = true
          reject(error)
        }
      })
      request.setTimeout(options.timeoutMs ?? 2_000, () => {
        request.destroy(new Error(`timed out waiting for ${options.path} response`))
      })
      request.write(options.body)
    })
  }

  it('delivers a generic 413 before closing an oversized streamed login request', async () => {
    const { routes, dispose } = await mounted({
      trustedHosts: ['harness.example'],
      passwordLogin: PASSWORD_LOGIN,
    })
    const { port, close } = await serve(routes, namedRoute(routes, LOGIN_PATH))
    try {
      const response = await streamIncompleteRequest(port, {
        path: LOGIN_PATH,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `username=${'x'.repeat(8 * 1024)}`,
      })

      expect(response).toMatchObject({ status: 413, connection: 'close' })
      expect(response.setCookie).toBeUndefined()
      expect(response.body).toContain('Unable to sign in. Please try again.')
      expect(response.body).not.toContain(PASSWORD_LOGIN.username)
      expect(response.body).not.toContain(PASSWORD_LOGIN.password)
    } finally {
      await close()
      await dispose()
    }
  })

  it.each([
    ['an untrusted login', LOGIN_PATH, 'POST', {
      host: 'other.example',
      'content-type': 'application/x-www-form-urlencoded',
    }, 403],
    ['a cross-site login', LOGIN_PATH, 'POST', {
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'cross-site',
    }, 403],
    ['a login with an invalid media type', LOGIN_PATH, 'POST', {
      'content-type': 'text/plain',
    }, 400],
    ['an unsupported login method', LOGIN_PATH, 'PUT', {
      'content-type': 'application/x-www-form-urlencoded',
    }, 405],
    ['a logout POST', LOGOUT_PATH, 'POST', {
      'content-type': 'application/x-www-form-urlencoded',
    }, 303],
  ] as const)('closes an unread body after %s', async (label, path, method, headers, status) => {
    const { routes, dispose } = await mounted({
      trustedHosts: ['harness.example'],
      passwordLogin: PASSWORD_LOGIN,
    })
    const { port, close } = await serve(routes, namedRoute(routes, path))
    try {
      const response = await streamIncompleteRequest(port, {
        path,
        method,
        headers,
        body: 'username=operator&password=correct',
      })

      expect(response).toMatchObject({ status, connection: 'close' })
      if (label === 'a logout POST') {
        expect(response.setCookie).toEqual([expect.stringMatching(/^[^=]+=; Max-Age=0;/u)])
      } else {
        expect(response.setCookie).toBeUndefined()
      }
      expect(JSON.stringify(response)).not.toContain(PASSWORD_LOGIN.username)
      expect(JSON.stringify(response)).not.toContain(PASSWORD_LOGIN.password)
    } finally {
      await close()
      await dispose()
    }
  })

  it('times out an incomplete login form before the client deadline', async () => {
    const { routes, dispose } = await mounted({
      trustedHosts: ['harness.example'],
      passwordLogin: PASSWORD_LOGIN,
    })
    const { port, close } = await serve(routes, namedRoute(routes, LOGIN_PATH))
    try {
      const response = await streamIncompleteRequest(port, {
        path: LOGIN_PATH,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'username=operator',
      })

      expect(response).toMatchObject({ status: 408, connection: 'close' })
      expect(response.setCookie).toBeUndefined()
      expect(JSON.stringify(response)).not.toContain(PASSWORD_LOGIN.username)
      expect(JSON.stringify(response)).not.toContain(PASSWORD_LOGIN.password)
    } finally {
      await close()
      await dispose()
    }
  })

  it('requires authentication uniformly over a real HTTP request', async () => {
    // A real IncomingMessage pins the exploit boundary: a client-controlled
    // Host naming loopback passes the rebinding fence but never authenticates.
    const { routes, connection, dispose } = await mounted({ trustedHosts: ['harness.example'] })
    const { port, close } = await serve(routes)
    try {
      const methods = [
        'settings/openSettingsDocument',
        'session/openWorkspacePath',
        'llm/discoverModels', 'skills/list',
        'settings/openAgentPresetDirectory',
        'llm/listProviders', 'session/modelCatalog',
      ]
      for (const method of methods) {
        expect([method, await call(port, method, 'localhost')]).toEqual([method, 401])
        expect([method, await call(port, method, 'harness.example')]).toEqual([method, 401])
      }
      expect(await call(port, 'settings/openSettingsDocument', 'other.example')).toBe(403)

      const declaredCookie = browserCookie(connection, 'harness.example')
      for (const method of methods) {
        expect([method, await call(port, method, 'harness.example', declaredCookie)]).toEqual([method, 404])
      }
      const loopbackAuthority = `127.0.0.1:${String(port)}`
      expect(await call(
        port,
        'settings/openSettingsDocument',
        loopbackAuthority,
        browserCookie(connection, loopbackAuthority),
      )).toBe(404)
    } finally {
      await close()
      await dispose()
    }
  })
})
