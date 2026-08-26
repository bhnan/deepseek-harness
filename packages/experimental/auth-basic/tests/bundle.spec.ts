/** The private auth bundle mounts itself before the Web application with environment-only credentials. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'

describe('experimental auth-basic bundle', () => {
  it('declares a self-mounting patch with environment-only credentials', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(parsed)) throw new TypeError('auth-basic patch must be a patch list')
    const rows = parsed.flatMap((patch): Record<string, unknown>[] =>
      typeof patch === 'object' && patch !== null
        ? (patch as { insert?: Record<string, unknown>[] }).insert ?? []
        : [],
    )
    expect(rows).toEqual([{
      id: 'auth-basic',
      name: '@deepseek-ai/dsh-experimental-auth-basic',
      inject: ['webServer'],
      config: {
        username: { __jsExpr: 'process.env.DSH_AUTH_BASIC_USERNAME' },
        password: { __jsExpr: 'process.env.DSH_AUTH_BASIC_PASSWORD' },
        sessionSecret: { __jsExpr: 'process.env.DSH_AUTH_BASIC_SESSION_SECRET' },
      },
    }])
  })
})
