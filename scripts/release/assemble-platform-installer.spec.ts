import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { assemblePlatformInstaller, createInstallerManifests, type PackedInstallerInput } from './assemble-platform-installer.ts'

const payload: PackedInstallerInput[] = [
  { name: '@deepseek-ai/dsh', version: '0.1.1-rc.2', filename: 'deepseek-ai-dsh-0.1.1-rc.2.tgz' },
  { name: '@deepseek-ai/cordis', version: '4.0.0', filename: 'deepseek-ai-cordis-4.0.0.tgz' },
  { name: '@deepseek-ai/node-addon-landlock-run', version: '0.1.1', filename: 'deepseek-ai-node-addon-landlock-run-0.1.1.tgz' },
]

const sourceVersion = '0.1.1-rc.2'
const installerVersion = '0.1.1-rc.2-bhn.0.1'

const roots: string[] = []

function packFixture(root: string, name: string, version: string): string {
  const packageRoot = join(root, name.replaceAll('/', '-'))
  mkdirSync(join(packageRoot, 'package'), { recursive: true })
  writeFileSync(join(packageRoot, 'package', 'package.json'), `${JSON.stringify({ name, version })}\n`)
  const tarball = join(root, `${name.replaceAll('/', '-')}-${version}.tgz`)
  execFileSync('tar', ['-czf', tarball, '-C', packageRoot, 'package'])
  return tarball
}

describe('platform installer manifests', () => {
  it('creates an entry package and a platform package with matching versions', () => {
    const manifests = createInstallerManifests({
      namespace: 'bhnan',
      version: installerVersion,
      sourceVersion,
      platform: 'macos-arm64',
      payload,
    })

    expect(manifests.entry).toMatchObject({
      name: '@bhnan/dsh-filetree',
      version: installerVersion,
      bin: { dsh: 'bin/dsh.mjs' },
      optionalDependencies: {
        '@bhnan/dsh-filetree-macos-arm64': installerVersion,
        '@bhnan/dsh-filetree-linux-x64': installerVersion,
      },
    })
    expect(manifests.platform).toMatchObject({
      name: '@bhnan/dsh-filetree-macos-arm64',
      version: installerVersion,
      os: ['darwin'],
      cpu: ['arm64'],
      bin: { dsh: 'bin/dsh.mjs' },
      files: ['bin', 'payload', 'scripts', 'README.md'],
    })
    expect(manifests.payloadIndex).toEqual(Object.fromEntries(payload.map(entry => [entry.name, entry.filename])))
  })

  it('rejects unsupported platforms, invalid scopes, version drift, and missing dsh entry', () => {
    expect(() => createInstallerManifests({ namespace: 'Bhnan', version: installerVersion, sourceVersion, platform: 'macos-arm64', payload })).toThrow(/lowercase/)
    expect(() => createInstallerManifests({ namespace: 'bhnan', version: 'latest', sourceVersion, platform: 'macos-arm64', payload })).toThrow(/version/)
    expect(() => createInstallerManifests({ namespace: 'bhnan', version: installerVersion, sourceVersion: 'latest', platform: 'macos-arm64', payload })).toThrow(/version/)
    expect(() => createInstallerManifests({ namespace: 'bhnan', version: installerVersion, sourceVersion, platform: 'windows-x64', payload })).toThrow(/platform/)
    expect(() => createInstallerManifests({ namespace: 'bhnan', version: installerVersion, sourceVersion, platform: 'macos-arm64', payload: payload.slice(1) })).toThrow(/@deepseek-ai\/dsh/)
    expect(() => createInstallerManifests({
      namespace: 'bhnan',
      version: installerVersion,
      sourceVersion: '0.1.1-rc.3',
      platform: 'macos-arm64',
      payload,
    })).toThrow(/source version/)
    expect(() => createInstallerManifests({
      namespace: 'bhnan',
      version: installerVersion,
      sourceVersion,
      platform: 'macos-arm64',
      payload: [...payload, payload[0]!],
    })).toThrow(/duplicate/)
  })

  it('writes deterministic entry and platform staging directories from pack outputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-installer-'))
    roots.push(root)
    const dsh = mkdtempSync(join(root, 'dsh-'))
    const vendor = mkdtempSync(join(root, 'vendor-'))
    const landlock = mkdtempSync(join(root, 'landlock-'))
    roots.push(dsh, vendor, landlock)
    packFixture(dsh, '@deepseek-ai/dsh', '0.1.1-rc.2')
    packFixture(vendor, '@deepseek-ai/cordis', '4.0.0')
    packFixture(landlock, '@deepseek-ai/node-addon-landlock-run', '0.1.1')
    const out = join(root, 'out')

    assemblePlatformInstaller({ namespace: 'bhnan', version: installerVersion, sourceVersion, dsh, vendor, landlock, out })

    const entry = JSON.parse(readFileSync(join(out, 'entry', 'package.json'), 'utf8')) as Record<string, unknown>
    const mac = JSON.parse(readFileSync(join(out, 'macos-arm64', 'package.json'), 'utf8')) as Record<string, unknown>
    expect(entry.name).toBe('@bhnan/dsh-filetree')
    expect(entry.version).toBe(installerVersion)
    expect(mac.name).toBe('@bhnan/dsh-filetree-macos-arm64')
    expect(mac.version).toBe(installerVersion)
    expect(readFileSync(join(out, 'macos-arm64', 'payload', 'index.json'), 'utf8')).toContain('@deepseek-ai/dsh')
    expect(readFileSync(join(out, 'macos-arm64', 'scripts', 'postinstall.mjs'), 'utf8')).toContain("['install', '--prefix'")
    const entryLauncher = readFileSync(join(out, 'entry', 'bin', 'dsh.mjs'), 'utf8')
    const platformLauncher = readFileSync(join(out, 'linux-x64', 'bin', 'dsh.mjs'), 'utf8')
    expect(entryLauncher).toContain('@bhnan/dsh-filetree-linux-x64')
    expect(entryLauncher).toMatch(/^#!\/usr\/bin\/env node\n/)
    expect(platformLauncher).toMatch(/^#!\/usr\/bin\/env node\n/)
    expect(() => execFileSync(process.execPath, ['--check', join(out, 'entry', 'bin', 'dsh.mjs')])).not.toThrow()
    expect(() => execFileSync(process.execPath, ['--check', join(out, 'linux-x64', 'bin', 'dsh.mjs')])).not.toThrow()
  })
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('platform installer with prebuilt runtime', () => {
  it('ships runtime.tar.gz, a tar-extracting postinstall, and leaves the entry package untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-installer-runtime-'))
    roots.push(root)
    const dsh = mkdtempSync(join(root, 'dsh-'))
    const vendor = mkdtempSync(join(root, 'vendor-'))
    const landlock = mkdtempSync(join(root, 'landlock-'))
    packFixture(dsh, '@deepseek-ai/dsh', '0.1.1-rc.2')
    packFixture(vendor, '@deepseek-ai/cordis', '4.0.0')
    packFixture(landlock, '@deepseek-ai/node-addon-landlock-run', '0.1.1')

    // 预构建的 runtime bundle: 一个装着 node_modules 的 tar.gz（用真实 tar 打包 fixture）。
    const runtimeDir = join(root, 'runtime-src')
    mkdirSync(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    writeFileSync(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'export {}\n')
    const runtimeTarball = join(root, 'runtime.tar.gz')
    execFileSync('tar', ['-czf', runtimeTarball, '-C', runtimeDir, 'node_modules'])

    assemblePlatformInstaller({
      namespace: 'bhnan',
      version: installerVersion,
      sourceVersion,
      dsh,
      vendor,
      landlock,
      out: join(root, 'out'),
      runtimeTarballs: { 'macos-arm64': runtimeTarball },
    })

    const macos = join(root, 'out', 'macos-arm64')
    expect(existsSync(join(macos, 'runtime.tar.gz'))).toBe(true)
    const manifest = JSON.parse(readFileSync(join(macos, 'package.json'), 'utf8'))
    expect(manifest.files).toContain('runtime.tar.gz')

    const postinstall = readFileSync(join(macos, 'scripts', 'postinstall.mjs'), 'utf8')
    expect(postinstall).toContain("join(packageRoot, 'runtime.tar.gz')")
    expect(postinstall).toContain("'-xzf'")

    // linux 侧未提供 runtime tarball → 保持原 npm install 行为。
    const linuxPostinstall = readFileSync(join(root, 'out', 'linux-x64', 'scripts', 'postinstall.mjs'), 'utf8')
    expect(linuxPostinstall).toContain("'install', '--prefix', runtime")
    const linuxManifest = JSON.parse(readFileSync(join(root, 'out', 'linux-x64', 'package.json'), 'utf8'))
    expect(linuxManifest.files).not.toContain('runtime.tar.gz')

    const entry = JSON.parse(readFileSync(join(root, 'out', 'entry', 'package.json'), 'utf8'))
    expect(entry.files).toEqual(['bin', 'README.md'])
  })

  it('postinstall extracts the prebuilt bundle instead of running npm', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-installer-runtime-'))
    roots.push(root)
    const dsh = mkdtempSync(join(root, 'dsh-'))
    const vendor = mkdtempSync(join(root, 'vendor-'))
    const landlock = mkdtempSync(join(root, 'landlock-'))
    packFixture(dsh, '@deepseek-ai/dsh', '0.1.1-rc.2')
    packFixture(vendor, '@deepseek-ai/cordis', '4.0.0')
    packFixture(landlock, '@deepseek-ai/node-addon-landlock-run', '0.1.1')

    const runtimeDir = join(root, 'runtime-src')
    mkdirSync(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    writeFileSync(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'export {}\n')
    const runtimeTarball = join(root, 'runtime.tar.gz')
    execFileSync('tar', ['-czf', runtimeTarball, '-C', runtimeDir, 'node_modules'])

    assemblePlatformInstaller({
      namespace: 'bhnan',
      version: installerVersion,
      sourceVersion,
      dsh,
      vendor,
      landlock,
      out: join(root, 'out'),
      runtimeTarballs: { 'macos-arm64': runtimeTarball },
    })

    // 在真实临时目录里执行生成的 postinstall（等价于用户机器 npm install 时的行为）。
    const stage = mkdtempSync(join(tmpdir(), 'dsh-installer-stage-'))
    roots.push(stage)
    execFileSync('cp', ['-a', `${join(root, 'out', 'macos-arm64')}/.`, stage])
    execFileSync('node', [join(stage, 'scripts', 'postinstall.mjs')])

    expect(existsSync(join(stage, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))).toBe(true)
    expect(existsSync(join(stage, 'runtime', '.runtime-stamp'))).toBe(true)

    // 幂等: 重复执行直接跳过（stamp 命中），不重复解压也不报错。
    execFileSync('node', [join(stage, 'scripts', 'postinstall.mjs')])
    expect(existsSync(join(stage, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))).toBe(true)
  })
})
