/**
 * Experimental basic HTTP authentication over the raw Node listener held by
 * dsh-host-webserver. This preserves the server deployment's one-user login
 * and in-memory HMAC session behavior while keeping listener ownership scoped
 * to the Cordis plugin fiber.
 *
 * @module @deepseek-ai/dsh-experimental-auth-basic
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  AuthGate,
  forwardToOriginal,
  isApiPath,
  isAuthPath,
  isStaticAsset,
  type AuthSettings,
  type RequestListener,
} from './auth.ts'

/** Stable Cordis plugin name. */
export const name = 'auth-basic'

/** Service required before raw listener interception can start. */
export const inject = ['webServer']

/** Basic Web authentication configuration. */
export interface Config extends AuthSettings {}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  username: z.string().min(1).required(),
  password: z.string().min(1).required(),
  sessionSecret: z.string(),
  sessionMaxAge: z.number().min(60).default(86_400),
  realm: z.string().default('DeepSeek Harness'),
})

/** The private Node server slot the current WebServer implementation owns. */
interface RawWebServer {
  server?: Server
}

/** One raw Node HTTP upgrade listener. */
type UpgradeListener = (request: IncomingMessage, socket: Socket, head: Buffer) => void

/**
 * Wrap the current Web server's raw request and upgrade listeners.
 * @param ctx - Cordis context carrying the Web server.
 * @param config - validated login and session settings.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => {
    const auth = new AuthGate(config)
    let retryTimer: NodeJS.Timeout | undefined
    let savedRequestListeners: RequestListener[] = []
    let savedUpgradeListeners: UpgradeListener[] = []
    let restore: (() => void) | undefined

    const trySetupInterceptor = (): boolean => {
      const candidate = (ctx.webServer as unknown as RawWebServer).server
      if (candidate === undefined) return false
      const requests = candidate.rawListeners('request')
      if (requests.length === 0) return false

      savedRequestListeners = requests as RequestListener[]
      savedUpgradeListeners = candidate.rawListeners('upgrade') as UpgradeListener[]
      candidate.removeAllListeners('request')
      candidate.removeAllListeners('upgrade')

      const requestInterceptor = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        try {
          const pathname = new URL(request.url ?? '/', 'http://x').pathname
          if (isAuthPath(pathname) || isStaticAsset(pathname)) {
            if (pathname === '/api/auth/login' && request.method === 'POST') {
              await auth.handleLogin(request, response)
              return
            }
            if (pathname === '/api/auth/logout' && request.method === 'POST') {
              await auth.handleLogout(request, response)
              return
            }
            if ((pathname === '/login' || pathname === '/login.html') && request.method === 'GET') {
              response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
              response.end(auth.loginPage())
              return
            }
            if (pathname.startsWith('/auth/') && pathname.endsWith('.html') && request.method === 'GET') {
              response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
              response.end(auth.loginPage())
              return
            }
            forwardToOriginal(savedRequestListeners, request, response)
            return
          }

          if (await auth.isAuthenticated(request)) {
            forwardToOriginal(savedRequestListeners, request, response)
            return
          }

          if (isApiPath(pathname)) {
            auth.reject(response)
            return
          }
          if (request.method === 'GET' || request.method === 'HEAD') {
            response.writeHead(302, { location: '/login' })
            response.end()
            return
          }
          auth.reject(response)
        } catch (error) {
          ctx.logger.warn('[dsh-auth-basic] interceptor error:', error)
          forwardToOriginal(savedRequestListeners, request, response)
        }
      }
      const requestListener: RequestListener = (request, response) => { void requestInterceptor(request, response) }
      candidate.on('request', requestListener)

      let upgradeListener: UpgradeListener | undefined
      if (savedUpgradeListeners.length > 0) {
        const upgradeInterceptor = async (request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> => {
          try {
            if (await auth.isAuthenticated(request)) {
              for (const listener of savedUpgradeListeners) listener(request, socket, head)
              return
            }
            socket.destroy()
          } catch {
            socket.destroy()
          }
        }
        upgradeListener = (request, socket, head) => { void upgradeInterceptor(request, socket, head) }
        candidate.on('upgrade', upgradeListener)
      }

      restore = () => {
        candidate.removeListener('request', requestListener)
        if (upgradeListener !== undefined) candidate.removeListener('upgrade', upgradeListener)
        for (const listener of savedRequestListeners) candidate.on('request', listener)
        for (const listener of savedUpgradeListeners) candidate.on('upgrade', listener)
      }

      ctx.logger.info(
        '[dsh-auth-basic] auth interceptor installed, '
        + `${String(savedRequestListeners.length)} request listener(s) wrapped`,
      )
      return true
    }

    const retry = (delay: number): void => {
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        if (trySetupInterceptor()) return
        if (delay < 5000) retry(delay * 2)
      }, delay)
    }

    const cleanupTimer = setInterval(() => { auth.cleanup() }, 5 * 60 * 1000)
    if (!trySetupInterceptor()) retry(200)

    return () => {
      clearInterval(cleanupTimer)
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      if (restore === undefined) return
      restore()
    }
  }, 'experimental-auth-basic: raw listener wrapper')
}
