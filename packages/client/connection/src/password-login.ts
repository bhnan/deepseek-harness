/** Resolved deployment configuration for optional browser password login. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { isTrustedApiRequest } from './api-request-trust.ts'
import type { BrowserAuth } from './browser-auth.ts'

const LOGIN_PATH = '/auth/login'
const LOGOUT_PATH = '/auth/logout'
const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded'
const MAX_FORM_BYTES = 8 * 1024
/** Fixed security invariant: an 8 KiB password form has one second to finish reading. */
const FORM_READ_DEADLINE_MS = 1_000

type RequestBodyState = 'unread' | 'consumed'

interface LoginDictionary {
  readonly language: string
  readonly title: string
  readonly heading: string
  readonly username: string
  readonly password: string
  readonly submit: string
  readonly failure: string
}

interface LoginForm {
  readonly username: string
  readonly password: string
}

type ParsedLoginForm =
  | { readonly kind: 'valid'; readonly value: LoginForm; readonly body: 'consumed' }
  | { readonly kind: 'invalid'; readonly status: 400 | 408 | 413; readonly body: RequestBodyState }

const ENGLISH: LoginDictionary = {
  language: 'en',
  title: 'Sign in',
  heading: 'Sign in',
  username: 'Username',
  password: 'Password',
  submit: 'Sign in',
  failure: 'Unable to sign in. Please try again.',
}

const CHINESE: LoginDictionary = {
  language: 'zh-CN',
  title: '登录',
  heading: '登录',
  username: '用户名',
  password: '密码',
  submit: '登录',
  failure: '无法登录，请重试。',
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

function languageDictionary(tag: string): LoginDictionary | undefined {
  if (tag === 'zh' || tag.startsWith('zh-')) return CHINESE
  if (tag === 'en' || tag.startsWith('en-')) return ENGLISH
  return undefined
}

function quality(parameters: readonly string[]): number {
  const parameter = parameters.find(value => value.trim().startsWith('q='))
  if (parameter === undefined) return 1
  const value = Number(parameter.trim().slice(2))
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0
}

function dictionaryFor(request: IncomingMessage): LoginDictionary {
  const accepted = header(request, 'accept-language')
  if (accepted === undefined) return ENGLISH
  let selected: LoginDictionary | undefined
  let selectedQuality = -1
  for (const item of accepted.toLowerCase().split(',')) {
    const [tag = '', ...parameters] = item.trim().split(';')
    const dictionary = languageDictionary(tag.trim())
    const preference = quality(parameters)
    if (dictionary !== undefined && preference > 0 && preference > selectedQuality) {
      selected = dictionary
      selectedQuality = preference
    }
  }
  return selected ?? ENGLISH
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      case "'": return '&#39;'
      default: return character
    }
  })
}

function renderLoginPage(dictionary: LoginDictionary, failed: boolean): string {
  const failure = failed ? `<p role="alert">${escapeHtml(dictionary.failure)}</p>` : ''
  return `<!doctype html><html lang="${escapeHtml(dictionary.language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(dictionary.title)}</title></head><body><main><h1>${escapeHtml(dictionary.heading)}</h1>${failure}<form method="post" action="${escapeHtml(LOGIN_PATH)}"><label for="username">${escapeHtml(dictionary.username)}</label><input id="username" name="username" autocomplete="username" required><label for="password">${escapeHtml(dictionary.password)}</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">${escapeHtml(dictionary.submit)}</button></form></main></body></html>`
}

function responseHeaders(): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'content-type': 'text/html; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  }
}

function writeResponse(
  response: ServerResponse,
  requestBody: RequestBodyState,
  status: number,
  headers: Record<string, string>,
  content?: string,
): void {
  if (requestBody === 'unread') response.shouldKeepAlive = false
  response.writeHead(status, headers)
  response.end(content)
}

function writeForbidden(response: ServerResponse): void {
  writeResponse(response, 'unread', 403, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  }, 'forbidden')
}

function writeLoginPage(response: ServerResponse, dictionary: LoginDictionary): void {
  writeResponse(response, 'unread', 200, responseHeaders(), renderLoginPage(dictionary, false))
}

function writeFailure(
  response: ServerResponse,
  dictionary: LoginDictionary,
  status: 400 | 401 | 405 | 408 | 413,
  requestBody: RequestBodyState,
  allow?: string,
): void {
  writeResponse(response, requestBody, status, {
    ...responseHeaders(),
    ...(allow === undefined ? {} : { allow }),
  }, renderLoginPage(dictionary, true))
}

function writeRedirect(
  response: ServerResponse,
  requestBody: RequestBodyState,
  location: string,
  cookie?: string,
): void {
  writeResponse(response, requestBody, 303, {
    'cache-control': 'no-store',
    location,
    'referrer-policy': 'no-referrer',
    ...(cookie === undefined ? {} : { 'set-cookie': cookie }),
  })
}

function decodeFormComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value.replaceAll('+', ' '))
  } catch {
    return undefined
  }
}

function decodeLoginForm(body: string): LoginForm | undefined {
  if (body === '') return undefined
  const fields = new Map<string, string>()
  for (const pair of body.split('&')) {
    const separator = pair.indexOf('=')
    if (separator === -1) return undefined
    const name = decodeFormComponent(pair.slice(0, separator))
    const value = decodeFormComponent(pair.slice(separator + 1))
    if (name === undefined || value === undefined
      || (name !== 'username' && name !== 'password') || fields.has(name)) {
      return undefined
    }
    fields.set(name, value)
  }
  const username = fields.get('username')
  const password = fields.get('password')
  if (fields.size !== 2 || username === undefined || password === undefined) return undefined
  return { username, password }
}

function declaredFormLength(request: IncomingMessage): number | undefined {
  const value = request.headers['content-length']
  if (value === undefined) return 0
  if (typeof value !== 'string' || !/^[0-9]+$/u.test(value)) return undefined
  const length = Number(value)
  return Number.isSafeInteger(length) ? length : undefined
}

function invalidLoginForm(
  status: 400 | 408 | 413,
  body: RequestBodyState,
): ParsedLoginForm {
  return { kind: 'invalid', status, body }
}

async function parseLoginForm(request: IncomingMessage): Promise<ParsedLoginForm> {
  const mediaType = header(request, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== FORM_MEDIA_TYPE) return invalidLoginForm(400, 'unread')
  const length = declaredFormLength(request)
  if (length === undefined) return invalidLoginForm(400, 'unread')
  if (length > MAX_FORM_BYTES) {
    return invalidLoginForm(413, 'unread')
  }
  const chunks: Buffer[] = []
  let received = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  let finish!: (result: ParsedLoginForm) => void
  const onData = (buffer: Buffer): void => {
    received += buffer.byteLength
    if (received > MAX_FORM_BYTES) {
      finish(invalidLoginForm(413, 'unread'))
      return
    }
    chunks.push(buffer)
  }
  const onEnd = (): void => {
    if (request.complete === false) {
      finish(invalidLoginForm(400, 'unread'))
      return
    }
    try {
      const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, received))
      const value = decodeLoginForm(body)
      finish(value === undefined
        ? invalidLoginForm(400, 'consumed')
        : { kind: 'valid', value, body: 'consumed' })
    } catch {
      finish(invalidLoginForm(400, 'consumed'))
    }
  }
  const onAborted = (): void => { finish(invalidLoginForm(400, 'unread')) }
  const onError = (): void => { finish(invalidLoginForm(400, 'unread')) }
  const onClose = (): void => {
    if (request.complete === false) finish(invalidLoginForm(400, 'unread'))
  }
  try {
    return await new Promise<ParsedLoginForm>((resolve) => {
      finish = (result) => {
        if (settled) return
        settled = true
        if (result.body === 'unread') request.pause()
        resolve(result)
      }
      timer = setTimeout(() => { finish(invalidLoginForm(408, 'unread')) }, FORM_READ_DEADLINE_MS)
      request.once('end', onEnd)
      request.once('aborted', onAborted)
      request.once('error', onError)
      request.once('close', onClose)
      request.on('data', onData)
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    request.off('data', onData)
    request.off('end', onEnd)
    request.off('aborted', onAborted)
    request.off('error', onError)
    request.off('close', onClose)
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds) })
}

/** One deployment-managed account for browser password login. */
export interface PasswordLoginConfig {
  /** Shared account name accepted by the password-login form. */
  readonly username: string
  /** Shared password retained only by the Host process. */
  readonly password: string
  /** Absolute password-session lifetime in days. Default: 7; minimum: 7. */
  readonly sessionMaxAgeDays: number
  /** Bounded generic failed-login delay in milliseconds. Default: 500; maximum: 10,000. */
  readonly failureDelayMs: number
  /** Whether password-session cookies carry the Secure attribute. Default: true. */
  readonly secureCookie: boolean
}

/** Schemastery validation and defaults for one configured password-login account. */
export const PasswordLoginConfigSchema: z<PasswordLoginConfig> = z.object({
  username: z.string().min(1).required(),
  password: z.string().min(1).required(),
  sessionMaxAgeDays: z.natural().min(7).default(7),
  failureDelayMs: z.natural().max(10_000).default(500)
    .description('Bounded generic failed-login delay in milliseconds.'),
  secureCookie: z.boolean().default(true),
})

/**
 * Create the named browser login and logout routes for an enabled password mode.
 * @param browserAuth - cookie issuer and credential verifier for this deployment.
 * @param trustedHosts - deployment authorities accepted by the shared browser-trust fence.
 * @param failureDelayMs - configured bounded delay applied after invalid credentials.
 * @returns exact named routes owned by password login.
 */
export function createPasswordLoginRoutes(
  browserAuth: BrowserAuth,
  trustedHosts: readonly string[],
  failureDelayMs: number,
): readonly WebRoute[] {
  const trusted = (request: IncomingMessage, response: ServerResponse): boolean => {
    if (isTrustedApiRequest(request, trustedHosts)) return true
    writeForbidden(response)
    return false
  }
  return [
    {
      kind: 'exact',
      path: LOGIN_PATH,
      handler: async (request, response) => {
        // The Host/Origin fence runs before a form body can be consumed.
        if (!trusted(request, response)) return
        const dictionary = dictionaryFor(request)
        if (request.method === 'GET') {
          writeLoginPage(response, dictionary)
          return
        }
        if (request.method !== 'POST') {
          writeFailure(response, dictionary, 405, 'unread', 'GET, POST')
          return
        }
        const parsed = await parseLoginForm(request)
        if (parsed.kind === 'invalid') {
          writeFailure(response, dictionary, parsed.status, parsed.body)
          return
        }
        if (!browserAuth.verifyPasswordLogin(parsed.value.username, parsed.value.password)) {
          await delay(failureDelayMs)
          writeFailure(response, dictionary, 401, parsed.body)
          return
        }
        const cookie = browserAuth.mintPasswordSession(request)
        if (cookie === undefined) {
          await delay(failureDelayMs)
          writeFailure(response, dictionary, 401, parsed.body)
          return
        }
        writeRedirect(response, parsed.body, '/', cookie)
      },
    },
    {
      kind: 'exact',
      path: LOGOUT_PATH,
      handler: (request, response) => {
        // The Host/Origin fence runs before any possible logout request body.
        if (!trusted(request, response)) return
        const dictionary = dictionaryFor(request)
        if (request.method !== 'POST') {
          writeFailure(response, dictionary, 405, 'unread', 'POST')
          return
        }
        const cookie = browserAuth.expirePasswordSession(request)
        if (cookie === undefined) {
          writeFailure(response, dictionary, 400, 'unread')
          return
        }
        writeRedirect(response, 'unread', LOGIN_PATH, cookie)
      },
    },
  ]
}
