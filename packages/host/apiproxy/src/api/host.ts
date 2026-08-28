/**
 * host domain contract. No protocol version: client and host ship
 * together; introduce protocolVersion only when an independently released client appears.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One directory row of a listing: a child entry or a breadcrumb ancestor. */
export interface DirectoryEntry {
  /** Base name shown in a browser row (a root crumb carries its full path). */
  name: string
  /** Absolute host path — the client never joins path segments itself. */
  path: string
  /** Hidden by the host platform's convention (dot-prefixed on POSIX); the client owns whether to show it. */
  hidden: boolean
}

/** host.listDirectory response value: one directory level plus its ancestry. */
export interface DirectoryListing {
  /** Absolute path of the listed directory. */
  path: string
  /** The host account's home directory (breadcrumb "Home" rooting). */
  home: string
  /**
   * Ancestor chain from the filesystem root to the listed directory
   * inclusive; every crumb is a jump target (crumb `hidden` is always false).
   */
  crumbs: DirectoryEntry[]
  /** Direct child directories, name-sorted; symlinks to directories included. */
  entries: DirectoryEntry[]
  /** True when the backend cut `entries` at its complete-result bound (the name-sorted tail is absent). */
  truncated: boolean
  /** Direct child regular files, name-sorted; present only when the request asked for `files`. */
  files?: DirectoryEntry[]
  /** True when the backend cut `files` at its bound; present only when the request asked for `files`. */
  filesTruncated?: boolean
}

/** host.readFile response value: one bounded read of a regular file for in-app preview. */
export interface FileContent {
  /** Absolute path actually read. */
  path: string
  /** Total file size in bytes (may exceed what `content` carries). */
  size: number
  /**
   * How the preview should treat the payload: `text` carries a UTF-8 head in
   * `content`; `image` carries the whole file base64-encoded in `content`
   * with `mime` set; `binary` carries no content (not previewable, or an
   * image over the server's bound).
   */
  kind: 'text' | 'image' | 'binary'
  /** UTF-8 text head for `text`; base64 bytes for `image`; absent for `binary`. */
  content?: string
  /** Image mime type derived from the file extension; present only for `image`. */
  mime?: string
  /** True when `content` carries only the head of the file. */
  truncated: boolean
}

/** Host-level unary methods. */
export interface HostApi {
  /**
   * One-shot host snapshot. Empty payload uses the literal `{}` (extend in place when fields arrive).
   * version = the host app's (apps/cli) package.json version; cwd = the host process working
   * directory (root for session persistence and tool execution); provider/model = the defaults
   * applied when a new agent doesn't specify them explicitly, absent when the host configures
   * no explicit default (the adapter falls back internally);
   * attachedSessions = count of currently attached sessions (those with a live agent);
   * home = the host account home directory (Web display abbreviation on POSIX);
   * canOpenPath = whether this deployment can hand a path to a user-visible native desktop.
   */
  describe(request: RpcRequest<{}>): Promise<RpcResponse<{
    version: string
    cwd: string
    provider?: string
    model?: string
    attachedSessions: number
    home: string
    canOpenPath: boolean
  }>>

  /**
   * Open the operating system's single-directory picker; cancellation returns
   * null. Only served under the `native` capability.
   */
  pickDirectory(
    request: RpcRequest<{}>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ path: string | null }>>

  /**
   * List one directory level for the in-app browser; an absent path lists the
   * host account's home directory. `files: true` additionally reports the
   * level's direct child regular files (the workspace file tree's read).
   * Only served under the `browse` capability; unreadable or missing targets
   * fail with `directory-unreadable`. The carrier's request signal follows
   * the caller, stopping the backend's scan on disconnect or timeout.
   */
  listDirectory(
    request: RpcRequest<{ path?: string; files?: boolean }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<DirectoryListing>>

  /**
   * Create one child directory under an existing parent (the browser's
   * "New folder"). Only served under the `browse` capability; an existing
   * child fails with `directory-exists`, every other filesystem failure with
   * `directory-create-failed`.
   */
  createDirectory(
    request: RpcRequest<{ path: string; name: string }>,
  ): Promise<RpcResponse<{ path: string }>>

  /**
   * Read one regular file for in-app preview (the workspace file tree's
   * click). The read is bounded server-side: text previews carry only the
   * UTF-8 head, images are base64-encoded whole up to a size bound, and
   * anything else (or an unreadable/irregular target) reports `binary` or
   * fails with `file-unreadable`. The browser carrier treats this as a
   * privileged method: loopback reaches it directly, while a trusted-host
   * deployment must authenticate callers before the RPC bridge.
   */
  readFile(
    request: RpcRequest<{ path: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<FileContent>>

  /**
   * Open a filesystem path with the operating system's default application
   * (Finder / Explorer / xdg-open hand-off). The browser carrier's
   * prefix-wide trust fence covers this privileged method like every other
   * `/api` request.
   */
  openPath(
    request: RpcRequest<{ path: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ opened: true }>>
}
