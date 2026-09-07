#!/usr/bin/env node
/**
 * CI-side runtime prebuild for the file-tree installer.
 *
 * Reads every payload tarball from the given directories, installs them into a
 * temporary runtime/ exactly as the user-machine postinstall would, then packs
 * the assembled node_modules into one gzipped tar. The platform package ships
 * that tarball so user machines only extract it instead of running npm.
 *
 * Usage:
 *   node scripts/release/prebuild-runtime.mjs \
 *     --payload-dir dist/npm --payload-dir dist/npm-vendor --payload-dir dist/npm-landlock \
 *     --out dist/filetree-runtime-macos-arm64.tar.gz
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

function fail(message) {
  console.error(`prebuild-runtime: ${message}`)
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
}

const { values } = parseArgs({
  options: {
    'payload-dir': { type: 'string', multiple: true },
    out: { type: 'string' },
  },
  allowPositionals: false,
})

const payloadDirs = values['payload-dir'] ?? []
if (payloadDirs.length === 0 || values.out === undefined) {
  fail('usage: prebuild-runtime.mjs --payload-dir <dir> [--payload-dir <dir> …] --out <file.tar.gz>')
}

const tarballs = []
for (const directory of payloadDirs) {
  const absolute = resolve(directory)
  for (const filename of readdirSync(absolute).filter(file => file.endsWith('.tgz')).sort()) {
    tarballs.push({ path: join(absolute, filename), filename })
  }
}
if (tarballs.length === 0) fail('no payload tarballs found')

const worktree = mkdtempSync(join(tmpdir(), 'dsh-runtime-'))
const runtime = join(worktree, 'runtime')
const dependencies = Object.fromEntries(tarballs.map(entry => [entry.filename, `file:${entry.path}`]))
mkdirSync(runtime, { recursive: true })
writeFileSync(
  join(runtime, 'package.json'),
  `${JSON.stringify({ name: 'dsh-filetree-runtime', private: true, version: '0.0.0', dependencies }, null, 2)}\n`,
)

console.error(`prebuild-runtime: installing ${tarballs.length} payload packages`)
run('npm', ['install', '--prefix', runtime, '--package-lock=false', '--no-audit', '--no-fund'])

const out = resolve(values.out)
mkdirSync(out.slice(0, out.lastIndexOf('/')), { recursive: true })
rmSync(out, { force: true })
run('tar', ['-czf', out, '-C', runtime, 'node_modules'])
rmSync(worktree, { recursive: true, force: true })

const size = Number(readFileSync(out).byteLength / (1024 * 1024)).toFixed(1)
console.error(`prebuild-runtime: wrote ${out} (${size} MB)`)
