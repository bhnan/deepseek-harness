/** Browser-session authentication for the Host Connection carrier. */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type {
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionTrustRequest,
} from './rpc.ts'
import type { PasswordLoginConfig } from './password-login.ts'

const AUTH_RECORD_KEY = credentialKey('client-connection', 'browser-session')
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const SECRET_BYTES = 32
const TOKEN_QUERY = 'token'
const COOKIE_PREFIX = 'dsh-auth-'
const TOKEN_COOKIE_PAYLOAD_VERSION = 1
const PASSWORD_COOKIE_PAYLOAD_VERSION = 2
const STORED_SECRET_VERSION = 1
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/
const PROCESS_LAUNCH_TOKENS = new WeakMap<object, string>()

interface StoredSecretPayload {
  readonly version: typeof STORED_SECRET_VERSION
  readonly secret: string
}

interface TokenCookiePayload {
  readonly version: typeof TOKEN_COOKIE_PAYLOAD_VERSION
  readonly authority: string
  readonly issuedAt: number
  readonly expiresAt: number
}

interface PasswordCookiePayload {
  readonly version: typeof PASSWORD_COOKIE_PAYLOAD_VERSION
  readonly authority: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly credentialRevision: string
  readonly sessionId: string
}

type BrowserCookiePayload = TokenCookiePayload | PasswordCookiePayload

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

function processLaunchToken(owner: object): string {
  const existing = PROCESS_LAUNCH_TOKENS.get(owner)
  if (existing !== undefined) return existing
  const created = encodeBase64Url(randomBytes(SECRET_BYTES))
  PROCESS_LAUNCH_TOKENS.set(owner, created)
  return created
}

function header(
  headers: ConnectionTrustRequest['headers'],
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Canonical request authority used as the cookie name and signed audience. */
function requestAuthority(headers: ConnectionTrustRequest['headers']): string | undefined {
  const host = header(headers, 'host')
  if (host === undefined) return undefined
  try {
    return new URL(`http://${host}`).host
  } catch {
    return undefined
  }
}

function fixedBase64Url(value: unknown, byteLength: number): Buffer | undefined {
  if (typeof value !== 'string') return undefined
  const decoded = decodeBase64Url(value)
  if (decoded === undefined || decoded.byteLength !== byteLength) return undefined
  return decoded
}

function canonicalSecret(value: unknown): Buffer | undefined {
  return fixedBase64Url(value, SECRET_BYTES)
}

function storedSecret(record: CredentialRecord | undefined): Buffer | undefined {
  if (record === undefined) return undefined
  if (record.kind !== 'grant' || !isRecord(record.payload)
    || record.payload.version !== STORED_SECRET_VERSION) {
    throw new Error('client-connection: browser-session credential record has an unsupported format')
  }
  const secret = canonicalSecret(record.payload.secret)
  if (secret === undefined) {
    throw new Error('client-connection: browser-session credential record has an invalid secret')
  }
  return secret
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes)
}

function credentialRevision(secret: Buffer, username: string, password: string): Buffer {
  return createHmac('sha256', secret)
    .update('dsh-browser-password-login-revision-v1\0', 'utf8')
    .update(JSON.stringify([username, password]), 'utf8')
    .digest()
}

function digestsMatch(actual: Buffer, expected: Buffer): boolean {
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
}

function cookieName(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/** Read the exact generated cookie without implementing general Cookie decoding. */
function cookieValue(headerValue: string, name: string): string | undefined {
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

/** Serialize the fixed browser-session attributes; generated names and values are cookie-safe base64url. */
function sessionCookie(
  name: string,
  value: string,
  expiresAt: number,
  maxAgeSeconds: number,
  secureCookie: boolean,
): string {
  return `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly${secureCookie ? '; Secure' : ''}; SameSite=Strict`
}

function expiredSessionCookie(name: string, secureCookie: boolean): string {
  return `${name}=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly${secureCookie ? '; Secure' : ''}; SameSite=Strict`
}

function signature(secret: Buffer, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest()
}

function encodeCookie(payload: BrowserCookiePayload, secret: Buffer): string {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `v${String(payload.version)}.${body}.${encodeBase64Url(signature(secret, body))}`
}

function decodeCookie(value: string, secret: Buffer): BrowserCookiePayload | undefined {
  const parts = value.split('.')
  const [version, body, encodedSignature] = parts
  const payloadVersion = version === 'v1'
    ? TOKEN_COOKIE_PAYLOAD_VERSION
    : version === 'v2'
      ? PASSWORD_COOKIE_PAYLOAD_VERSION
      : undefined
  if (parts.length !== 3 || payloadVersion === undefined || body === undefined || encodedSignature === undefined) {
    return undefined
  }
  const actualSignature = decodeBase64Url(encodedSignature)
  if (actualSignature === undefined) return undefined
  const expectedSignature = signature(secret, body)
  if (actualSignature.byteLength !== expectedSignature.byteLength
    || !timingSafeEqual(actualSignature, expectedSignature)) return undefined
  let decoded: unknown
  try {
    const bodyBytes = decodeBase64Url(body)
    if (bodyBytes === undefined) return undefined
    decoded = JSON.parse(bodyBytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(decoded)
    || decoded.version !== payloadVersion
    || typeof decoded.authority !== 'string'
    || !Number.isSafeInteger(decoded.issuedAt)
    || !Number.isSafeInteger(decoded.expiresAt)) return undefined
  if (payloadVersion === TOKEN_COOKIE_PAYLOAD_VERSION) {
    return decoded as unknown as TokenCookiePayload
  }
  if (typeof decoded.credentialRevision !== 'string' || typeof decoded.sessionId !== 'string') {
    return undefined
  }
  return decoded as unknown as PasswordCookiePayload
}

function maxAgeMilliseconds(maxAgeDays: number, fieldName: string): number {
  const value = maxAgeDays * DAY_MILLISECONDS
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(Date.now() + value)) {
    throw new Error(`client-connection: ${fieldName} exceeds the safe timestamp range`)
  }
  return value
}

async function initializeSecret(credentials: CredentialProvider): Promise<Buffer> {
  const generated: StoredSecretPayload = {
    version: STORED_SECRET_VERSION,
    secret: encodeBase64Url(randomBytes(SECRET_BYTES)),
  }
  const record = await credentials.modifyRecord(AUTH_RECORD_KEY, (current) => {
    if (current !== undefined) {
      storedSecret(current)
      return Promise.resolve(undefined)
    }
    return Promise.resolve({ kind: 'grant', payload: generated })
  })
  const secret = storedSecret(record)
  if (secret === undefined) {
    throw new Error('client-connection: browser-session credential record was not created')
  }
  return secret
}

/**
 * Process launch-token exchange or password-session verification.
 * Connection loads the credential provider's signing secret during activation
 * and retains it for synchronous request authentication.
 */
export class BrowserAuth {
  private readonly launchToken: string
  private readonly tokenMaxAgeMilliseconds: number
  private readonly passwordCredentialRevision: Buffer | undefined
  private readonly passwordMaxAgeMilliseconds: number | undefined

  private constructor(
    processOwner: object,
    private readonly secret: Buffer,
    maxAgeDays: number,
    private readonly passwordLogin: PasswordLoginConfig | undefined,
  ) {
    this.launchToken = processLaunchToken(processOwner)
    this.tokenMaxAgeMilliseconds = maxAgeMilliseconds(maxAgeDays, 'cookieMaxAgeDays')
    this.passwordCredentialRevision = passwordLogin === undefined
      ? undefined
      : credentialRevision(this.secret, passwordLogin.username, passwordLogin.password)
    this.passwordMaxAgeMilliseconds = passwordLogin === undefined
      ? undefined
      : maxAgeMilliseconds(passwordLogin.sessionMaxAgeDays, 'passwordLogin.sessionMaxAgeDays')
  }

  /**
   * Initialize browser authentication and create its durable signing secret
   * when this Harness home has none.
   * @param processOwner - root application context retaining one token across Connection reloads.
   * @param credentials - persistent credential provider for the Web profile.
   * @param maxAgeDays - positive absolute browser-cookie lifetime in days.
   * @param passwordLogin - optional deployment-managed account replacing launch-token login.
   * @returns initialized authentication owner for the selected browser-login mode.
   */
  static async create(
    processOwner: object,
    credentials: CredentialProvider,
    maxAgeDays: number,
    passwordLogin?: PasswordLoginConfig,
  ): Promise<BrowserAuth> {
    return new BrowserAuth(processOwner, await initializeSecret(credentials), maxAgeDays, passwordLogin)
  }

  /**
   * Compare one submitted username and password with the configured account.
   * @param username - login-form username.
   * @param password - login-form password.
   * @returns true only when password login is enabled and both submitted values match.
   */
  verifyPasswordLogin(username: string, password: string): boolean {
    const expected = this.passwordCredentialRevision
    return expected !== undefined && digestsMatch(credentialRevision(this.secret, username, password), expected)
  }

  /**
   * Mint one independent password-mode session for a request authority.
   * @param request - request whose Host supplies the cookie authority.
   * @returns serialized Set-Cookie value, or undefined when password mode or a valid authority is absent.
   */
  mintPasswordSession(request: ConnectionTrustRequest): string | undefined {
    const authority = requestAuthority(request.headers)
    const revision = this.passwordCredentialRevision
    const maxAge = this.passwordMaxAgeMilliseconds
    if (authority === undefined || revision === undefined || maxAge === undefined || this.passwordLogin === undefined) {
      return undefined
    }
    const issuedAt = Date.now()
    const expiresAt = issuedAt + maxAge
    const value = encodeCookie({
      version: PASSWORD_COOKIE_PAYLOAD_VERSION,
      authority,
      issuedAt,
      expiresAt,
      credentialRevision: encodeBase64Url(revision),
      sessionId: encodeBase64Url(randomBytes(SECRET_BYTES)),
    }, this.secret)
    return sessionCookie(
      cookieName(authority), value, expiresAt, Math.floor(maxAge / 1000), this.passwordLogin.secureCookie,
    )
  }

  /**
   * Expire this authority's password-session cookie in one browser.
   * @param request - request whose Host supplies the cookie authority.
   * @returns serialized Set-Cookie value, or undefined when password mode or a valid authority is absent.
   */
  expirePasswordSession(request: ConnectionTrustRequest): string | undefined {
    const authority = requestAuthority(request.headers)
    if (authority === undefined || this.passwordLogin === undefined) return undefined
    return expiredSessionCookie(cookieName(authority), this.passwordLogin.secureCookie)
  }

  /**
   * Return the ordinary application root URL for the selected browser-login mode.
   * @param baseUrl - canonical browser origin without credentials.
   * @returns clean root URL for password login, or root URL carrying the process token otherwise.
   */
  authenticatedUrl(baseUrl: string): string {
    const url = new URL(baseUrl)
    url.pathname = '/'
    url.search = ''
    url.hash = ''
    if (this.passwordLogin !== undefined) return url.href
    url.searchParams.set(TOKEN_QUERY, this.launchToken)
    return url.href
  }

  /**
   * Authenticate an index request. Launch-token mode exchanges a valid root
   * query token for a cookie and redirects to clean `/`; either mode accepts
   * its valid cookie for index serving; every other request receives the same
   * minimal 401 response.
   * @param req - incoming root or configured-index request.
   * @param res - response owned when this method returns false.
   * @returns true only when the caller may serve index.html.
   */
  authorizeIndex(req: ConnectionIndexRequest, res: ConnectionIndexResponse): boolean {
    /* v8 ignore next -- node:http always supplies url on server requests. */
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const tokens = url.searchParams.getAll(TOKEN_QUERY)
    if (this.passwordLogin === undefined && tokens.length > 0) {
      const authority = requestAuthority(req.headers)
      if (req.method === 'GET' && url.pathname === '/' && tokens.length === 1
        && authority !== undefined && tokenMatches(tokens.join(''), this.launchToken)) {
        const issuedAt = Date.now()
        const expiresAt = issuedAt + this.tokenMaxAgeMilliseconds
        const value = encodeCookie({
          version: TOKEN_COOKIE_PAYLOAD_VERSION,
          authority,
          issuedAt,
          expiresAt,
        }, this.secret)
        res.writeHead(303, {
          'cache-control': 'no-store',
          'location': '/',
          'referrer-policy': 'no-referrer',
          'set-cookie': sessionCookie(
            cookieName(authority), value, expiresAt, Math.floor(this.tokenMaxAgeMilliseconds / 1000), false,
          ),
        })
        res.end()
        return false
      }
      if (req.method === 'GET' && url.pathname === '/' && this.isAuthenticated(req)) {
        res.writeHead(303, {
          'cache-control': 'no-store',
          'location': '/',
          'referrer-policy': 'no-referrer',
        })
        res.end()
        return false
      }
      this.writeUnauthorized(req, res)
      return false
    }
    if (this.isAuthenticated(req)) return true
    this.writeUnauthorized(req, res)
    return false
  }

  /**
   * Verify the authority-bound browser cookie on a Host request.
   * @param request - request headers carrying Host and Cookie.
   * @returns true only for an unexpired cookie of the active mode signed by the loaded secret.
   */
  isAuthenticated(request: ConnectionTrustRequest): boolean {
    const authority = requestAuthority(request.headers)
    const rawCookie = header(request.headers, 'cookie')
    if (authority === undefined || rawCookie === undefined) return false
    const value = cookieValue(rawCookie, cookieName(authority))
    if (value === undefined) return false
    const payload = decodeCookie(value, this.secret)
    if (payload === undefined || payload.authority !== authority) return false
    const now = Date.now()
    const validLifetime = payload.issuedAt <= now
      && payload.expiresAt > now
      && payload.expiresAt > payload.issuedAt
    if (this.passwordLogin === undefined) {
      return payload.version === TOKEN_COOKIE_PAYLOAD_VERSION
        && validLifetime
        && payload.expiresAt - payload.issuedAt <= this.tokenMaxAgeMilliseconds
    }
    if (payload.version !== PASSWORD_COOKIE_PAYLOAD_VERSION || !validLifetime
      || this.passwordCredentialRevision === undefined || this.passwordMaxAgeMilliseconds === undefined) {
      return false
    }
    const revision = fixedBase64Url(payload.credentialRevision, this.passwordCredentialRevision.byteLength)
    const sessionId = fixedBase64Url(payload.sessionId, SECRET_BYTES)
    return revision !== undefined
      && sessionId !== undefined
      && payload.expiresAt - payload.issuedAt <= this.passwordMaxAgeMilliseconds
      && digestsMatch(revision, this.passwordCredentialRevision)
  }

  private writeUnauthorized(req: ConnectionIndexRequest, res: ConnectionIndexResponse): void {
    res.writeHead(401, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    })
    res.end(req.method === 'HEAD'
      ? undefined
      : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
  }
}
