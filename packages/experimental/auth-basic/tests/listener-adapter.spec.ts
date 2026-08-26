/** Raw-listener adapter coverage keeps the experimental integration outside dsh-host-webserver. */

import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'
import { setImmediate as waitImmediate } from 'node:timers/promises'
import type { Duplex } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

interface MountedAdapter {
  readonly logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }
  dispose(): void
}

/** Mount the function plugin against only the Context members the adapter reads. */
function mountAdapter(webServer: { server?: Server }): MountedAdapter {
  let disposer: (() => void) | undefined
  const logger = { info: vi.fn(), warn: vi.fn() }
  const context = {
    webServer,
    logger,
    effect(callback: () => (() => void) | undefined) {
      const cleanup = callback()
      if (typeof cleanup === 'function') disposer = cleanup
    },
  } as unknown as Context
  apply(context, {
    username: 'fixture-user',
    password: 'fixture-password',
    sessionSecret: 'fixture-session-secret',
    sessionMaxAge: 60,
    realm: 'Fixture Harness',
  })
  return {
    logger,
    dispose() {
      if (disposer === undefined) throw new Error('auth adapter did not register a disposer')
      disposer()
    },
  }
}

/** Listen on a loopback ephemeral port. */
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind a TCP port')
  return address.port
}

/** Close a server that may not have entered listen state. */
async function close(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}

/** Fetch without following the login redirect. */
function request(port: number, pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch('http://127.0.0.1:' + String(port) + pathname, {
    redirect: 'manual',
    ...init,
  })
}

/** Send one raw HTTP upgrade and wait for the original listener's handshake. */
async function acceptedUpgrade(port: number, pathname: string, cookie: string): Promise<Socket> {
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  const received = once(socket, 'data')
  socket.write([
    'GET ' + pathname + ' HTTP/1.1',
    'Host: 127.0.0.1:' + String(port),
    'Cookie: ' + cookie,
    'Connection: Upgrade',
    'Upgrade: dsh-test',
    '',
    '',
  ].join('\r\n'))
  const [data] = await received as [Buffer]
  expect(String(data)).toContain('101 Switching Protocols')
  return socket
}

/** Send one raw HTTP upgrade and observe the auth adapter destroy the socket. */
async function rejectedUpgrade(port: number, pathname: string): Promise<void> {
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  const closed = once(socket, 'close')
  socket.write([
    'GET ' + pathname + ' HTTP/1.1',
    'Host: 127.0.0.1:' + String(port),
    'Connection: Upgrade',
    'Upgrade: dsh-test',
    '',
    '',
  ].join('\r\n'))
  await closed
}

describe('raw listener adapter', () => {
  it('preserves original request and upgrade ownership behind the authentication gate', { timeout: 60_000 }, async () => {
    const server = createServer()
    const sockets = new Set<Socket>()
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => { sockets.delete(socket) })
    })
    const forwarded: string[] = []
    const originalRequest = (_request: IncomingMessage, response: ServerResponse): void => {
      forwarded.push('request')
      response.writeHead(204)
      response.end()
    }
    const originalUpgrade = (_request: IncomingMessage, socket: Duplex): void => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
    }
    server.on('request', originalRequest)
    server.on('upgrade', originalUpgrade)
    const mounted = mountAdapter({ server })
    const port = await listen(server)
    try {
      expect((await request(port, '/api/auth/login')).status).toBe(204)
      expect((await request(port, '/api/auth/logout')).status).toBe(204)
      expect((await request(port, '/login', { method: 'POST' })).status).toBe(204)
      expect((await request(port, '/login.html')).status).toBe(200)
      expect((await request(port, '/auth/page.html')).status).toBe(200)
      expect((await request(port, '/auth/page.css')).status).toBe(204)
      expect((await request(port, '/auth/page.html', { method: 'POST' })).status).toBe(204)
      expect((await request(port, '/favicon.ico')).status).toBe(204)
      expect((await request(port, '/api/probe')).status).toBe(401)
      expect((await request(port, '/private')).status).toBe(302)
      expect((await request(port, '/private', { method: 'HEAD' })).status).toBe(302)
      expect((await request(port, '/private', { method: 'POST' })).status).toBe(401)

      const login = await request(port, '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'fixture-user', password: 'fixture-password' }),
      })
      const setCookie = login.headers.get('set-cookie')
      if (setCookie === null) throw new Error('login did not issue a session cookie')
      const cookie = setCookie.split(';', 1)[0]!
      expect((await request(port, '/private', { headers: { cookie } })).status).toBe(204)

      await rejectedUpgrade(port, '/events')
      const upgraded = await acceptedUpgrade(port, '/events', cookie)
      const closed = once(upgraded, 'close')
      upgraded.destroy()
      await closed

      let syntheticStatus: number | undefined
      let syntheticEnded = false
      const syntheticResponse = {
        writeHead(statusCode: number) {
          syntheticStatus = statusCode
        },
        end() {
          syntheticEnded = true
        },
      } as unknown as ServerResponse
      const absentUrlRequest = {
        headers: {},
        method: 'GET',
        url: undefined,
      } as unknown as IncomingMessage
      server.emit('request', absentUrlRequest, syntheticResponse)
      await waitImmediate()
      expect(syntheticStatus).toBe(302)
      expect(syntheticEnded).toBe(true)

      const malformedUrlRequest = {
        headers: {},
        method: 'GET',
        get url(): never {
          throw new Error('fixture malformed request URL')
        },
      } as unknown as IncomingMessage
      server.emit('request', malformedUrlRequest, syntheticResponse)
      await waitImmediate()
      expect(mounted.logger.warn).toHaveBeenCalled()
      expect(forwarded.length).toBeGreaterThan(0)

      const rawUpgradeListener = server.listeners('upgrade')[0]
      if (rawUpgradeListener === undefined) throw new Error('auth adapter did not install an upgrade listener')
      const upgradeListener = rawUpgradeListener as unknown as (request: IncomingMessage, socket: Socket, head: Buffer) => void
      let destroyed = 0
      upgradeListener({
        get headers(): never {
          throw new Error('fixture malformed upgrade headers')
        },
      } as unknown as IncomingMessage, {
        destroy() {
          destroyed += 1
        },
      } as unknown as Socket, Buffer.alloc(0))
      await waitImmediate()
      expect(destroyed).toBe(1)
    } finally {
      mounted.dispose()
      for (const socket of sockets) socket.destroy()
      await close(server)
    }

    expect(server.listeners('request')).toEqual([originalRequest])
    expect(server.listeners('upgrade')).toEqual([originalUpgrade])
  })

  it('retries until the raw server and its request listener are available, then restores a request-only server', async () => {
    vi.useFakeTimers()
    const pendingRetry = mountAdapter({})
    pendingRetry.dispose()
    const noServer = mountAdapter({})
    await vi.advanceTimersByTimeAsync(12_600)
    noServer.dispose()
    expect(noServer.logger.info).not.toHaveBeenCalled()

    const server = createServer()
    const originalRequest = (_request: IncomingMessage, response: ServerResponse): void => {
      response.writeHead(204)
      response.end()
    }
    const delayed = mountAdapter({ server })
    await vi.advanceTimersByTimeAsync(200)
    server.on('request', originalRequest)
    await vi.advanceTimersByTimeAsync(400)
    expect(delayed.logger.info).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    delayed.dispose()
    expect(server.listeners('request')).toEqual([originalRequest])
    expect(server.listeners('upgrade')).toEqual([])
    vi.useRealTimers()
  })
})
