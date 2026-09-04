import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceFileLevel, WorkspaceFilePreview } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'

/** Remote file operations injected into the read-only sidebar panel. */
export type FileTreeInjected = {
  /** List one bounded directory level. */
  listLevel: (path: string, signal: AbortSignal) => Promise<WorkspaceFileLevel>
  /** Read one bounded regular-file preview. */
  readFile: (path: string, signal: AbortSignal) => Promise<WorkspaceFilePreview>
  /** Ask the Host to open a selected path with its system handler. */
  openPath: (path: string) => void
}

/** Complete slot, locale, and injected props consumed by `FileTreePanel`. */
export type FileTreePanelProps = PropsRuntime<'sidebar.filetree'> & PropsLocale<'filetree'> & FileTreeInjected
