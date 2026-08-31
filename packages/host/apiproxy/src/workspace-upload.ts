/** Host-side persistence for files uploaded into one registered workspace. */

import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'

/** Default maximum decoded payload accepted by `workspace.uploadFile`. */
export const DEFAULT_WORKSPACE_UPLOAD_MAX_BYTES = 32 * 1024 * 1024

/** Request body accepted by the host storage helper. */
export interface WorkspaceUploadInput {
  name: string
  mediaType?: string
  data: string
}

/** Metadata returned after one upload is durable. */
export interface WorkspaceUploadResult {
  path: string
  name: string
  bytes: number
  sha256: string
  mediaType?: string
}

/** Validation or filesystem failure owned by the workspace-upload boundary. */
export class WorkspaceUploadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceUploadError'
  }
}

/**
 * Decode, validate, and persist one browser upload below `<root>/uploads/`.
 *
 * The final file is opened with `wx`, so an existing path is never replaced.
 * A same-content collision reuses the existing file; a different collision
 * receives a deterministic digest suffix.
 *
 * @param root - canonical workspace directory.
 * @param input - browser filename, optional media type, and base64 bytes.
 * @param maxBytes - maximum decoded payload size.
 * @returns workspace-relative durable file metadata.
 */
export async function saveWorkspaceUpload(
  root: string,
  input: WorkspaceUploadInput,
  maxBytes = DEFAULT_WORKSPACE_UPLOAD_MAX_BYTES,
): Promise<WorkspaceUploadResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new WorkspaceUploadError('workspace upload byte limit must be a non-negative safe integer')
  }
  const name = sanitizeUploadName(input.name)
  const data = decodeBase64(input.data, maxBytes)
  if (data.byteLength > maxBytes) {
    throw new WorkspaceUploadError(`workspace upload exceeds the ${String(maxBytes)} byte limit`)
  }
  const sha256 = createHash('sha256').update(data).digest('hex')
  const workspaceRoot = resolve(root)
  const uploads = join(workspaceRoot, 'uploads')
  await ensureUploadDirectory(workspaceRoot, uploads)

  let candidate = name
  let collision = 0
  while (true) {
    const target = join(uploads, candidate)
    const existing = await existingUpload(target)
    if (existing === undefined && await writeExclusive(target, data)) {
      return uploadResult(workspaceRoot, target, candidate, data, sha256, input.mediaType)
    }
    if (existing !== undefined && sameBytes(existing, data)) {
      return uploadResult(workspaceRoot, target, candidate, data, sha256, input.mediaType)
    }
    collision += 1
    candidate = collision === 1
      ? addDigestSuffix(name, sha256.slice(0, 8))
      : addDigestSuffix(name, `${sha256.slice(0, 8)}-${String(collision)}`)
  }
}

function sanitizeUploadName(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') throw new WorkspaceUploadError('workspace upload filename must not be empty')
  const safe = trimmed
    .replace(/[\\/]/gu, '_')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, '_')
    .normalize('NFC')
    .slice(0, 240)
  if (safe === '' || safe === '.' || safe === '..') {
    throw new WorkspaceUploadError('workspace upload filename is not usable')
  }
  return safe
}

function decodeBase64(raw: string, maxBytes: number): Buffer {
  const maximumEncodedBytes = Math.ceil(maxBytes / 3) * 4 + 4
  if (raw.length > maximumEncodedBytes) {
    throw new WorkspaceUploadError(`workspace upload exceeds the ${String(maxBytes)} byte limit`)
  }
  if (raw.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(raw)) {
    throw new WorkspaceUploadError('workspace upload data is not valid base64')
  }
  const data = Buffer.from(raw, 'base64')
  if (data.toString('base64') !== raw) {
    throw new WorkspaceUploadError('workspace upload data is not canonical base64')
  }
  return data
}

async function ensureUploadDirectory(root: string, uploads: string): Promise<void> {
  const rootStatus = await lstat(root).catch((error: unknown) => {
    throw new WorkspaceUploadError(`workspace root is unavailable: ${String(error)}`)
  })
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new WorkspaceUploadError('workspace root is not a directory')
  }
  await mkdir(uploads, { recursive: true, mode: 0o700 }).catch((error: unknown) => {
    throw new WorkspaceUploadError(`workspace upload directory cannot be created: ${String(error)}`)
  })
  const status = await lstat(uploads).catch((error: unknown) => {
    throw new WorkspaceUploadError(`workspace upload directory cannot be inspected: ${String(error)}`)
  })
  if (status.isSymbolicLink()) throw new WorkspaceUploadError('workspace upload directory must not be a symlink')
  if (!status.isDirectory()) throw new WorkspaceUploadError('workspace upload path is not a directory')
}

async function existingUpload(path: string): Promise<Buffer | undefined> {
  const status = await lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return undefined
    throw new WorkspaceUploadError(`workspace upload target cannot be inspected: ${String(error)}`)
  })
  if (status === undefined) return undefined
  if (status.isSymbolicLink()) throw new WorkspaceUploadError('workspace upload target must not be a symlink')
  if (!status.isFile()) throw new WorkspaceUploadError('workspace upload target is not a file')
  return readFile(path).catch((error: unknown) => {
    throw new WorkspaceUploadError(`workspace upload target cannot be read: ${String(error)}`)
  })
}

async function writeExclusive(path: string, data: Uint8Array): Promise<boolean> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
    await link(temporary, path)
    return true
  } catch (error: unknown) {
    if (isExists(error)) return false
    throw new WorkspaceUploadError(`workspace upload cannot be written: ${String(error)}`)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

function uploadResult(
  root: string,
  target: string,
  name: string,
  data: Uint8Array,
  sha256: string,
  mediaType: string | undefined,
): WorkspaceUploadResult {
  return {
    path: relative(root, target).split(sep).join('/'),
    name,
    bytes: data.byteLength,
    sha256,
    ...(mediaType === undefined || mediaType === '' ? {} : { mediaType }),
  }
}

function addDigestSuffix(name: string, suffix: string): string {
  const extension = extname(name)
  return extension === ''
    ? `${name}-${suffix}`
    : `${name.slice(0, -extension.length)}-${suffix}${extension}`
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}
