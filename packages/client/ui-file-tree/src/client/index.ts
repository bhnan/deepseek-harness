import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { FileTreePanel } from './FileTreePanel.tsx'
import { en, zh, type FileTreeKey } from './locales.ts'
import type { FileTreeInjected } from './contract/slots.ts'
export type { FileTreeInjected, FileTreePanelProps } from './contract/slots.ts'
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { filetree: FileTreeKey } }
export const inject = ['slots', 'remote', 'remote.workspaceFiles', 'remote.session', 'locale']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('filetree', { zh, en }), 'ui-file-tree: dictionaries')
  const injected = (): FileTreeInjected => ({
    listLevel: async (path, signal) => {
      const result = await ctx.remote.workspaceFiles.list(path, signal)
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return result.value
    },
    readFile: async (path, signal) => {
      const result = await ctx.remote.workspaceFiles.read(path, signal)
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return result.value
    },
    openPath: (path) => { void ctx.remote.session.openWorkspacePath({ path }) },
  })
  ctx.slots.inject('sidebar.filetree', () => ctx.slots.register({ name: 'sidebar.filetree', locale: 'filetree', inject: injected }, FileTreePanel))
}
