# GitHub 平台安装包设计

[English](2026-08-27-github-platform-installer-design.md) | 中文

## 目标

发布私有 GitHub Packages npm 安装包，用户执行 `npm install -g @bhnan/dsh-filetree` 后，可在 macOS Apple Silicon 或 Linux x64 上使用当前文件树运行时。

## 架构

分发包含一个入口包和两个平台包。入口包声明两个可选平台依赖；平台包声明各自的 `os` 与 `cpu`，并携带 DSH、vendored Cordis 和 Landlock tarball，在 `postinstall` 中组装私有运行时。入口命令解析兼容的平台包并转交 launcher。安装包版本在 DSH 源版本后追加私有修订号，例如 `0.1.1-rc.2-bhn.0.1`，而内嵌的 DSH payload 保留 `0.1.1-rc.2`。

- `@bhnan/dsh-filetree` 负责入口命令
- `@bhnan/dsh-filetree-macos-arm64` 负责 macOS arm64
- `@bhnan/dsh-filetree-linux-x64` 负责 Linux x64

## GitHub workflow

`.github/workflows/filetree-package.yml` 支持手动运行，`publish` 默认关闭，`private_version` 私有修订号默认为 `0.1`。矩阵在 `macos-14` 与 `ubuntu-24.04` 上构建，上传 tarball 产物；开启发布时，单独的 job 使用 `GITHUB_TOKEN` 和 `packages: write` 发布三个私有包。workflow 不连接部署服务器。

## 安装与验证

README 记录 scoped `.npmrc` 和 `read:packages` token。入口包选择平台，平台包从本地 tarball 安装运行时。服务器只读验证记录 Ubuntu 24.04、x86_64、Node 24.19.0、npm 11.17.0、pnpm 11.22.0 和约 3.58 GB 内存，不替换现有服务。

## 验证

构建脚本和 workflow 都在两个目标平台执行安装与启动检查。

## 实现输入

- DSH release tarball
- vendored Cordis tarball
- Landlock entry tarball
