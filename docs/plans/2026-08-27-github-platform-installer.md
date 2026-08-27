# GitHub Platform Installer Implementation Plan

English | [中文](2026-08-27-github-platform-installer.zh.md)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build and publish a private GitHub Packages npm installer that selects a macOS arm64 or Linux x64 DeepSeek Harness runtime from one `npm install -g @bhnan/dsh-filetree` command.

**Architecture:** Generate one entry package and one platform package per target from the existing official DSH/vendor/Landlock tarballs. The platform package carries those tarballs and assembles a private runtime during postinstall; the entry package delegates its `dsh` bin to the platform package selected by npm's `os` and `cpu` fields.

**Tech Stack:** TypeScript release scripts, npm package manifests and tarballs, GitHub Actions, Node 24, pnpm, `actions/upload-artifact`, and `GITHUB_TOKEN` with `packages: write`.

---

### Task 1: Define the platform-package assembler API

**Files:**
- Create: `scripts/release/assemble-platform-installer.ts`
- Create: `scripts/release/assemble-platform-installer.spec.ts`
- Modify: `package.json: release script entries`

**Step 1: Write the failing tests**

Add tests for a temporary assembly fixture containing representative DSH, vendor, and Landlock tarballs. Assert that assembly writes the entry manifest, platform manifest, `os`/`cpu` selectors, exact package version, platform dependency names, payload index, launcher files, and postinstall file. Assert that a missing required tarball, duplicate package identity, mismatched version, unsupported platform, or non-scoped namespace throws before writing a publishable package.

**Step 2: Run the focused test to verify it fails**

Run `pnpm vitest run scripts/release/assemble-platform-installer.spec.ts`.

Expected: FAIL because the assembler module and its exported test seam do not exist.

**Step 3: Implement the minimal assembler**

Implement a CLI and pure helpers that accept `--namespace`, `--version`, `--platform`, `--dsh`, `--vendor`, `--landlock`, and `--out`. Read each tarball manifest through the existing `packedIdentity` helper, reject duplicate names and version drift, copy the tarballs under `platform/payload`, and write a deterministic `payload/index.json` mapping package names to filenames. Generate the entry package and platform package with `publishConfig` pointing to `https://npm.pkg.github.com`, the platform `os`/`cpu` fields, optional platform dependencies, bin declarations, and `files` lists. Keep the package namespace configurable but require a lowercase npm scope.

**Step 4: Run the focused test to verify it passes**

Run `pnpm vitest run scripts/release/assemble-platform-installer.spec.ts`.

Expected: PASS with complete metadata and failure-path coverage.

**Step 5: Commit**

Run `git add scripts/release/assemble-platform-installer.ts scripts/release/assemble-platform-installer.spec.ts package.json && git commit -m "feat(release): assemble platform installer packages"`.

### Task 2: Add the runtime postinstall and launcher templates

**Files:**
- Modify: `scripts/release/assemble-platform-installer.ts`
- Modify: `scripts/release/assemble-platform-installer.spec.ts`

**Step 1: Write the failing tests**

Extend the fixture tests to execute the generated platform postinstall in a temporary consumer with a stub npm executable. Assert that it creates a runtime manifest whose dependencies all point to bundled tarballs, invokes npm with `--prefix`, and exits nonzero with an actionable message when any local install fails. Execute the generated entry launcher with a stub platform launcher and assert it delegates; assert a missing platform package reports supported targets.

**Step 2: Run the focused test to verify it fails**

Run `pnpm vitest run scripts/release/assemble-platform-installer.spec.ts`.

Expected: FAIL because generated scripts are not yet present or do not implement the delegation.

**Step 3: Implement the scripts**

Generate ESM scripts that resolve their own package directory, create an idempotent `runtime/package.json`, install every payload tarball plus external dependencies with npm and `--package-lock=false --no-audit --no-fund`, and fail closed on a nonzero child exit. Generate a platform launcher that runs the installed `@deepseek-ai/dsh` bin using the host Node process and preserves arguments, exit status, signals, and environment. Generate an entry launcher that resolves the compatible `@bhnan/dsh-filetree-*` package and forwards all arguments. Do not include credentials in generated files or command output.

**Step 4: Run the focused test to verify it passes**

Run `pnpm vitest run scripts/release/assemble-platform-installer.spec.ts`.

Expected: PASS for delegation, idempotence, and failure paths.

**Step 5: Commit**

Run `git add scripts/release/assemble-platform-installer.ts scripts/release/assemble-platform-installer.spec.ts && git commit -m "feat(release): add platform runtime bootstrap"`.

### Task 3: Add the GitHub Actions build and private publish workflow

**Files:**
- Create: `.github/workflows/filetree-package.yml`
- Modify: `scripts/ci-workflow.spec.ts`

**Step 1: Write the failing workflow tests**

Add static workflow assertions for a manual `workflow_dispatch` with `publish` defaulting false, a macOS arm64 and Ubuntu x64 matrix, Node 24, complete-history checkout, `packages: write` only on the publish job, artifact uploads for entry/macOS/Linux packages, and no server SSH step. Assert that publishing uses `npm.pkg.github.com` and `GITHUB_TOKEN`.

**Step 2: Run the focused test to verify it fails**

Run `pnpm vitest run scripts/ci-workflow.spec.ts`.

Expected: FAIL because the new workflow and assertions do not exist.

**Step 3: Implement the workflow**

Create a manually dispatched workflow with `publish: boolean` default false. For `macos-14` and `ubuntu-24.04`, install Node 24 and pnpm, run `pnpm install --frozen-lockfile`, `pnpm run release:verify --family dsh`, `pnpm run build:official`, pack DSH/vendor/Landlock inputs, and invoke the assembler with `bhnan` namespace and the target selector. Install the resulting entry and platform tarballs into a clean temporary npm consumer and run `dsh --version` plus a no-network `dsh web --help` smoke. Upload each platform package and one entry package with seven-day retention. Add a publish job gated by `inputs.publish` that downloads artifacts, configures `setup-node` for `https://npm.pkg.github.com`, grants `packages: write`, and publishes the three scoped packages with `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.

**Step 4: Run the focused test to verify it passes**

Run `pnpm vitest run scripts/ci-workflow.spec.ts`.

Expected: PASS with the workflow event, matrix, permissions, artifact, and publish assertions.

**Step 5: Commit**

Run `git add .github/workflows/filetree-package.yml scripts/ci-workflow.spec.ts && git commit -m "ci: build private platform installer packages"`.

### Task 4: Document private GitHub Packages installation

**Files:**
- Create: `docs/user/develop/basic/filetree-installer.md`
- Create: `docs/user/develop/basic/filetree-installer.zh.md`
- Modify: `docs/user/develop/basic/README.md`
- Modify: `docs/user/develop/basic/README.zh.md`

**Step 1: Write the documentation checks**

Add the guide links and installation examples to the documentation pairing inventory if the docs generator requires them. Ensure the examples contain no real token and show `read:packages` as the minimum client scope.

**Step 2: Run the documentation checks to verify the new guide is not yet wired**

Run `pnpm run doc-sync`.

Expected: FAIL or report missing guide links until the paired guides and index entries are present.

**Step 3: Implement the paired guides**

Document the single npm command, the scoped `.npmrc` entry, environment-based token handling, supported platforms, the first-install runtime assembly, the explicit `publish: true` GitHub dispatch, artifact download path, and the read-only server verification commands. State that the workflow does not deploy or replace an existing service and that Linux x64 corresponds to the validated Ubuntu 24.04 server.

**Step 4: Run the documentation checks to verify they pass**

Run `pnpm run doc-sync`.

Expected: PASS for pairing, links, wrapping, and budgets.

**Step 5: Commit**

Run `git add docs/user/develop/basic/filetree-installer.md docs/user/develop/basic/filetree-installer.zh.md docs/user/develop/basic/README.md docs/user/develop/basic/README.zh.md && git commit -m "docs: document private platform installer"`.

### Task 5: Run local release checks and dispatch GitHub build

**Files:**
- Modify: none unless a check exposes an implementation defect.

**Step 1: Run the release-focused checks**

Run `pnpm vitest run scripts/release/assemble-platform-installer.spec.ts scripts/ci-workflow.spec.ts`, `pnpm run typecheck`, `pnpm run build:official`, and `git diff --check`.

Expected: PASS; the working tree contains only the intended commits and ignored build outputs.

**Step 2: Push the approved branch**

Run `git push origin feat/workspace-file-tree` only after the checks pass. Do not push credentials or generated tarballs.

**Step 3: Dispatch artifact-only GitHub Actions run**

Use the GitHub UI or `gh workflow run filetree-package.yml --ref feat/workspace-file-tree -f publish=false`. Download and inspect the three artifacts after both matrix jobs pass.

**Step 4: Dispatch private publication**

After inspecting the artifacts, run the same workflow with `publish=true`. Confirm the three packages are private and linked to `bhnan/deepseek-harness`; do not publish to npmjs.org.

**Step 5: Verify the existing server without changing it**

Configure a temporary npm user config with a `read:packages` token, run the package installation in a new directory on `root@123.56.81.22`, and execute `dsh --version` and a no-network startup/help check. Record only exit status, package version, and service isolation; never stop, restart, replace, or edit the existing deployment.
