# Agent Note: Private platform installer for the file-tree runtime

Status: implemented

[English](2026-08-27-private-filetree-installer.md) | 中文

## Problem

文件树运行时包含平台相关的原生代码和较大的内部包图，但用户需要在 macOS Apple Silicon 与 Linux x64 上使用一个安装命令。

## Decision

发布流程构建一个平台无关的 `@bhnan/dsh-filetree` 包，以及两个可选的平台包：`@bhnan/dsh-filetree-macos-arm64` 和 `@bhnan/dsh-filetree-linux-x64`。每个平台包携带打包后的 DSH、vendored Cordis 与 Landlock tarball，并在 npm `postinstall` 中组装私有运行时。入口 launcher 选择平台包，再转交给组装后的运行时。GitHub Actions 构建两个目标；发布由手动输入控制，并使用具备 `packages: write` 权限的 `GITHUB_TOKEN`。

## Alternatives considered

**把所有内部包作为第二套 scope 发布。** 这会暴露仓库内部包图，并要求统一重命名和改写依赖；payload 方案把公开安装面保持为三个包。

**发布一个通用包。** 通用包会包含互不兼容的原生 payload，也无法让 npm 阻止不支持的操作系统或 CPU 安装。

## Consequences

平台包因携带打包依赖而更大，安装时会从这些 tarball 执行一次本地 npm install。使用者需要带有 `read:packages` 的 classic GitHub token；维护者显式开启 workflow 发布。支持的主机范围明确限制为 macOS arm64 与 Linux x64。
