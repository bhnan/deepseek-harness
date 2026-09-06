/** Browser launch-token and persistent-cookie behavior. */

import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { BrowserAuth } from '../src/browser-auth.ts'
import type { PasswordLoginConfig } from '../src/password-login.ts'
import type { ConnectionIndexRequest, ConnectionIndexResponse } from '../src/rpc.ts'
import { RecordCredentials } from './browser-credentials.ts'

const PASSWORD_LOGIN: PasswordLoginConfig = {
  username: 'operator',
  password: 'correct horse battery staple',
  sessionMaxAgeDays: 7,
  failureDelayMs: 500,
  secureCookie: true,
}

function signedCookie(store: RecordCredentials, name: string, payload: unknown): string {
  const body = typeof payload === 'string'
    ? Buffer.from(payload, 'utf8').toString('base64url')
    : Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return signedBodyCookie(store, name, body)
}

function signedBodyCookie(store: RecordCredentials, name: string, body: string): string {
  const record = store.record
  if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) {
    throw new Error('test credential store has no signing secret')
  }
  const secret: unknown = Reflect.get(record.payload, 'secret')
  if (typeof secret !== 'string') throw new Error('test credential record has no string secret')
  const signature = createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest('base64url')
  return `${name}=v1.${body}.${signature}`
}

interface ResponseState {
  status?: number
  headers?: Readonly<Record<string, string>>
  body?: string
}

function response(): { value: ConnectionIndexResponse; state: ResponseState } {
  const state: ResponseState = {}
  return {
    value: {
      writeHead(status, headers) {
        state.status = status
        if (headers !== undefined) state.headers = headers
      },
      end(body) {
        if (body !== undefined) state.body = body
      },
    },
    state,
  }
}

function credentials(store: RecordCredentials): CredentialProvider {
  return store as unknown as CredentialProvider
}

function createAuth(
  store: RecordCredentials,
  maxAgeDays = 30,
  processOwner: object = {},
  passwordLogin?: PasswordLoginConfig,
): Promise<BrowserAuth> {
  return BrowserAuth.create(processOwner, credentials(store), maxAgeDays, passwordLogin)
}

function request(url: string, authority = '127.0.0.1:3080', init?: {
  cookie?: string
  method?: string
}): ConnectionIndexRequest {
  return {
    method: init?.method ?? 'GET',
    url,
    headers: {
      host: authority,
      ...init?.cookie === undefined ? {} : { cookie: init.cookie },
    },
  }
}

function exchange(
  auth: BrowserAuth,
  authority = '127.0.0.1:3080',
): { cookie: string; launchUrl: string; state: ResponseState } {
  const launchUrl = auth.authenticatedUrl(`http://${authority}`)
  const target = new URL(launchUrl)
  const res = response()
  expect(auth.authorizeIndex(request(`${target.pathname}${target.search}`, authority), res.value)).toBe(false)
  const setCookie = res.state.headers?.['set-cookie']
  if (setCookie === undefined) throw new Error('token exchange did not set a cookie')
  return { cookie: setCookie.split(';', 1)[0]!, launchUrl, state: res.state }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('BrowserAuth', () => {
  it('uses a clean root URL when password login is enabled', async () => {
    const auth = await createAuth(new RecordCredentials(), 30, {}, PASSWORD_LOGIN)

    expect(auth.authenticatedUrl('https://harness.example/nested?x=1#fragment'))
      .toBe('https://harness.example/')
  })

  it('checks the configured account and mints a secure authority-bound seven-day session', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-05T00:00:00.000Z'))
    const auth = await createAuth(new RecordCredentials(), 30, {}, PASSWORD_LOGIN)

    expect(auth.verifyPasswordLogin('operator', 'correct horse battery staple')).toBe(true)
    expect(auth.verifyPasswordLogin('operator', 'wrong')).toBe(false)
    expect(auth.verifyPasswordLogin('wrong', 'correct horse battery staple')).toBe(false)
    const setCookie = auth.mintPasswordSession(request('/', 'harness.example'))
    if (setCookie === undefined) throw new Error('password login did not mint a session')
    const cookie = setCookie.split(';', 1)[0]!

    expect(setCookie)
      .toMatch(/; Max-Age=604800; Path=\/; Expires=.*; HttpOnly; Secure; SameSite=Strict$/u)
    expect(auth.isAuthenticated(request('/', 'harness.example', { cookie }))).toBe(true)
    expect(auth.isAuthenticated(request('/', 'other.example', { cookie }))).toBe(false)
    expect(auth.expirePasswordSession(request('/', 'harness.example')))
      .toMatch(/; Max-Age=0; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict$/u)
  })

  it('rejects tampered, expired, and not-yet-issued password sessions', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-05T00:00:00.000Z'))
    const auth = await createAuth(new RecordCredentials(), 30, {}, PASSWORD_LOGIN)
    const setCookie = auth.mintPasswordSession(request('/', 'harness.example'))
    if (setCookie === undefined) throw new Error('password login did not mint a session')
    const [name, value] = setCookie.split(';', 1)[0]!.split('=') as [string, string]
    const tamperedValue = `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`

    expect(auth.isAuthenticated(request('/', 'harness.example', { cookie: `${name}=broken` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', 'harness.example', { cookie: `${name}=${tamperedValue}` }))).toBe(false)
    vi.setSystemTime(new Date('2026-09-12T00:00:00.000Z'))
    expect(auth.isAuthenticated(request('/', 'harness.example', { cookie: `${name}=${value}` }))).toBe(false)
    vi.setSystemTime(new Date('2026-09-04T23:59:59.999Z'))
    expect(auth.isAuthenticated(request('/', 'harness.example', { cookie: `${name}=${value}` }))).toBe(false)
  })

  it('keeps independently minted password sessions valid together', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-05T00:00:00.000Z'))
    const auth = await createAuth(new RecordCredentials(), 30, {}, PASSWORD_LOGIN)
    const first = auth.mintPasswordSession(request('/', 'harness.example'))
    const second = auth.mintPasswordSession(request('/', 'harness.example'))
    if (first === undefined || second === undefined) throw new Error('password login did not mint sessions')
    const firstCookie = first.split(';', 1)[0]!
    const secondCookie = second.split(';', 1)[0]!

    expect(firstCookie).not.toBe(secondCookie)
    expect(auth.isAuthenticated(request('/', 'harness.example', { cookie: firstCookie }))).toBe(true)
    expect(auth.isAuthenticated(request('/', 'harness.example', { cookie: secondCookie }))).toBe(true)
  })

  it('preserves password sessions across a restart until credentials change', async () => {
    const store = new RecordCredentials()
    const passwordLogin = PASSWORD_LOGIN
    const active = await createAuth(store, 30, {}, passwordLogin)
    const first = active.mintPasswordSession(request('/', 'harness.example'))
    const second = active.mintPasswordSession(request('/', 'harness.example'))
    if (first === undefined || second === undefined) throw new Error('password login did not mint sessions')
    const cookies = [first, second].map(value => value.split(';', 1)[0]!)

    const restarted = await createAuth(store, 30, {}, passwordLogin)
    for (const cookie of cookies) {
      expect(restarted.isAuthenticated(request('/', 'harness.example', { cookie }))).toBe(true)
    }

    for (const changedCredentials of [
      { ...passwordLogin, username: 'different-operator' },
      { ...passwordLogin, password: 'different-password' },
    ]) {
      const rotated = await createAuth(store, 30, {}, changedCredentials)
      for (const cookie of cookies) {
        expect(rotated.isAuthenticated(request('/', 'harness.example', { cookie }))).toBe(false)
      }
    }
  })

  it('does not accept a launch-token session while password login is enabled', async () => {
    const store = new RecordCredentials()
    const tokenAuth = await createAuth(store)
    const tokenCookie = exchange(tokenAuth, 'harness.example').cookie
    const passwordAuth = await createAuth(store, 30, {}, PASSWORD_LOGIN)

    expect(passwordAuth.isAuthenticated(request('/', 'harness.example', { cookie: tokenCookie }))).toBe(false)
  })

  it('redirects unauthenticated password-mode GET index URLs to the credential-free login route', async () => {
    const auth = await createAuth(new RecordCredentials(), 30, {}, PASSWORD_LOGIN)

    for (const url of [
      '/?token=stale&source=old-bookmark',
      '/index.html?token=stale&source=old-bookmark',
    ]) {
      const redirected = response()
      expect(auth.authorizeIndex(request(url), redirected.value)).toBe(false)
      expect(redirected.state).toEqual({
        status: 303,
        headers: {
          'cache-control': 'no-store',
          location: '/auth/login',
          'referrer-policy': 'no-referrer',
        },
      })
    }

    const session = auth.mintPasswordSession(request('/', '127.0.0.1:3080'))
    if (session === undefined) throw new Error('password login did not mint a session')
    const allowed = response()
    expect(auth.authorizeIndex(request('/index.html', '127.0.0.1:3080', {
      cookie: session.split(';', 1)[0]!,
    }), allowed.value)).toBe(true)
    expect(allowed.state).toEqual({})

    for (const candidate of [
      request('/', '127.0.0.1:3080', { method: 'HEAD' }),
      request('/asset.js'),
    ]) {
      const denied = response()
      expect(auth.authorizeIndex(candidate, denied.value)).toBe(false)
      expect(denied.state).toEqual({
        status: 401,
        headers: {
          'cache-control': 'no-store',
          'content-type': 'text/plain; charset=utf-8',
        },
        ...candidate.method === 'HEAD' ? {} : {
          body: 'dsh web authentication required; reopen the URL printed by dsh web.\n',
        },
      })
    }
  })

  it('mints one process token and a persistent authority-bound cookie', async () => {
    const store = new RecordCredentials()
    const processOwner = {}
    const first = await createAuth(store, 30, processOwner)
    const login = exchange(first)

    expect(login.state).toMatchObject({
      status: 303,
      headers: {
        'cache-control': 'no-store',
        'location': '/',
        'referrer-policy': 'no-referrer',
      },
    })
    expect(login.state.headers?.['set-cookie']).toMatch(/; Max-Age=2592000; Path=\/; Expires=.*; HttpOnly; SameSite=Strict$/u)
    expect(login.state.headers?.['set-cookie']).not.toContain('Secure')
    expect(first.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)
    expect(first.isAuthenticated({
      headers: new Headers({ host: '127.0.0.1:3080', cookie: login.cookie }),
    })).toBe(true)
    expect(first.isAuthenticated({ headers: new Headers() })).toBe(false)
    expect(first.isAuthenticated(request('/', 'localhost:3080', { cookie: login.cookie }))).toBe(false)
    expect(first.isAuthenticated(request('/', '127.0.0.1:3081', { cookie: login.cookie }))).toBe(false)

    const reloaded = await createAuth(store, 30, processOwner)
    expect(reloaded.authenticatedUrl('http://127.0.0.1:3080')).toBe(login.launchUrl)
    expect(reloaded.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)

    const restarted = await createAuth(store)
    expect(new URL(restarted.authenticatedUrl('http://127.0.0.1:3080')).searchParams.get('token'))
      .not.toBe(new URL(login.launchUrl).searchParams.get('token'))
    expect(restarted.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)
    const staleUrl = new URL(login.launchUrl)
    const redirected = response()
    expect(restarted.authorizeIndex(request(
      `${staleUrl.pathname}${staleUrl.search}`,
      '127.0.0.1:3080',
      { cookie: login.cookie },
    ), redirected.value)).toBe(false)
    expect(redirected.state).toEqual({
      status: 303,
      headers: {
        'cache-control': 'no-store',
        'location': '/',
        'referrer-policy': 'no-referrer',
      },
    })
  })

  it('accepts the cookie for index serving and gives every unauthenticated request one response', async () => {
    const auth = await createAuth(new RecordCredentials())
    const { cookie } = exchange(auth)
    const allowed = response()
    expect(auth.authorizeIndex(request('/index.html', '127.0.0.1:3080', { cookie }), allowed.value)).toBe(true)
    expect(allowed.state).toEqual({})

    for (const candidate of [
      request('/'),
      request('/?token=wrong'),
      request('/?token=wrong&token=again'),
      request('/index.html?token=wrong'),
      request(auth.authenticatedUrl('http://127.0.0.1:3080'), '127.0.0.1:3080', { method: 'HEAD' }),
    ]) {
      const denied = response()
      expect(auth.authorizeIndex(candidate, denied.value)).toBe(false)
      expect(denied.state.status).toBe(401)
      expect(denied.state.headers).toEqual({
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      })
      expect(denied.state.body).toBe(candidate.method === 'HEAD'
        ? undefined
        : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
    }
  })

  it('rejects tampering, expiry, future issuance, and a longer lifetime than configured', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const { cookie } = exchange(auth)
    const [name, value] = cookie.split('=') as [string, string]

    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=broken` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=${value.slice(0, -1)}x` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=%` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
      cookie: signedBodyCookie(store, name, 'a'),
    }))).toBe(false)
    expect(auth.isAuthenticated({ headers: {} })).toBe(false)
    expect(auth.isAuthenticated({ headers: { host: 'bad host', cookie } })).toBe(false)
    expect(auth.isAuthenticated({ headers: { host: '127.0.0.1:3080' } })).toBe(false)

    const invalidPayloads: unknown[] = [
      'not json',
      null,
      { version: 2, authority: '127.0.0.1:3080', issuedAt: Date.now(), expiresAt: Date.now() + 1000 },
      { version: 1, authority: 42, issuedAt: Date.now(), expiresAt: Date.now() + 1000 },
      { version: 1, authority: '127.0.0.1:3080', issuedAt: 'now', expiresAt: Date.now() + 1000 },
      { version: 1, authority: '127.0.0.1:3080', issuedAt: Date.now(), expiresAt: 'later' },
    ]
    for (const payload of invalidPayloads) {
      expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
        cookie: signedCookie(store, name, payload),
      }))).toBe(false)
    }

    const shorter = await createAuth(store, 1)
    expect(shorter.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
    vi.setSystemTime(new Date('2026-09-24T00:00:00.000Z'))
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
    vi.setSystemTime(new Date('2026-08-23T00:00:00.000Z'))
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
  })

  it('loads one secret per activation and replaces it after deletion on the next activation', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const first = exchange(auth)
    expect(store).toMatchObject({ reads: 0, modifies: 1 })

    await store.deleteRecord()
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: first.cookie }))).toBe(true)
    const sameActivation = exchange(auth)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: sameActivation.cookie }))).toBe(true)
    expect(store).toMatchObject({ reads: 0, modifies: 1 })

    const reactivated = await createAuth(store)
    const second = exchange(reactivated)
    expect(second.cookie).not.toBe(first.cookie)
    expect(reactivated.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: first.cookie }))).toBe(false)
    expect(reactivated.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: second.cookie }))).toBe(true)
    expect(store).toMatchObject({ reads: 0, modifies: 2 })
  })

  it('fails loud on an invalid owner record instead of replacing it', async () => {
    const unsupported = new RecordCredentials()
    unsupported.record = { kind: 'api-key', key: 'not-a-cookie-secret' }
    await expect(createAuth(unsupported)).rejects.toThrow(/unsupported format/u)

    const malformed = new RecordCredentials()
    malformed.record = { kind: 'grant', payload: { version: 1, secret: 'short' } }
    await expect(createAuth(malformed)).rejects.toThrow(/invalid secret/u)

    const nonString = new RecordCredentials()
    nonString.record = { kind: 'grant', payload: { version: 1, secret: 42 } }
    await expect(createAuth(nonString)).rejects.toThrow(/invalid secret/u)

    const discarded = new RecordCredentials()
    discarded.discardWrites = true
    await expect(createAuth(discarded)).rejects.toThrow(/was not created/u)

    await expect(createAuth(new RecordCredentials(), Number.MAX_SAFE_INTEGER))
      .rejects.toThrow(/safe timestamp range/u)
  })
})
