/**
 * ui-file-tree contracts: the panel's injected share and composed props. The
 * `sidebar.filetree` hole itself is declared (and typed) by ui-sidebar's
 * 'sidebar' entry — this package only registers into it.
 */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.filetree' entry).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** One tree row: a directory or file child of a listed level. */
export interface FileTreeEntry {
  /** Base name shown in the row. */
  name: string
  /** Absolute host path (the client never joins path segments itself). */
  path: string
  /** Hidden by the host platform's convention; rendered dimmed, not hidden. */
  hidden: boolean
}

/** One listed level: its child directories and files, name-sorted per group. */
export interface FileTreeLevel {
  /** Direct child directories. */
  dirs: FileTreeEntry[]
  /** Direct child regular files. */
  files: FileTreeEntry[]
  /** True when either group was cut at the Host's complete-result bound. */
  truncated: boolean
}

/** One bounded preview read, as the Host reports it. */
export interface FilePreview {
  /** Total file size in bytes (may exceed what `content` carries). */
  size: number
  /** `text` = UTF-8 head in `content`; `image` = base64 in `content` with `mime`; `binary` = not previewable. */
  kind: 'text' | 'image' | 'binary'
  /** UTF-8 text head or base64 image bytes; absent for `binary`. */
  content?: string
  /** Image mime type; present only for `image`. */
  mime?: string
  /** True when `content` carries only the head of the file. */
  truncated: boolean
}

/**
 * Panel-private injected share (arrives via the register inject factory):
 * the Host actions the tree drives.
 */
export type FileTreeInjected = {
  /**
   * List one directory level with files included.
   * @param path - absolute directory to list.
   * @param signal - aborts the wire request when the caller supersedes it.
   */
  listLevel: (path: string, signal?: AbortSignal) => Promise<FileTreeLevel>
  /**
   * Read one file for the in-app preview (bounded server-side).
   * @param path - absolute file path.
   * @param signal - aborts the wire request when the caller supersedes it.
   */
  readFile: (path: string, signal?: AbortSignal) => Promise<FilePreview>
  /** Open a file with the Host operating system's default application (best-effort). */
  openPath: (path: string) => void
}

/** Full component props: owner state + injected actions + the locale seat. */
export type FileTreePanelProps =
  PropsRuntime<'sidebar.filetree'>
  & FileTreeInjected
  & PropsLocale<'filetree'>
