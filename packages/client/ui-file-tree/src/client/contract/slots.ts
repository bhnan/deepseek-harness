import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceFileDownload, WorkspaceFileLevel, WorkspaceFilePreview } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
export type FileTreeInjected = {
  listLevel: (path: string, signal: AbortSignal) => Promise<WorkspaceFileLevel>
  readFile: (path: string, signal: AbortSignal) => Promise<WorkspaceFilePreview>
  openPath: (path: string) => void
  /** Fetch one bounded regular file as a base64 download payload. */
  downloadFile: (path: string, signal: AbortSignal) => Promise<WorkspaceFileDownload>
}
export type FileTreePanelProps = PropsRuntime<'sidebar.filetree'> & PropsLocale<'filetree'> & FileTreeInjected
