# Install the file-tree runtime

English | [中文](filetree-installer.zh.md)

The private `@bhnan/dsh-filetree` package installs the DeepSeek Harness file-tree runtime on macOS Apple Silicon and Linux x64. The package selects the platform payload through npm optional dependencies.

## Configure GitHub Packages

Create or update `~/.npmrc`:

```ini
@bhnan:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

Set `GITHUB_PACKAGES_TOKEN` to a classic GitHub token with `read:packages`. Keep the token outside the file when possible and never commit it.

## Install and run

```sh
npm install --global @bhnan/dsh-filetree
dsh --help
```

The entry package installs the matching platform package. Do not use `--omit=optional`; that flag prevents npm from installing the platform payload.

The supported targets are macOS arm64 (Apple Silicon) and Linux x64. The server validated for this release is Ubuntu 24.04 x86_64 with Node.js 24.19.0.

## Publish from GitHub Actions

The manual `File-tree installer packages` workflow builds both targets and uploads npm tarballs as artifacts. Leave `publish` disabled to produce artifacts only. Enable it only when the private packages should be published; the workflow grants `packages: write` only to its publish job and uses `GITHUB_TOKEN`.

The workflow publishes one entry package and one package for each platform. A later install uses the same version for all three packages.
