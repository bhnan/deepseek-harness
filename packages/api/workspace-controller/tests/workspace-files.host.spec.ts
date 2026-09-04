import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import WorkspaceController from '../src/index.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

interface WorkspaceFilesRemote {
  list(path: string, signal: AbortSignal): Promise<unknown>
  read(path: string, signal: AbortSignal): Promise<unknown>
}

async function harness() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-workspace-files-')))
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(WorkspaceRegistry)
  const dispose = (): void => {}
  ctx.provide('typert', {
    lookups: { configure: () => dispose },
    contexts: { configureHost: () => dispose },
  } as never)
  await ctx.plugin(WorkspaceController).await()
  return { ctx, root }
}

describe('workspaceFiles list Remote', () => {
  it('lists sorted direct directories and files from the Host filesystem', async () => {
    const { ctx, root } = await harness()
    mkdirSync(join(root, 'zebra'))
    mkdirSync(join(root, 'alpha'))
    writeFileSync(join(root, 'z.txt'), 'z')
    writeFileSync(join(root, 'a.txt'), 'a')

    const files = ctx.get('workspaceFilesController') as WorkspaceFilesRemote | undefined
    expect(files).toBeDefined()
    await expect(files!.list(root, new AbortController().signal)).resolves.toEqual({
      dirs: [
        { name: 'alpha', path: join(root, 'alpha'), hidden: false },
        { name: 'zebra', path: join(root, 'zebra'), hidden: false },
      ],
      files: [
        { name: 'a.txt', path: join(root, 'a.txt'), hidden: false },
        { name: 'z.txt', path: join(root, 'z.txt'), hidden: false },
      ],
      dirsTruncated: false,
      filesTruncated: false,
    })
  })

  it('bounds directory and file windows independently', async () => {
    const { ctx, root } = await harness()
    for (let index = 0; index <= 1000; index++) {
      const name = String(index).padStart(4, '0')
      mkdirSync(join(root, `dir-${name}`))
      writeFileSync(join(root, `file-${name}.txt`), name)
    }

    const files = ctx.get('workspaceFilesController') as WorkspaceFilesRemote | undefined
    const listed = await files!.list(root, new AbortController().signal) as {
      dirs: Array<{ name: string }>
      files: Array<{ name: string }>
      dirsTruncated: boolean
      filesTruncated: boolean
    }
    expect(listed.dirsTruncated).toBe(true)
    expect(listed.filesTruncated).toBe(true)
    expect(listed.dirs).toHaveLength(1000)
    expect(listed.files).toHaveLength(1000)
    expect(listed.dirs[0]?.name).toBe('dir-0000')
    expect(listed.dirs.at(-1)?.name).toBe('dir-0999')
    expect(listed.files[0]?.name).toBe('file-0000.txt')
    expect(listed.files.at(-1)?.name).toBe('file-0999.txt')
  })

  it('follows directory symlinks but does not expose file symlinks', async () => {
    const { ctx, root } = await harness()
    const target = join(root, 'target')
    mkdirSync(target)
    writeFileSync(join(root, 'real.txt'), 'real')
    symlinkSync(target, join(root, 'linked-dir'))
    symlinkSync(join(root, 'real.txt'), join(root, 'linked-file'))

    const files = ctx.get('workspaceFilesController') as WorkspaceFilesRemote | undefined
    await expect(files!.list(root, new AbortController().signal)).resolves.toMatchObject({
      dirs: [{ name: 'linked-dir', path: join(root, 'linked-dir'), hidden: false }, { name: 'target' }],
      files: [{ name: 'real.txt', path: join(root, 'real.txt'), hidden: false }],
    })
  })
})

describe('workspaceFiles read Remote', () => {
  it('returns only the bounded UTF-8 head of a large text file', async () => {
    const { ctx, root } = await harness()
    const path = join(root, 'large.txt')
    const content = 'a'.repeat(256 * 1024 + 1)
    writeFileSync(path, content)

    const files = ctx.get('workspaceFilesController') as WorkspaceFilesRemote | undefined
    await expect(files!.read(path, new AbortController().signal)).resolves.toEqual({
      path,
      size: content.length,
      kind: 'text',
      content: content.slice(0, 256 * 1024),
      truncated: true,
    })
  })

  it('returns a recognised small image as base64 with its MIME type', async () => {
    const { ctx, root } = await harness()
    const path = join(root, 'diagram.png')
    writeFileSync(path, Buffer.from('PNG'))

    const files = ctx.get('workspaceFilesController') as WorkspaceFilesRemote | undefined
    await expect(files!.read(path, new AbortController().signal)).resolves.toEqual({
      path,
      size: 3,
      kind: 'image',
      content: 'UE5H',
      mime: 'image/png',
      truncated: false,
    })
  })

  it('declines binary bytes without sending file content to the browser', async () => {
    const { ctx, root } = await harness()
    const path = join(root, 'opaque.dat')
    writeFileSync(path, Buffer.from([0x66, 0x00, 0x6f]))

    const files = ctx.get('workspaceFilesController') as WorkspaceFilesRemote | undefined
    await expect(files!.read(path, new AbortController().signal)).resolves.toEqual({
      path,
      size: 3,
      kind: 'binary',
      truncated: false,
    })
  })

  it('declines a recognised image above the whole-image bound', async () => {
    const { ctx, root } = await harness()
    const path = join(root, 'oversized.png')
    writeFileSync(path, Buffer.alloc(8 * 1024 * 1024 + 1))

    const files = ctx.get('workspaceFilesController') as WorkspaceFilesRemote | undefined
    await expect(files!.read(path, new AbortController().signal)).resolves.toEqual({
      path,
      size: 8 * 1024 * 1024 + 1,
      kind: 'binary',
      truncated: false,
    })
  })
})
