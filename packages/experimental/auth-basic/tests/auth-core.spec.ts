/** Authentication mechanics stay testable without exposing them from the package entrypoint. */

import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AuthGate,
  clearSessionCookie,
  decodeSessionCookie,
  encodeSessionCookie,
  forwardToOriginal,
  isApiPath,
  isAuthPath,
  isStaticAsset,
  jsonError,
  parseCookies,
  renderLoginPage,
  setSessionCookie,
} from '../src/auth.ts'

interface ResponseState {
  statusCode: number | undefined
  headers: Record<string, unknown>
  body: string | undefined
}

/** Create the minimal response object consumed by the package-private handlers. */
function responseCapture(): { response: ServerResponse; state: ResponseState } {
  const state: ResponseState = { statusCode: undefined, headers: {}, body: undefined }
  const response = {
    writeHead(statusCode: number, headers?: Record<string, string>) {
      state.statusCode = statusCode
      Object.assign(state.headers, headers)
    },
    setHeader(name: string, value: unknown) {
      state.headers[name] = value
    },
    end(body?: string) {
      state.body = body
    },
  } as unknown as ServerResponse
  return { response, state }
}

/** Build an in-memory JSON request with an optional session cookie. */
function bodyRequest(body: string, cookie?: string): IncomingMessage {
  return Object.assign(Readable.from([body]), {
    headers: cookie === undefined ? {} : { cookie },
    method: 'POST',
    url: '/api/auth/login',
  }) as unknown as IncomingMessage
}

/** Build an incoming-message analogue whose body stream fails before JSON can be parsed. */
function failingBodyRequest(): IncomingMessage {
  return Object.assign(new Readable({
    read() {
      this.destroy(new Error('fixture request body failure'))
    },
  }), {
    headers: {},
    method: 'POST',
    url: '/api/auth/login',
  }) as unknown as IncomingMessage
}

/** Read the session token from one successful login response. */
function sessionCookie(state: ResponseState): string {
  const header = state.headers['set-cookie']
  if (!Array.isArray(header) || typeof header[0] !== 'string') throw new Error('login response did not set a session cookie')
  return header[0].split(';', 1)[0]!
}

afterEach(() => {
  vi.useRealTimers()
})

describe('auth core', () => {
  it('encodes only valid signed session values and parses cookie headers', async () => {
    const secret = 'fixture-session-secret'
    const encoded = await encodeSessionCookie('fixture-session', secret)
    expect(await decodeSessionCookie(encoded, secret)).toBe('fixture-session')
    expect(await decodeSessionCookie('not-a-pair', secret)).toBeNull()
    expect(await decodeSessionCookie('one.two.three', secret)).toBeNull()
    expect(await decodeSessionCookie('one.two', secret)).toBeNull()

    const [identifier, signature] = encoded.split('.') as [string, string]
    const replacement = signature.endsWith('A') ? 'B' : 'A'
    expect(await decodeSessionCookie(identifier + '.' + signature.slice(0, -1) + replacement, secret)).toBeNull()

    expect(parseCookies({ headers: {} } as IncomingMessage)).toEqual({})
    expect(parseCookies({
      headers: { cookie: 'first=one; malformed; dsh_session=' + encoded + '; third=three=four' },
    } as IncomingMessage)).toEqual({
      first: 'one',
      dsh_session: encoded,
      third: 'three=four',
    })
  })

  it('classifies every login and asset route without assigning authentication semantics to the core Web server', () => {
    for (const pathname of ['/login', '/login.html', '/auth/login', '/auth/login.html', '/api/auth/login', '/favicon.ico']) {
      expect(isAuthPath(pathname)).toBe(true)
    }
    expect(isAuthPath('/private')).toBe(false)
    expect(isApiPath('/api/state')).toBe(true)
    expect(isApiPath('/application')).toBe(false)

    expect(isStaticAsset('/auth/theme.CSS')).toBe(true)
    expect(isStaticAsset('/outside/theme.css')).toBe(false)
    expect(isStaticAsset('/auth/no-extension')).toBe(false)
    expect(isStaticAsset('/auth/theme.txt')).toBe(false)
  })

  it('renders escaped login HTML and formats response helpers', async () => {
    expect(renderLoginPage('Fixture <&>" Realm', 'Failure <&>" reason')).toContain(
      '<h1>Fixture &lt;&amp;&gt;&quot; Realm</h1>',
    )
    expect(renderLoginPage('Fixture Realm')).not.toContain('<div class="error">')

    const error = responseCapture()
    jsonError(error.response, 418, 'teapot')
    expect(error.state).toEqual({
      statusCode: 418,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'teapot' }),
    })

    const cookie = responseCapture()
    await setSessionCookie(cookie.response, 'fixture-session', 'fixture-secret', 17)
    expect(cookie.state.headers['set-cookie']).toEqual([
      expect.stringContaining('dsh_session='),
    ])
    expect(cookie.state.headers['set-cookie']).toEqual([
      expect.stringContaining('Max-Age=17'),
    ])
    clearSessionCookie(cookie.response)
    expect(cookie.state.headers['set-cookie']).toEqual([
      'dsh_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    ])

    const forwarded: string[] = []
    const request = bodyRequest('{}')
    const response = responseCapture().response
    forwardToOriginal([], request, response)
    forwardToOriginal([
      () => { forwarded.push('first') },
      () => { forwarded.push('second') },
    ], request, response)
    expect(forwarded).toEqual(['first', 'second'])
  })

  it('validates every login failure and accepts the one configured shared identity', async () => {
    const gate = new AuthGate({
      username: 'fixture-user',
      password: 'fixture-password',
      sessionSecret: 'fixture-session-secret',
      sessionMaxAge: 60,
      realm: 'Fixture Harness',
    })

    const brokenBody = responseCapture()
    await gate.handleLogin(failingBodyRequest(), brokenBody.response)
    expect(brokenBody.state).toMatchObject({
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid request body' }),
    })

    const invalidJson = responseCapture()
    await gate.handleLogin(bodyRequest('{'), invalidJson.response)
    expect(invalidJson.state).toMatchObject({
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    })

    for (const body of [
      null,
      {},
      { username: '', password: 'fixture-password' },
      { username: 'fixture-user', password: [] },
      { username: 'fixture-user', password: '' },
    ]) {
      const missing = responseCapture()
      await gate.handleLogin(bodyRequest(JSON.stringify(body)), missing.response)
      expect(missing.state).toMatchObject({
        statusCode: 400,
        body: JSON.stringify({ error: 'Username and password are required' }),
      })
    }

    for (const body of [
      { username: 'fixture-uzer', password: 'fixture-password' },
      { username: 'fixture-user', password: 'fixture-passw0rd' },
    ]) {
      const rejected = responseCapture()
      await gate.handleLogin(bodyRequest(JSON.stringify(body)), rejected.response)
      expect(rejected.state).toMatchObject({
        statusCode: 401,
        body: JSON.stringify({ error: '用户名或密码错误' }),
      })
    }

    const accepted = responseCapture()
    await gate.handleLogin(bodyRequest(JSON.stringify({
      username: 'fixture-user',
      password: 'fixture-password',
    })), accepted.response)
    expect(accepted.state).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ ok: true }),
    })
    const cookie = sessionCookie(accepted.state)
    expect(await gate.isAuthenticated(bodyRequest('{}', cookie))).toBe(true)
  })

  it('rejects unauthenticated requests, invalidates signed sessions, and expires old sessions', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-26T00:00:00.000Z'))
    const gate = new AuthGate({
      username: 'fixture-user',
      password: 'fixture-password',
      sessionMaxAge: 60,
    })
    expect(gate.loginPage()).toContain('<h1>DeepSeek Harness</h1>')
    expect(await gate.isAuthenticated(bodyRequest('{}'))).toBe(false)
    expect(await gate.isAuthenticated(bodyRequest('{}', 'dsh_session=not-a-pair'))).toBe(false)

    const accepted = responseCapture()
    await gate.handleLogin(bodyRequest(JSON.stringify({
      username: 'fixture-user',
      password: 'fixture-password',
    })), accepted.response)
    const cookie = sessionCookie(accepted.state)
    expect(await gate.isAuthenticated(bodyRequest('{}', cookie))).toBe(true)

    gate.cleanup()
    expect(await gate.isAuthenticated(bodyRequest('{}', cookie))).toBe(true)
    vi.setSystemTime(new Date('2026-08-26T00:01:01.000Z'))
    gate.cleanup()
    expect(await gate.isAuthenticated(bodyRequest('{}', cookie))).toBe(false)

    const rejected = responseCapture()
    gate.reject(rejected.response)
    expect(rejected.state).toMatchObject({
      statusCode: 401,
      body: JSON.stringify({ error: 'Authentication required. Please log in.' }),
    })
  })

  it('removes only a valid current session on logout', async () => {
    const gate = new AuthGate({
      username: 'fixture-user',
      password: 'fixture-password',
      sessionSecret: 'fixture-session-secret',
    })
    const accepted = responseCapture()
    await gate.handleLogin(bodyRequest(JSON.stringify({
      username: 'fixture-user',
      password: 'fixture-password',
    })), accepted.response)
    const cookie = sessionCookie(accepted.state)

    const unknownSession = await encodeSessionCookie('unknown-session', 'fixture-session-secret')
    for (const request of [
      bodyRequest('{}'),
      bodyRequest('{}', 'dsh_session=not-a-pair'),
      bodyRequest('{}', 'dsh_session=' + unknownSession),
    ]) {
      const logout = responseCapture()
      await gate.handleLogout(request, logout.response)
      expect(logout.state).toMatchObject({
        statusCode: 200,
        body: JSON.stringify({ ok: true }),
      })
    }
    expect(await gate.isAuthenticated(bodyRequest('{}', cookie))).toBe(true)

    const logout = responseCapture()
    await gate.handleLogout(bodyRequest('{}', cookie), logout.response)
    expect(logout.state.headers['set-cookie']).toEqual([
      'dsh_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    ])
    expect(await gate.isAuthenticated(bodyRequest('{}', cookie))).toBe(false)
  })
})
