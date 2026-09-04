/** Published file-tree package contents exclude TypeScript source and source maps. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
  files?: unknown
}

describe('ui-file-tree package payload', () => {
  it('publishes only built entry points and declarations', () => {
    expect(manifest.files).toEqual([
      'lib/index.js',
      'lib/client.js',
      'lib/types/**/*.d.ts',
    ])
  })
})
