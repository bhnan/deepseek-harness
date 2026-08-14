/**
 * Browser half of the workspace file-tree panel: fills the sidebar shell's
 * `sidebar.filetree` hole with a lazy directory/file tree rooted at the
 * active session's Workspace, reading levels through `ctx.workspaces`
 * (`host.listDirectory` with `files: true`) and opening files with the Host
 * OS's default application.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.filetree' hole).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { FileTreeInjected } from './contract/slots.ts'
import { FileTreePanel } from './FileTreePanel.tsx'
import { en, zh, type FileTreeKey } from './locales.ts'

export type { FilePreview, FileTreeEntry, FileTreeInjected, FileTreeLevel, FileTreePanelProps } from './contract/slots.ts'
export type { FileTreeKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workspace file-tree panel copy. */
    filetree: FileTreeKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'filetree'

/** Services required by the file-tree plugin. */
export const inject = ['slots', 'workspaces', 'sessions', 'locale']

/**
 * Registers the file-tree panel into the sidebar shell's hole.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-file-tree: dictionaries')

  const injected = (): FileTreeInjected => ({
    listLevel: async (path, signal) => {
      const listing = await ctx.workspaces.listDirectory(path, signal, { files: true })
      return {
        dirs: listing.entries,
        files: listing.files ?? [],
        truncated: listing.truncated || (listing.filesTruncated ?? false),
      }
    },
    readFile: async (path, signal) => {
      const { size, kind, content, mime, truncated } = await ctx.workspaces.readFile(path, signal)
      return {
        size, kind, truncated,
        ...(content !== undefined && { content }),
        ...(mime !== undefined && { mime }),
      }
    },
    openPath: (path) => {
      void ctx.workspaces.openPath(path).catch(() => {
        // Best-effort desktop hand-off: a deployment that cannot open paths
        // just ignores the click (same stance as ui-deliverables chips).
      })
    },
  })
  // The shell's declaration may activate later or be replaced across HMR;
  // slots.inject waits for it and detaches with this fiber.
  ctx.slots.inject('sidebar.filetree', () =>
    ctx.slots.register({ name: 'sidebar.filetree', inject: injected, locale: NS }, FileTreePanel))
}
