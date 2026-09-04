/** Authenticated Host filesystem listing for the workspace file-tree UI. */

import { open, opendir, stat } from 'node:fs/promises'
import { extname, posix, resolve, win32 } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceFileEntry, WorkspaceFileLevel, WorkspaceFilePreview } from './types.ts'

/** Maximum UTF-8 text bytes returned for one in-app preview. */
const MAX_TEXT_BYTES = 256 * 1024
/** Maximum whole-image bytes returned for one in-app preview. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** Complete-result bound for either sibling group in one tree level. */
const MAX_LIST_ENTRIES = 1000

const IMAGE_MIME_BY_EXTENSION = new Map([
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
])

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Remote owner for read-only workspace file browsing. */
    workspaceFilesController: WorkspaceFilesController
  }
}

/** Whether a path identifies one stable Host location without cwd resolution. */
function fullyQualified(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
    ? win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(path)
    : posix.isAbsolute(path)
}

/** Host service backing the generated `ctx.remote.workspaceFiles` namespace. */
export class WorkspaceFilesController extends TypertRemoteService {
  /** @param ctx - Host root context guarded by the shared BrowserAuth route. */
  constructor(ctx: Context) {
    super(ctx, 'workspaceFilesController', { namespace: 'workspaceFiles' })
  }

  /**
   * List one Host directory level for the workspace file tree.
   * @param path - fully qualified directory path.
   * @param signal - caller lifetime; cancellation wins over local filesystem errors.
   * @returns sorted direct directories and regular files.
   */
  @Remote('list')
  async list(path: string, signal: AbortSignal): Promise<WorkspaceFileLevel> {
    if (!fullyQualified(path)) throw unreadable(path, 'path is not fully qualified', 'list')
    const target = resolve(path)
    signal.throwIfAborted()
    try {
      const dirs: WorkspaceFileEntry[] = []
      const files: WorkspaceFileEntry[] = []
      let dirsTruncated = false
      let filesTruncated = false
      const directory = await opendir(target)
      try {
        for (;;) {
          signal.throwIfAborted()
          const entry = await directory.read()
          if (entry === null) break
          const item = { name: entry.name, path: resolve(target, entry.name), hidden: entry.name.startsWith('.') }
          if (entry.isDirectory()) {
            dirsTruncated = boundedInsert(dirs, item) || dirsTruncated
            continue
          }
          if (entry.isFile()) {
            filesTruncated = boundedInsert(files, item) || filesTruncated
            continue
          }
          if (entry.isSymbolicLink()) {
            try {
              const targetDetails = await stat(item.path)
              signal.throwIfAborted()
              if (targetDetails.isDirectory()) dirsTruncated = boundedInsert(dirs, item) || dirsTruncated
            } catch (error: unknown) {
              if (signal.aborted) throw error
              // Broken links and links into inaccessible locations are omitted.
            }
          }
        }
      } finally {
        await directory.close()
      }
      return { dirs, files, dirsTruncated, filesTruncated }
    } catch (error: unknown) {
      if (signal.aborted) throw new RemoteError('gateway/cancelled', 'workspace file listing was aborted', {})
      throw unreadable(target, error instanceof Error ? error.message : String(error), 'list', error)
    }
  }

  /**
   * Read a bounded text head from one regular Host file for in-app preview.
   * @param path - fully qualified file path.
   * @param signal - caller lifetime; cancellation wins over local filesystem errors.
   * @returns a bounded text preview.
   */
  @Remote('read')
  async read(path: string, signal: AbortSignal): Promise<WorkspaceFilePreview> {
    if (!fullyQualified(path)) throw unreadable(path, 'path is not fully qualified', 'read')
    const target = resolve(path)
    signal.throwIfAborted()
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(target, 'r')
      const details = await handle.stat()
      if (!details.isFile()) throw new Error('path is not a regular file')
      const mime = IMAGE_MIME_BY_EXTENSION.get(extname(target).toLowerCase())
      if (mime !== undefined && details.size > MAX_IMAGE_BYTES) {
        return { path: target, size: details.size, kind: 'binary', truncated: false }
      }
      const bytes = Math.min(details.size, mime === undefined ? MAX_TEXT_BYTES : MAX_IMAGE_BYTES)
      const buffer = Buffer.alloc(bytes)
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
      signal.throwIfAborted()
      if (mime !== undefined) {
        return {
          path: target,
          size: details.size,
          kind: 'image',
          content: buffer.subarray(0, bytesRead).toString('base64'),
          mime,
          truncated: false,
        }
      }
      if (buffer.subarray(0, bytesRead).includes(0)) {
        return { path: target, size: details.size, kind: 'binary', truncated: false }
      }
      return {
        path: target,
        size: details.size,
        kind: 'text',
        content: buffer.subarray(0, bytesRead).toString('utf8'),
        truncated: details.size > bytesRead,
      }
    } catch (error: unknown) {
      if (signal.aborted) throw new RemoteError('gateway/cancelled', 'workspace file read was aborted', {})
      throw unreadable(target, error instanceof Error ? error.message : String(error), 'read', error)
    } finally {
      await handle?.close()
    }
  }
}

function compareEntry(a: WorkspaceFileEntry, b: WorkspaceFileEntry): number {
  return a.name.localeCompare(b.name)
}

/** Insert a row into the name-sorted head window and report an omitted tail. */
function boundedInsert(entries: WorkspaceFileEntry[], entry: WorkspaceFileEntry): boolean {
  const last = entries[entries.length - 1]
  if (entries.length === MAX_LIST_ENTRIES && last !== undefined && compareEntry(entry, last) >= 0) return true
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const current = entries[middle]
    if (current !== undefined && compareEntry(entry, current) < 0) high = middle
    else low = middle + 1
  }
  entries.splice(low, 0, entry)
  if (entries.length <= MAX_LIST_ENTRIES) return false
  entries.pop()
  return true
}

function unreadable(path: string, reason: string, operation: 'list' | 'read', cause?: unknown): RemoteError {
  return new RemoteError(
    'workspace-files/unreadable',
    `cannot ${operation} workspace files at ${path}: ${reason}`,
    { path },
    cause === undefined ? {} : { cause },
  )
}
