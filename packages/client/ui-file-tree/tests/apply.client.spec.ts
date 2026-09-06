/** File-tree plugin wiring: host entry, dependencies, locale, and sidebar registration. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { FileTreePanel } from '../src/client/FileTreePanel.tsx'
import { en, zh } from '../src/client/locales.ts'
import { apply as hostApply } from '../src/index.ts'

/** Build only the client services this plugin consumes. */
async function bench(): Promise<{ ctx: Context; slots: SlotRegistry }> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const workspaceFiles = {
    list: () => Promise.resolve({ ok: true as const, value: {} }),
    read: () => Promise.resolve({ ok: true as const, value: {} }),
  }
  const session = { openWorkspacePath: () => Promise.resolve({ ok: true as const, value: undefined }) }
  ctx.provide('remote', { workspaceFiles, session } as never)
  ctx.provide('remote.workspaceFiles', workspaceFiles as never)
  ctx.provide('remote.session', session as never)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { sidebar: { kind: 'single', scope: 'root' } } } as never, () => null)
  slots.register({ name: 'sidebar', children: { 'sidebar.filetree': { kind: 'single', scope: 'root' } } } as never, () => null)
  return { ctx, slots }
}

describe('ui-file-tree apply', () => {
  it('keeps the Host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the Remote and locale dependencies it uses', () => {
    expect(inject).toEqual(['slots', 'remote', 'remote.workspaceFiles', 'remote.session', 'locale'])
  })

  it('registers the sidebar occupant and matching locale dictionaries', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject, apply }).await()

    const entry = slots.entries('sidebar.filetree')[0]
    expect(entry?.component).toBe(FileTreePanel)
    expect(entry?.locale).toBe('filetree')
    expect(Object.keys(en)).toEqual(Object.keys(zh))
    await ctx.fiber.dispose()
  })
})
