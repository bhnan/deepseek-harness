/** Package-private HTTP authentication mechanics used by the raw listener adapter. */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Login and session settings consumed by {@link AuthGate}. */
export interface AuthSettings {
  /** Login name accepted by the form and JSON endpoint. */
  username: string
  /** Login password accepted by the form and JSON endpoint. */
  password: string
  /** HMAC key for the session cookie; omit only to rotate sessions on every process start. */
  sessionSecret?: string
  /** Session lifetime in seconds. Defaults to one day. */
  sessionMaxAge?: number
  /** Login-page title. Defaults to DeepSeek Harness. */
  realm?: string
}

/** One raw Node HTTP request listener. */
export type RequestListener = (request: IncomingMessage, response: ServerResponse) => void

/** One in-memory authenticated session. */
interface Session {
  createdAt: number
}

/** Compute an HMAC-SHA256 signature as raw bytes. */
async function signBytes(value: string, secret: string): Promise<Buffer> {
  const key = new TextEncoder().encode(secret)
  const data = new TextEncoder().encode(value)
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const signature = await globalThis.crypto.subtle.sign('HMAC', cryptoKey, data)
  return Buffer.from(new Uint8Array(signature))
}

/** Encode one opaque session id and its HMAC signature into a cookie value.
 * @param sessionId - Opaque process-local session id.
 * @param secret - HMAC key used to sign the session id.
 * @returns Encoded cookie value.
 */
export async function encodeSessionCookie(sessionId: string, secret: string): Promise<string> {
  const signature = await signBytes(sessionId, secret)
  return [
    Buffer.from(sessionId).toString('base64url'),
    signature.toString('base64url'),
  ].join('.')
}

/** Decode and verify a signed cookie, returning its session id when valid.
 * @param cookieValue - Encoded cookie value.
 * @param secret - HMAC key used to verify the signature.
 * @returns The session id, or null when the cookie is invalid.
 */
export async function decodeSessionCookie(cookieValue: string, secret: string): Promise<string | null> {
  const parts = cookieValue.split('.')
  if (parts.length !== 2) return null
  const [encodedId, encodedSignature] = parts as [string, string]
  const sessionId = Buffer.from(encodedId, 'base64url').toString('utf8')
  const expected = await signBytes(sessionId, secret)
  const actual = Buffer.from(encodedSignature, 'base64url')
  if (actual.length !== expected.length) return null
  if (!timingSafeEqual(actual, expected)) return null
  return sessionId
}

/** Parse the request cookie header into its unescaped name/value pairs.
 * @param request - Incoming HTTP request carrying the cookie header.
 * @returns Parsed cookie name/value pairs.
 */
export function parseCookies(request: IncomingMessage): Record<string, string> {
  const header = request.headers.cookie
  if (header === undefined) return {}
  const cookies: Record<string, string> = {}
  for (const part of header.split(';')) {
    const equals = part.indexOf('=')
    if (equals === -1) continue
    cookies[part.slice(0, equals).trim()] = part.slice(equals + 1).trim()
  }
  return cookies
}

/** Whether a pathname reaches the Web API carrier.
 * @param pathname - URL pathname to classify.
 * @returns Whether the pathname is under `/api/`.
 */
export function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/')
}

/** Whether a pathname is answered before session authentication.
 * @param pathname - URL pathname to classify.
 * @returns Whether the pathname is an authentication-owned route.
 */
export function isAuthPath(pathname: string): boolean {
  return pathname === '/login'
    || pathname === '/login.html'
    || pathname === '/auth/login'
    || pathname === '/auth/login.html'
    || pathname.startsWith('/api/auth/')
    || pathname === '/favicon.ico'
}

/** Whether a pathname is an auxiliary asset of a login view.
 * @param pathname - URL pathname to classify.
 * @returns Whether the pathname is a supported login asset.
 */
export function isStaticAsset(pathname: string): boolean {
  const extension = pathname.slice(pathname.lastIndexOf('.') + 1).toLowerCase()
  return pathname.startsWith('/auth/') && [
    'css', 'js', 'html', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'woff', 'woff2', 'ttf', 'eot',
  ].includes(extension)
}

/** Escape text interpolated into the self-contained login document. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Render the server deployment's self-contained Chinese login page.
 * @param realm - Page title and heading.
 * @param error - Optional escaped error message.
 * @returns Complete login HTML document.
 */
export function renderLoginPage(realm: string, error?: string): string {
  const errorBlock = error === undefined ? '' : `<div class="error">${escapeHtml(error)}</div>`
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(realm)} — 登录</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans SC",sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh;color:#1a1a1a}
.login-card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);padding:40px;width:100%;max-width:400px}
h1{font-size:22px;font-weight:600;margin-bottom:8px;text-align:center}
.subtitle{color:#666;font-size:14px;text-align:center;margin-bottom:32px}
label{display:block;font-size:14px;font-weight:500;margin-bottom:6px;color:#333}
input[type="text"],input[type="password"]{width:100%;padding:10px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;outline:none;transition:border-color .15s}
input:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.15)}
.field{margin-bottom:20px}
button{width:100%;padding:12px;background:#1a73e8;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:500;cursor:pointer;transition:background .15s}
button:hover{background:#1557b0}
button:disabled{opacity:.6;cursor:not-allowed}
.error{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:14px}
</style>
</head>
<body>
<div class="login-card">
<h1>${escapeHtml(realm)}</h1>
<p class="subtitle">请输入用户名和密码以继续</p>
${errorBlock}
<form method="POST" action="/api/auth/login" onsubmit="submitLogin(event)">
<div class="field"><label for="username">用户名</label><input type="text" id="username" name="username" required autocomplete="username" autofocus></div>
<div class="field"><label for="password">密码</label><input type="password" id="password" name="password" required autocomplete="current-password"></div>
<button type="submit" id="login-btn">登录</button>
</form>
</div>
<script>
async function submitLogin(e){e.preventDefault();const btn=document.getElementById('login-btn');btn.disabled=true;btn.textContent='登录中...';try{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('username').value,password:document.getElementById('password').value})});if(r.ok){window.location.href='/'}else{const e=await r.json();showError(e.error||'登录失败')}}catch(e){showError('网络错误，请重试')}finally{btn.disabled=false;btn.textContent='登录'}}
function showError(msg){const c=document.querySelector('.login-card'),e=c.querySelector('.error');if(e)e.remove();const d=document.createElement('div');d.className='error';d.textContent=msg;c.insertBefore(d,c.querySelector('form'))}
</script>
</body>
</html>`
}

/** Send one JSON error response.
 * @param response - HTTP response to complete.
 * @param statusCode - HTTP status code.
 * @param message - JSON error message.
 */
export function jsonError(response: ServerResponse, statusCode: number, message: string): void {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ error: message }))
}

/** Set the authenticated session cookie.
 * @param response - HTTP response receiving the cookie.
 * @param sessionId - Opaque process-local session id.
 * @param secret - HMAC key used to sign the cookie.
 * @param maxAge - Cookie lifetime in seconds.
 */
export async function setSessionCookie(
  response: ServerResponse, sessionId: string, secret: string, maxAge: number,
): Promise<void> {
  const encoded = await encodeSessionCookie(sessionId, secret)
  response.setHeader('set-cookie', [
    `dsh_session=${encoded}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(maxAge)}`,
  ])
}

/** Expire the authenticated session cookie.
 * @param response - HTTP response receiving the expired cookie.
 */
export function clearSessionCookie(response: ServerResponse): void {
  response.setHeader('set-cookie', [
    'dsh_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
  ])
}

/** Invoke each pre-existing Node request listener in its original order.
 * @param listeners - Listeners captured before the wrapper was installed.
 * @param request - Incoming HTTP request.
 * @param response - HTTP response.
 */
export function forwardToOriginal(listeners: readonly RequestListener[], request: IncomingMessage, response: ServerResponse): void {
  for (const listener of listeners) listener(request, response)
}

/** Keep authenticated session ids only for the lifetime of one DSH process. */
class SessionStore {
  readonly #sessions = new Map<string, Session>()

  /** Create and retain a fresh opaque session id. */
  create(): string {
    const id = randomUUID()
    this.#sessions.set(id, { createdAt: Date.now() })
    return id
  }

  /** Find one session, or null when it was never issued or was removed. */
  get(id: string): Session | null {
    return this.#sessions.get(id) ?? null
  }

  /** Remove one session id. */
  delete(id: string): void {
    this.#sessions.delete(id)
  }

  /** Remove every session past the configured lifetime. */
  cleanup(maxAge: number): void {
    const cutoff = Date.now() - maxAge * 1000
    for (const [id, session] of this.#sessions) {
      if (session.createdAt < cutoff) this.#sessions.delete(id)
    }
  }
}

/** Process-local authentication state and HTTP handlers for one plugin instance. */
export class AuthGate {
  readonly #sessions = new SessionStore()
  readonly #secret: string
  readonly #maxAge: number
  readonly #realm: string
  readonly #username: string
  readonly #password: string

  /** Initialize one independent shared-login authentication state. */
  constructor(config: AuthSettings) {
    this.#secret = config.sessionSecret ?? randomUUID()
    this.#maxAge = config.sessionMaxAge ?? 86_400
    this.#realm = config.realm ?? 'DeepSeek Harness'
    this.#username = config.username
    this.#password = config.password
  }

  /** Render the authentication document with the configured realm.
   * @returns Complete login HTML document.
   */
  loginPage(): string {
    return renderLoginPage(this.#realm)
  }

  /** Reject a protected API or non-navigation request without a valid session.
   * @param response - HTTP response to complete.
   */
  reject(response: ServerResponse): void {
    jsonError(response, 401, 'Authentication required. Please log in.')
  }

  /** Accept a JSON login body and issue one signed process-local session.
   * @param request - Incoming login request.
   * @param response - HTTP response to complete.
   */
  async handleLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body = ''
    try {
      for await (const chunk of request) body += String(chunk)
    } catch {
      jsonError(response, 400, 'Invalid request body')
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      jsonError(response, 400, 'Invalid JSON body')
      return
    }

    const { username, password } = (parsed ?? {}) as { username?: unknown; password?: unknown }
    if (typeof username !== 'string' || username.length === 0 || typeof password !== 'string' || password.length === 0) {
      jsonError(response, 400, 'Username and password are required')
      return
    }

    const user = Buffer.from(username)
    const passwordValue = Buffer.from(password)
    const expectedUser = Buffer.from(this.#username)
    const expectedPassword = Buffer.from(this.#password)
    const userMatches = user.length === expectedUser.length && timingSafeEqual(user, expectedUser)
    const passwordMatches = passwordValue.length === expectedPassword.length
      && timingSafeEqual(passwordValue, expectedPassword)
    if (!userMatches || !passwordMatches) {
      jsonError(response, 401, '用户名或密码错误')
      return
    }

    const sessionId = this.#sessions.create()
    await setSessionCookie(response, sessionId, this.#secret, this.#maxAge)
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: true }))
  }

  /** Remove the current signed session, if the request carries one.
   * @param request - Incoming logout request.
   * @param response - HTTP response to complete.
   */
  async handleLogout(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const sessionCookie = parseCookies(request).dsh_session
    if (sessionCookie !== undefined) {
      const sessionId = await decodeSessionCookie(sessionCookie, this.#secret)
      if (sessionId !== null) this.#sessions.delete(sessionId)
    }
    clearSessionCookie(response)
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: true }))
  }

  /** Whether a request carries a signed session that this process issued.
   * @param request - Incoming HTTP request.
   * @returns Whether the request's cookie identifies a live session.
   */
  async isAuthenticated(request: IncomingMessage): Promise<boolean> {
    const sessionCookie = parseCookies(request).dsh_session
    if (sessionCookie === undefined) return false
    const sessionId = await decodeSessionCookie(sessionCookie, this.#secret)
    return sessionId !== null && this.#sessions.get(sessionId) !== null
  }

  /** Remove sessions that have passed the configured lifetime. */
  cleanup(): void {
    this.#sessions.cleanup(this.#maxAge)
  }
}
