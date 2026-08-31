# GitHub 平台安装包实现计划

[English](2026-08-27-github-platform-installer.md) | 中文

目标是构建并发布私有 GitHub Packages npm 安装包，让一个 `npm install -g @bhnan/dsh-filetree` 命令选择 macOS arm64 或 Linux x64 运行时。

实现分为五步：编写平台包组装器及测试；生成 postinstall 与 launcher；加入 GitHub Actions 构建、产物和私有发布流程；补齐中英文安装文档；运行本地检查并在 GitHub 上先构建产物、再按需发布，最后对服务器做只读验收。服务器不在 workflow 中被连接、重启或替换。

### Task 1: 平台包组装器

- `scripts/release/assemble-platform-installer.ts`
- `scripts/release/assemble-platform-installer.spec.ts`
- `package.json` release script

### Task 2: 运行时脚本

- 生成 postinstall
- 生成 launcher

### Task 3: GitHub Actions

- `.github/workflows/filetree-package.yml`
- `scripts/ci-workflow.spec.ts`

### Task 4: 安装文档

- `filetree-installer.md`
- `filetree-installer.zh.md`
- `index.md`
- `index.zh.md`

### Task 5: 发布与验收

- 本地检查、GitHub 构建、私有发布与服务器只读验收
