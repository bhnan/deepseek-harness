/** File-tree slot registration and its plain workspace-service callbacks. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-file-tree/client'
import type { FileTreeInjected } from '@deepseek-ai/dsh-client-ui-file-tree/client'
import { FileTreePanel } from '../src/client/FileTreePanel.tsx'

// The service reads its initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

/** Declare the shell-owned hole the plugin registers into ('root' stands in for the sidebar entry). */
function declareHole(slots: SlotRegistry): () => void {
  return slots.register(
    { name: 'root', children: { 'sidebar.filetree': { kind: 'single', scope: 'root' } } } as never,
    () => null,
  )
}

async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const workspaces = {
    listDirectory: vi.fn(),
    readFile: vi.fn(),
    openPath: vi.fn(async () => {}),
  }
  ctx.provide('workspaces', workspaces as never)
  ctx.provide('sessions', {} as never)
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const slots = ctx.get('slots') as SlotRegistry
  if (declare) declareHole(slots)
  return { ctx, slots, locale, workspaces }
}

describe('ui-file-tree apply', () => {
  it('declares only the services it uses', () => {
    expect(inject).toEqual(['slots', 'workspaces', 'sessions', 'locale'])
  })

  it('registers the panel for declarations arriving before or after apply', async () => {
    const before = await bench()
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    expect(before.slots.entries('sidebar.filetree')).toHaveLength(1)
    expect(before.slots.entries('sidebar.filetree')[0]!.component).toBe(FileTreePanel)
    // Copy rides the standard locale seat, not the inject face.
    expect(before.slots.entries('sidebar.filetree')[0]!.locale).toBe('filetree')

    const after = await bench(false)
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    // No declaration yet: the injection waits instead of failing.
    expect(after.slots.entries('sidebar.filetree')).toHaveLength(0)
    declareHole(after.slots)
    await Promise.resolve()
    expect(after.slots.entries('sidebar.filetree')).toHaveLength(1)
  })

  it('detaches with a collapsing declaration and reattaches on redeclaration (HMR)', async () => {
    const b = await bench(false)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const undeclare = declareHole(b.slots)
    await Promise.resolve()
    expect(b.slots.entries('sidebar.filetree')).toHaveLength(1)
    undeclare()
    await Promise.resolve()
    expect(b.slots.entries('sidebar.filetree')).toHaveLength(0)
    declareHole(b.slots)
    await Promise.resolve()
    expect(b.slots.entries('sidebar.filetree')).toHaveLength(1)
  })

  it('maps host listings onto tree levels through the injected listLevel', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const injected = (b.slots.entries('sidebar.filetree')[0]!.inject as () => FileTreeInjected)()

    const dir = { name: 'src', path: '/w/src', hidden: false }
    const file = { name: 'a.txt', path: '/w/a.txt', hidden: false }
    b.workspaces.listDirectory.mockResolvedValueOnce({
      path: '/w', home: '/h', crumbs: [], entries: [dir], truncated: false,
      files: [file], filesTruncated: false,
    })
    const signal = new AbortController().signal
    await expect(injected.listLevel('/w', signal)).resolves.toEqual({
      dirs: [dir], files: [file], truncated: false,
    })
    expect(b.workspaces.listDirectory).toHaveBeenCalledWith('/w', signal, { files: true })

    // A backend answering without the files window still yields a level.
    b.workspaces.listDirectory.mockResolvedValueOnce({
      path: '/w', home: '/h', crumbs: [], entries: [], truncated: false,
    })
    await expect(injected.listLevel('/w')).resolves.toEqual({ dirs: [], files: [], truncated: false })

    // Either bound cut marks the level truncated.
    b.workspaces.listDirectory.mockResolvedValueOnce({
      path: '/w', home: '/h', crumbs: [], entries: [], truncated: true, files: [], filesTruncated: false,
    })
    await expect(injected.listLevel('/w')).resolves.toMatchObject({ truncated: true })
    b.workspaces.listDirectory.mockResolvedValueOnce({
      path: '/w', home: '/h', crumbs: [], entries: [], truncated: false, files: [], filesTruncated: true,
    })
    await expect(injected.listLevel('/w')).resolves.toMatchObject({ truncated: true })
  })

  it('maps host file reads onto previews without minting absent fields', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const injected = (b.slots.entries('sidebar.filetree')[0]!.inject as () => FileTreeInjected)()

    b.workspaces.readFile.mockResolvedValueOnce({ path: '/f', size: 10, kind: 'text', content: 'hi', truncated: false })
    const signal = new AbortController().signal
    await expect(injected.readFile('/f', signal)).resolves.toEqual({
      size: 10, kind: 'text', truncated: false, content: 'hi',
    })
    expect(b.workspaces.readFile).toHaveBeenCalledWith('/f', signal)

    b.workspaces.readFile.mockResolvedValueOnce({ path: '/f', size: 4, kind: 'binary', truncated: false })
    const binary = await injected.readFile('/f')
    expect(binary).toEqual({ size: 4, kind: 'binary', truncated: false })
    expect('content' in binary).toBe(false)
    expect('mime' in binary).toBe(false)

    b.workspaces.readFile.mockResolvedValueOnce({
      path: '/f', size: 8, kind: 'image', content: 'QQ==', mime: 'image/png', truncated: true,
    })
    await expect(injected.readFile('/f')).resolves.toEqual({
      size: 8, kind: 'image', truncated: true, content: 'QQ==', mime: 'image/png',
    })
  })

  it('hands openPath to the workspace service and swallows a refused hand-off', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const injected = (b.slots.entries('sidebar.filetree')[0]!.inject as () => FileTreeInjected)()

    injected.openPath('/open/me')
    expect(b.workspaces.openPath).toHaveBeenCalledWith('/open/me')

    b.workspaces.openPath.mockRejectedValueOnce(new Error('no opener'))
    injected.openPath('/open/refused')
    // Best-effort: the rejection settles without surfacing anywhere.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(b.workspaces.openPath).toHaveBeenLastCalledWith('/open/refused')
  })

  it('registers the filetree dictionaries and removes everything on teardown', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.locale.bind('filetree')('section.title')).toBe('文件')
    b.locale.setLocale('en')
    expect(b.locale.bind('filetree')('section.title')).toBe('Files')
    await fiber.dispose()
    expect(b.slots.entries('sidebar.filetree')).toHaveLength(0)
    // Dictionaries left with the fiber: lookups fall back to the raw key.
    expect(b.locale.bind('filetree')('section.title')).toBe('section.title')
  })
})
