import { lstat, mkdtemp, readFile, symlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKSPACE_UPLOAD_MAX_BYTES,
  saveWorkspaceUpload,
} from '../src/workspace-upload.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true }))
  }
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-upload-'))
  roots.push(root)
  return root
}

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

describe('saveWorkspaceUpload', () => {
  it('stores a valid upload below uploads and returns workspace-relative metadata', async () => {
    const root = await workspace()
    const data = new TextEncoder().encode('hello workspace')

    const result = await saveWorkspaceUpload(root, {
      name: 'report.txt',
      mediaType: 'text/plain',
      data: Buffer.from(data).toString('base64'),
    })

    expect(result).toEqual({
      path: 'uploads/report.txt',
      name: 'report.txt',
      bytes: data.byteLength,
      sha256: digest(data),
      mediaType: 'text/plain',
    })
    expect(await readFile(join(root, result.path))).toEqual(Buffer.from(data))
    expect((await lstat(join(root, 'uploads'))).isDirectory()).toBe(true)
  })

  it('accepts an empty file and omits an empty media type', async () => {
    const root = await workspace()

    const result = await saveWorkspaceUpload(root, {
      name: 'empty.bin',
      mediaType: '',
      data: '',
    })

    expect(result).toEqual({
      path: 'uploads/empty.bin',
      name: 'empty.bin',
      bytes: 0,
      sha256: digest(new Uint8Array()),
    })
  })

  it('rejects malformed base64, empty names, and payloads above the limit', async () => {
    const root = await workspace()

    await expect(saveWorkspaceUpload(root, { name: 'bad.txt', data: 'not base64!' }))
      .rejects.toThrow(/base64/i)
    await expect(saveWorkspaceUpload(root, { name: '', data: '' }))
      .rejects.toThrow(/name/i)
    await expect(saveWorkspaceUpload(root, {
      name: 'large.bin',
      data: Buffer.alloc(9).toString('base64'),
    }, 8))
      .rejects.toThrow(/limit/i)
    expect(DEFAULT_WORKSPACE_UPLOAD_MAX_BYTES).toBe(32 * 1024 * 1024)
  })

  it('normalizes path separators and control characters without escaping the workspace', async () => {
    const root = await workspace()
    const data = new TextEncoder().encode('safe')

    const result = await saveWorkspaceUpload(root, {
      name: '../nested\\report\u0000.txt',
      data: Buffer.from(data).toString('base64'),
    })

    expect(result.path).toMatch(/^uploads\/[.]{2}_nested_report_\.txt$/u)
    expect(await readFile(join(root, result.path))).toEqual(Buffer.from(data))
    expect(await readFile(join(root, '..', result.name)).catch(() => null)).toBeNull()
  })

  it('refuses an uploads symlink', async () => {
    const root = await workspace()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-workspace-upload-outside-'))
    roots.push(outside)
    await symlink(outside, join(root, 'uploads'), 'dir')

    await expect(saveWorkspaceUpload(root, { name: 'escape.txt', data: 'YQ==' }))
      .rejects.toThrow(/symlink|directory/i)
  })

  it('uses a short digest suffix for a different collision and reuses identical content', async () => {
    const root = await workspace()
    const first = new TextEncoder().encode('one')
    const second = new TextEncoder().encode('two')

    const original = await saveWorkspaceUpload(root, {
      name: 'same.txt', data: Buffer.from(first).toString('base64'),
    })
    const different = await saveWorkspaceUpload(root, {
      name: 'same.txt', data: Buffer.from(second).toString('base64'),
    })
    const repeated = await saveWorkspaceUpload(root, {
      name: 'same.txt', data: Buffer.from(second).toString('base64'),
    })

    expect(original.path).toBe('uploads/same.txt')
    expect(different.path).toBe(`uploads/same-${digest(second).slice(0, 8)}.txt`)
    expect(repeated).toEqual(different)
  })
})
