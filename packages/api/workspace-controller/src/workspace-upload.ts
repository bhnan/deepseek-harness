import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'

/** Largest decoded browser upload accepted by the default Host policy. */
export const DEFAULT_WORKSPACE_UPLOAD_MAX_BYTES = 32 * 1024 * 1024

/** Browser-owned upload payload accepted by the Host filesystem writer. */
export interface WorkspaceUploadInput {
  /** Browser-provided basename; the Host normalizes and validates it. */
  name: string
  /** Browser-provided media type, when available. */
  mediaType?: string
  /** Canonical base64-encoded bytes. */
  data: string
}

/** Stored-file projection returned by the Host filesystem writer. */
export interface WorkspaceUploadResult {
  /** Path relative to the Workspace root. */
  path: string
  /** Stored basename after collision resolution. */
  name: string
  /** Number of decoded bytes. */
  bytes: number
  /** SHA-256 digest of the stored bytes. */
  sha256: string
  /** Browser-provided media type, when available. */
  mediaType?: string
}

/** Expected validation or filename-allocation failure while saving an upload. */
export class WorkspaceUploadError extends Error {}

/**
 * Decode and atomically save one browser-selected file under a Workspace.
 * @param root - canonical Workspace root directory.
 * @param input - browser file metadata and canonical base64 bytes.
 * @param maxBytes - maximum decoded byte count the Host accepts.
 * @returns stored workspace-relative file metadata.
 */
export async function saveWorkspaceUpload(
  root: string,
  input: WorkspaceUploadInput,
  maxBytes = DEFAULT_WORKSPACE_UPLOAD_MAX_BYTES,
): Promise<WorkspaceUploadResult> {
  const name = sanitize(input.name)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new WorkspaceUploadError('invalid upload limit')
  const validBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(input.data)
  if (input.data.length > Math.ceil(maxBytes / 3) * 4 + 4 || input.data.length % 4 !== 0 || !validBase64) {
    throw new WorkspaceUploadError('invalid base64 data')
  }
  const bytes = Buffer.from(input.data, 'base64')
  if (bytes.toString('base64') !== input.data || bytes.length > maxBytes) {
    throw new WorkspaceUploadError('upload exceeds byte limit or is not canonical base64')
  }
  const rootPath = resolve(root)
  const uploads = join(rootPath, 'uploads')
  const rootStat = await stat(rootPath)
  if (!rootStat.isDirectory()) throw new WorkspaceUploadError('workspace root is not a directory')
  await mkdir(uploads, { recursive: true, mode: 0o700 })
  const digest = createHash('sha256').update(bytes).digest('hex')
  let candidate = name
  for (let n = 0; n < 1000; n += 1) {
    const target = join(uploads, candidate)
    try {
      const existing = await readFile(target)
      if (existing.equals(bytes)) return result(rootPath, target, candidate, bytes, digest, input.mediaType)
      candidate = withSuffix(name, `${digest.slice(0, 8)}${n ? `-${n + 1}` : ''}`)
      continue
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const tmp = join(uploads, `.${candidate}.${randomUUID()}.tmp`)
    try {
      await writeFile(tmp, bytes, { flag: 'wx', mode: 0o600 })
      // link() is an exclusive publish: unlike rename(), it refuses to
      // overwrite a target another uploader created after the read above.
      await link(tmp, target)
      return result(rootPath, target, candidate, bytes, digest, input.mediaType)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const existing = await readFile(target)
        if (existing.equals(bytes)) return result(rootPath, target, candidate, bytes, digest, input.mediaType)
        candidate = withSuffix(name, `${digest.slice(0, 8)}${n ? `-${n + 1}` : ''}`)
        continue
      }
      throw error
    } finally {
      await unlink(tmp).catch(() => {})
    }
  }
  throw new WorkspaceUploadError('unable to allocate upload filename')
}

/** Normalize a browser filename into one safe path segment. */
function sanitize(value: string): string {
  const name = basename(value.trim())
    .replace(/[\u0000-\u001f\u007f]/gu, '_')
    .normalize('NFC')
    .slice(0, 240)
  if (!name || name === '.' || name === '..') throw new WorkspaceUploadError('filename is empty or unsafe')
  return name
}

/** Add a digest-derived suffix before a filename extension. */
function withSuffix(name: string, suffix: string): string {
  const ext = extname(name)
  return ext ? `${name.slice(0, -ext.length)}-${suffix}${ext}` : `${name}-${suffix}`
}

/** Project one stored file into the browser-safe response shape. */
function result(
  root: string,
  target: string,
  name: string,
  bytes: Uint8Array,
  sha256: string,
  mediaType?: string,
): WorkspaceUploadResult {
  return {
    path: relative(root, target).split(sep).join('/'),
    name,
    bytes: bytes.byteLength,
    sha256,
    ...(mediaType ? { mediaType } : {}),
  }
}
