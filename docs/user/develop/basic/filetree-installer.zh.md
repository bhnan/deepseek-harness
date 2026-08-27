# 安装文件树运行时

[English](filetree-installer.md) | 中文

私有 npm 包 `@bhnan/dsh-filetree` 为 macOS Apple Silicon 和 Linux x64 安装 DeepSeek Harness 文件树运行时。npm 通过可选依赖选择当前平台的运行时包。

## 配置 GitHub Packages

创建或更新 `~/.npmrc`：

```ini
@bhnan:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

将 `GITHUB_PACKAGES_TOKEN` 设置为带有 `read:packages` 权限的 classic GitHub token。尽量不要把 token 直接写入文件，也不要提交到仓库。

## 安装并运行

```sh
npm install --global @bhnan/dsh-filetree
dsh --help
```

入口包会安装匹配的平台包。不要使用 `--omit=optional`，否则 npm 不会安装平台运行时。

支持的目标是 macOS arm64（Apple Silicon）和 Linux x64。本版本只读验证的服务器为 Ubuntu 24.04 x86_64，Node.js 版本为 24.19.0。

## 通过 GitHub Actions 发布

手动运行 `File-tree installer packages` workflow 会构建两个目标，并把 npm tarball 上传为构建产物。保持 `publish` 关闭即可只生成产物；只有确定要发布私有包时才开启它。workflow 仅向发布 job 授予 `packages: write`，并使用 `GITHUB_TOKEN`。

workflow 会发布一个入口包和两个平台包。之后安装时，三个包使用相同版本。
