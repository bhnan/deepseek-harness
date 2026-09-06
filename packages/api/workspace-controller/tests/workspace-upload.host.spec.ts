/** Host upload persistence, collision handling, and decoded byte integrity. */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { saveWorkspaceUpload } from '../src/workspace-upload.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-upload-'))
  roots.push(root)
  return root
}

describe('saveWorkspaceUpload', () => {
  it('keeps both distinct concurrent uploads that claim the same filename', async () => {
    const root = await workspace()
    const firstData = Buffer.from('first upload').toString('base64')
    const secondData = Buffer.from('second upload').toString('base64')

    const [first, second] = await Promise.all([
      saveWorkspaceUpload(root, { name: 'report.txt', data: firstData }),
      saveWorkspaceUpload(root, { name: 'report.txt', data: secondData }),
    ])

    expect(first.name).not.toBe(second.name)
    await expect(readFile(join(root, first.path), 'utf8')).resolves.toBe('first upload')
    await expect(readFile(join(root, second.path), 'utf8')).resolves.toBe('second upload')
  })
})
