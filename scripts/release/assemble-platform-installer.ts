/** Assemble the private, platform-selecting npm installer for the file-tree build. */

import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isEntry } from './process.ts'
import { packedIdentity, type PackedIdentity } from './tarball.ts'

/** Supported installer targets. */
export type InstallerPlatform = 'macos-arm64' | 'linux-x64'

/** Identity of one tarball included in a platform payload. */
export interface PackedInstallerInput extends PackedIdentity {
  /** Filename relative to the payload directory. */
  readonly filename: string
}

/** Inputs accepted by the pure manifest builder. */
export interface InstallerManifestOptions {
  /** GitHub user or organization that owns the npm scope, without `@`. */
  readonly namespace: string
  /** Shared release version of the DSH family. */
  readonly version: string
  /** Target platform package to generate. */
  readonly platform: string
  /** Tarballs that the platform runtime installs. */
  readonly payload: readonly PackedInstallerInput[]
}

/** Generated manifests and the deterministic payload index. */
export interface InstallerManifests {
  /** User-facing platform-neutral package manifest. */
  readonly entry: Record<string, unknown>
  /** Platform-specific package manifest. */
  readonly platform: Record<string, unknown>
  /** Package name to payload filename mapping. */
  readonly payloadIndex: Record<string, string>
}

interface PlatformMetadata {
  readonly os: readonly string[]
  readonly cpu: readonly string[]
}

const PLATFORMS: Readonly<Record<InstallerPlatform, PlatformMetadata>> = {
  'macos-arm64': { os: ['darwin'], cpu: ['arm64'] },
  'linux-x64': { os: ['linux'], cpu: ['x64'] },
}

const PACKAGE_SUFFIX = {
  entry: 'dsh-filetree',
  'macos-arm64': 'dsh-filetree-macos-arm64',
  'linux-x64': 'dsh-filetree-linux-x64',
} as const

/** Validate a package namespace accepted by GitHub's npm registry. */
function validateNamespace(namespace: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(namespace)) {
    throw new Error(`installer namespace ${JSON.stringify(namespace)} must be lowercase alphanumeric npm scope text`)
  }
}

/** Validate a release version without adding a runtime dependency on semver. */
function validateVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`installer version ${JSON.stringify(version)} is not a publishable semver version`)
  }
}

/** Return the package name for one platform target. */
function platformPackageName(namespace: string, platform: InstallerPlatform): string {
  return `@${namespace}/${PACKAGE_SUFFIX[platform]}`
}

/** Build an npm manifest without touching the filesystem. */
export function createInstallerManifests(options: InstallerManifestOptions): InstallerManifests {
  validateNamespace(options.namespace)
  validateVersion(options.version)
  if (!Object.hasOwn(PLATFORMS, options.platform)) {
    throw new Error(`installer platform ${JSON.stringify(options.platform)} is unsupported`)
  }
  const validatedPlatform = options.platform as InstallerPlatform
  const metadata = PLATFORMS[validatedPlatform]

  const seen = new Set<string>()
  const payloadIndex: Record<string, string> = {}
  for (const input of options.payload) {
    if (seen.has(input.name)) throw new Error(`installer payload contains duplicate package ${input.name}`)
    if (input.filename === '' || input.filename.includes('/') || input.filename.includes('\\')) {
      throw new Error(`installer payload filename ${JSON.stringify(input.filename)} is invalid`)
    }
    seen.add(input.name)
    payloadIndex[input.name] = input.filename
  }
  const dsh = options.payload.find(input => input.name === '@deepseek-ai/dsh')
  if (dsh === undefined) throw new Error('installer payload must contain @deepseek-ai/dsh')
  if (dsh.version !== options.version) {
    throw new Error(`installer DSH version ${dsh.version} does not match installer version ${options.version}`)
  }

  const platformName = platformPackageName(options.namespace, validatedPlatform)
  const entry: Record<string, unknown> = {
    name: `@${options.namespace}/${PACKAGE_SUFFIX.entry}`,
    version: options.version,
    description: 'DeepSeek Harness file-tree installer',
    repository: { type: 'git', url: 'git+https://github.com/bhnan/deepseek-harness.git' },
    type: 'module',
    bin: { dsh: 'bin/dsh.mjs' },
    files: ['bin', 'README.md'],
    optionalDependencies: {
      [platformPackageName(options.namespace, 'macos-arm64')]: options.version,
      [platformPackageName(options.namespace, 'linux-x64')]: options.version,
    },
    engines: { node: '>=22.19.0' },
    license: 'MIT',
    publishConfig: { registry: 'https://npm.pkg.github.com', access: 'restricted' },
  }
  const platform: Record<string, unknown> = {
    name: platformName,
    version: options.version,
    description: `DeepSeek Harness file-tree runtime for ${options.platform}`,
    repository: { type: 'git', url: 'git+https://github.com/bhnan/deepseek-harness.git' },
    type: 'module',
    os: [...metadata.os],
    cpu: [...metadata.cpu],
    bin: { dsh: 'bin/dsh.mjs' },
    files: ['bin', 'payload', 'scripts', 'README.md'],
    scripts: { postinstall: 'node scripts/postinstall.mjs' },
    engines: { node: '>=22.19.0' },
    license: 'MIT',
    publishConfig: { registry: 'https://npm.pkg.github.com', access: 'restricted' },
  }
  return { entry, platform, payloadIndex }
}

/** Read every tarball in a pack directory and return its identities. */
function readPayloadDirectories(directories: readonly string[]): Array<{ path: string; input: PackedInstallerInput }> {
  const result: Array<{ path: string; input: PackedInstallerInput }> = []
  for (const directory of directories) {
    const files = readdirSync(directory).filter(filename => filename.endsWith('.tgz')).sort()
    if (files.length === 0) throw new Error(`${directory} contains no npm tarballs`)
    for (const filename of files) {
      const path = join(directory, filename)
      result.push({ path, input: { ...packedIdentity(path), filename } })
    }
  }
  return result
}

/** Write a file and make a generated launcher executable. */
function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}

/** Generate the platform runtime bootstrap script. */
function postinstallSource(platform: InstallerPlatform): string {
  return `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const expected = ${JSON.stringify(PLATFORMS[platform])}
if (process.platform !== expected.os[0] || process.arch !== expected.cpu[0]) {
  throw new Error('This installer package was selected for ' + expected.os[0] + '/' + expected.cpu[0] + ', but the host is ' + process.platform + '/' + process.arch)
}
const payload = JSON.parse(readFileSync(join(packageRoot, 'payload', 'index.json'), 'utf8'))
const runtime = join(packageRoot, 'runtime')
mkdirSync(runtime, { recursive: true })
const dependencies = Object.fromEntries(Object.entries(payload).map(([name, filename]) => [name, 'file:../payload/' + filename]))
writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: 'dsh-filetree-runtime', private: true, version: '0.0.0', dependencies }, null, 2) + '\\n')
const result = spawnSync('npm', ['install', '--prefix', runtime, '--package-lock=false', '--no-audit', '--no-fund'], { stdio: 'inherit', env: process.env })
if (result.error !== undefined) throw result.error
if (result.status !== 0) throw new Error('npm failed while assembling the DeepSeek Harness runtime with exit code ' + String(result.status))
`
}

/** Generate the entry and platform launcher scripts. */
function launcherSources(namespace: string): { entry: string; platform: string } {
  const entry = `#!/usr/bin/env node
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const target = process.platform === 'darwin' && process.arch === 'arm64'
  ? '${platformPackageName(namespace, 'macos-arm64')}'
  : process.platform === 'linux' && process.arch === 'x64'
    ? '${platformPackageName(namespace, 'linux-x64')}'
    : undefined
if (target === undefined) throw new Error('Unsupported host platform. Supported targets are macOS arm64 and Linux x64.')
let packageRoot
try {
  packageRoot = dirname(require.resolve(target + '/package.json'))
} catch {
  throw new Error('The platform package ' + target + ' is not installed. Reinstall @${namespace}/${PACKAGE_SUFFIX.entry} without --omit=optional.')
}
const result = spawnSync(process.execPath, [join(packageRoot, 'bin', 'dsh.mjs'), ...process.argv.slice(2)], { stdio: 'inherit', env: process.env })
if (result.error !== undefined) throw result.error
if (result.signal !== null) process.kill(process.pid, result.signal)
process.exit(result.status ?? 1)
`
  const platformLauncher = `#!/usr/bin/env node
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const executable = join(packageRoot, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const result = spawnSync(process.execPath, [executable, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env })
if (result.error !== undefined) throw result.error
if (result.signal !== null) process.kill(process.pid, result.signal)
process.exit(result.status ?? 1)
`
  return { entry, platform: platformLauncher }
}

/** Write package metadata, payload, README, and launchers into one staging root. */
function writeStagingPackage(
  path: string,
  manifest: Record<string, unknown>,
  payloadFiles: readonly { path: string; input: PackedInstallerInput }[],
  index: Record<string, string>,
  launcher: string,
  postinstall: string | undefined,
  readme: string,
): void {
  mkdirSync(join(path, 'bin'), { recursive: true })
  writeFileSync(join(path, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(path, 'README.md'), `${readme.trimEnd()}\n`)
  writeExecutable(join(path, 'bin', 'dsh.mjs'), launcher)
  if (postinstall !== undefined) {
    mkdirSync(join(path, 'scripts'), { recursive: true })
    writeExecutable(join(path, 'scripts', 'postinstall.mjs'), postinstall)
    mkdirSync(join(path, 'payload'), { recursive: true })
    for (const payloadFile of payloadFiles) copyFileSync(payloadFile.path, join(path, 'payload', payloadFile.input.filename))
    writeFileSync(join(path, 'payload', 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
  }
}

/** Assemble both platform packages and the shared entry package. */
export function assemblePlatformInstaller(options: {
  namespace: string
  version: string
  dsh: string
  vendor: string
  landlock: string
  out: string
}): void {
  const root = resolve(options.out)
  const payloadFiles = readPayloadDirectories([resolve(options.dsh), resolve(options.vendor), resolve(options.landlock)])
  const payload = payloadFiles.map(entry => entry.input)
  const entryManifests = createInstallerManifests({ namespace: options.namespace, version: options.version, platform: 'macos-arm64', payload })
  const linuxManifests = createInstallerManifests({ namespace: options.namespace, version: options.version, platform: 'linux-x64', payload })
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const entryReadme = `# @${options.namespace}/${PACKAGE_SUFFIX.entry}\n\nInstall the DeepSeek Harness file-tree runtime on macOS Apple Silicon or Linux x64. Configure @${options.namespace}:registry=https://npm.pkg.github.com and a GitHub token with read:packages before installing.\n`
  const platformReadme = `# DeepSeek Harness platform runtime\n\nThis package is selected by @${options.namespace}/${PACKAGE_SUFFIX.entry} for its declared operating system and CPU.\n`
  const launchers = launcherSources(options.namespace)
  writeStagingPackage(join(root, 'entry'), entryManifests.entry, [], {}, launchers.entry, undefined, entryReadme)
  writeStagingPackage(
    join(root, 'macos-arm64'),
    entryManifests.platform,
    payloadFiles,
    entryManifests.payloadIndex,
    launchers.platform,
    postinstallSource('macos-arm64'),
    platformReadme,
  )
  const linuxLaunchers = launcherSources(options.namespace)
  writeStagingPackage(
    join(root, 'linux-x64'),
    linuxManifests.platform,
    payloadFiles,
    linuxManifests.payloadIndex,
    linuxLaunchers.platform,
    postinstallSource('linux-x64'),
    platformReadme,
  )
  console.log(`release assemble-installer: wrote entry and 2 platform packages to ${options.out}`)
}

/** Parse CLI arguments for the release workflow. */
function main(): void {
  const { values } = parseArgs({
    options: {
      namespace: { type: 'string' }, version: { type: 'string' }, dsh: { type: 'string' },
      vendor: { type: 'string' }, landlock: { type: 'string' }, out: { type: 'string' },
    },
    allowPositionals: false,
  })
  const required = ['namespace', 'version', 'dsh', 'vendor', 'landlock', 'out'] as const
  for (const key of required) {
    if (values[key] === undefined) {
      throw new Error(
        'usage: assemble-platform-installer.ts --namespace <name> --version <version> '
        + '--dsh <dir> --vendor <dir> --landlock <dir> --out <dir>',
      )
    }
  }
  const value = (key: (typeof required)[number]): string => values[key] as string
  assemblePlatformInstaller({
    namespace: value('namespace'),
    version: value('version'),
    dsh: value('dsh'),
    vendor: value('vendor'),
    landlock: value('landlock'),
    out: value('out'),
  })
}

if (isEntry(import.meta.url)) main()
