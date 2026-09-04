import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'

export const DEFAULT_WORKSPACE_UPLOAD_MAX_BYTES = 32 * 1024 * 1024
export interface WorkspaceUploadInput {
  name: string
  mediaType?: string
  data: string
}
export interface WorkspaceUploadResult {
  path: string
  name: string
  bytes: number
  sha256: string
  mediaType?: string
}
export class WorkspaceUploadError extends Error {}

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
    const tmp = join(uploads, `.${candidate}.${digest}.tmp`)
    try { await import('node:fs/promises').then(fs => fs.writeFile(tmp, bytes, { flag: 'wx', mode: 0o600 })); await rename(tmp, target); return result(rootPath, target, candidate, bytes, digest, input.mediaType) } catch (error: unknown) {
      await import('node:fs/promises').then(fs => fs.unlink(tmp).catch(() => {}))
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
  }
  throw new WorkspaceUploadError('unable to allocate upload filename')
}
function sanitize(value: string): string { const name = basename(value.trim()).replace(/[\u0000-\u001f\u007f]/gu, '_').normalize('NFC').slice(0, 240); if (!name || name === '.' || name === '..') throw new WorkspaceUploadError('filename is empty or unsafe'); return name }
function withSuffix(name: string, suffix: string): string { const ext = extname(name); return ext ? `${name.slice(0, -ext.length)}-${suffix}${ext}` : `${name}-${suffix}` }
function result(root: string, target: string, name: string, bytes: Uint8Array, sha256: string, mediaType?: string): WorkspaceUploadResult { return { path: relative(root, target).split(sep).join('/'), name, bytes: bytes.byteLength, sha256, ...(mediaType ? { mediaType } : {}) } }
