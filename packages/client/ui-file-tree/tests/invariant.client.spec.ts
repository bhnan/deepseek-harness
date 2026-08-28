import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as FileTreeInvariant from '@deepseek-ai/dsh-client-ui-file-tree/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(FileTreeInvariant).await()).resolves.toBeDefined()
  })

  it('node-half apply is a no-op host placeholder', async () => {
    const { apply } = await import('../src/index.ts')
    apply()
    expect(true).toBe(true) // reaching here without throw is the contract
  })
})
