/**
 * REAL-composition coverage: a Loader starts the Web server, the experimental
 * auth wrapper, and the static frontend in their deployment order. Assertions
 * observe the public HTTP surface and listener restoration after disposal.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as AuthBasic from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Start the production plugin sequence around a temporary static shell. */
async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-auth-basic-'))
  const dist = join(root, 'dist')
  await mkdir(dist)
  const distIndex = join(dist, 'index.html')
  await writeFile(distIndex, '<head></head><body>authenticated shell</body>')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: webserver',
    "  name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '- id: auth-basic',
    "  name: '@deepseek-ai/dsh-experimental-auth-basic'",
    '  inject:',
    '    - webServer',
    '  config:',
    '    username: fixture-user',
    '    password: fixture-password',
    '    sessionSecret: fixture-session-secret',
    '    sessionMaxAge: 3600',
    '    realm: Fixture Harness',
    '- id: frontend-static',
    "  name: '@deepseek-ai/dsh-host-frontend-static'",
    '  inject:',
    '    - webServer',
    '  config:',
    `    distIndex: '${distIndex}'`,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-experimental-auth-basic', AuthBasic],
    ['@deepseek-ai/dsh-host-frontend-static', FrontendStatic],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** Fetch one route without automatically following a login redirect. */
async function request(port: number, path: string, init: RequestInit = {}): Promise<{
  status: number
  location: string | null
  setCookie: string | null
  body: string
}> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    redirect: 'manual',
    ...init,
  })
  return {
    status: response.status,
    location: response.headers.get('location'),
    setCookie: response.headers.get('set-cookie'),
    body: await response.text(),
  }
}

/** Extract the one session cookie that requests must replay. */
function sessionCookie(response: { setCookie: string | null }): string {
  const cookie = response.setCookie?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('login response did not set a session cookie')
  return cookie
}

describe('experimental basic authentication', () => {
  it('gates the real Web composition and restores the listener when disposed', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    const port = loaded.webServer.port

    expect(await request(port, '/api/probe')).toEqual({
      status: 401,
      location: null,
      setCookie: null,
      body: JSON.stringify({ error: 'Authentication required. Please log in.' }),
    })
    expect(await request(port, '/')).toMatchObject({ status: 302, location: '/login' })

    const loginPage = await request(port, '/login')
    expect(loginPage.status).toBe(200)
    expect(loginPage.body).toMatchSnapshot()

    expect(await request(port, '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: {}, password: [] }),
    })).toEqual({
      status: 400,
      location: null,
      setCookie: null,
      body: JSON.stringify({ error: 'Username and password are required' }),
    })

    expect(await request(port, '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'fixture-user', password: 'wrong-password' }),
    })).toEqual({
      status: 401,
      location: null,
      setCookie: null,
      body: JSON.stringify({ error: '用户名或密码错误' }),
    })

    const login = await request(port, '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'fixture-user', password: 'fixture-password' }),
    })
    expect(login.status).toBe(200)
    expect(login.body).toBe(JSON.stringify({ ok: true }))
    const cookie = sessionCookie(login)
    const authenticatedShell = await request(port, '/', { headers: { cookie } })
    expect(authenticatedShell.status).toBe(200)
    expect(authenticatedShell.body).toContain('authenticated shell')

    const logout = await request(port, '/api/auth/logout', { method: 'POST', headers: { cookie } })
    expect(logout).toMatchObject({ status: 200, body: JSON.stringify({ ok: true }) })
    expect(logout.setCookie).toContain('Max-Age=0')
    expect(await request(port, '/', { headers: { cookie } })).toMatchObject({ status: 302, location: '/login' })

    const authEntry = [...loaded.loader.entries()].find(entry => entry.options.id === 'auth-basic')
    expect(authEntry).toBeDefined()
    await authEntry!.fiber?.dispose()
    const restoredShell = await request(port, '/')
    expect(restoredShell.status).toBe(200)
    expect(restoredShell.body).toContain('authenticated shell')
  })
})
