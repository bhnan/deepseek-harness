# Agent Note: Private platform installer for the file-tree runtime

Status: implemented

English | [中文](2026-08-27-private-filetree-installer.zh.md)

## Problem

The file-tree runtime contains platform-sensitive native code and a large internal package graph, while users need one install command on macOS Apple Silicon and Linux x64.

## Decision

The release workflow builds one platform-neutral `@bhnan/dsh-filetree` package and two optional platform packages: `@bhnan/dsh-filetree-macos-arm64` and `@bhnan/dsh-filetree-linux-x64`. Each platform package carries the packed DSH, vendored Cordis, and Landlock tarballs, then assembles a private runtime during npm `postinstall`. The entry and platform launchers carry Node shebangs so npm's generated bin links execute them directly. The entry launcher selects the platform package and delegates to the assembled runtime. GitHub Actions builds both targets; publication is a manual input and uses `GITHUB_TOKEN` with `packages: write`.

## Alternatives considered

**Publish every internal package as a second scoped family.** This exposes the repository's internal package graph and requires coordinated rescoping and dependency rewriting; the payload approach keeps the public install surface to three packages.

**Ship one universal package.** A universal package would include incompatible native payloads and would not let npm prevent installation on unsupported operating systems or CPUs.

## Consequences

The platform packages are larger because they contain packed dependencies, and installation performs a local npm install from those tarballs. Consumers need a classic GitHub token with `read:packages`; maintainers enable publication explicitly in the workflow. The supported host set is intentionally limited to macOS arm64 and Linux x64.
