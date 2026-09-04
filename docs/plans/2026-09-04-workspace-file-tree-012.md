# Workspace File Tree and Preview Implementation Plan

English | [中文](2026-09-04-workspace-file-tree-012.zh.md)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an authenticated, bounded workspace file tree and in-app preview to the 0.1.2 Web sidebar.

**Architecture:** Add a `workspaceFiles` Remote controller inside the existing workspace-controller package so listing and previewing work independently of the native-or-browse directory-picker choice. Add a sidebar slot and a browser-only `ui-file-tree` package that consumes the generated Remote API and reuses the session controller's existing system-open action. Leave the 0.1.2 BrowserAuth and trust fence untouched.

**Tech Stack:** TypeScript, Cordis, Typert Remote, Node `fs/promises`, React, Vitest, pnpm.

---

### Task 1: Establish the Host file-browsing contract with failing tests

**Files:**

- Create: `packages/api/workspace-controller/tests/workspace-files.host.spec.ts`
- Modify: `packages/api/workspace-controller/src/types.ts`

**Step 1: Write the failing tests**

Add a Host Remote test fixture that loads `WorkspaceController` and calls the generated `workspaceFiles` namespace. Cover these observable outcomes:

```text
list(<absolute temp directory>) returns independently sorted dirs and files
list() caps each group at maxEntries and marks each truncated group
list() includes an enterable directory symlink but excludes a file symlink
read(<text file>) returns a UTF-8 head and truncated=true after 256 KiB
read(<small recognised image>) returns image/base64/MIME
read(<binary or oversized image>) returns binary without content
read(<relative or directory path>) returns workspace-files/unreadable
an aborted list/read returns gateway/cancelled
```

**Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/api/workspace-controller/tests/workspace-files.host.spec.ts`

Expected: FAIL because `ctx.remote.workspaceFiles` and its result types do not exist.

**Step 3: Add only the client-safe payload types**

Add `WorkspaceFileEntry`, `WorkspaceFileLevel`, and `WorkspaceFilePreview` to `src/types.ts`. They must contain only JSON-safe fields and distinguish text, image, and binary preview kinds.

**Step 4: Re-run the focused test**

Run: `pnpm exec vitest run packages/api/workspace-controller/tests/workspace-files.host.spec.ts`

Expected: It still fails at the missing Host service, proving the test exercises the planned Remote API rather than a local helper.

**Step 5: Commit the red contract test**

Run:

```text
git add packages/api/workspace-controller/tests/workspace-files.host.spec.ts packages/api/workspace-controller/src/types.ts
git commit -m "test: specify bounded workspace file remote"
```

### Task 2: Implement the bounded `workspaceFiles` Remote controller

**Files:**

- Create: `packages/api/workspace-controller/src/workspace-files.ts`
- Modify: `packages/api/workspace-controller/src/index.ts`
- Modify: `packages/api/workspace-controller/package.json`
- Modify: `packages/api/workspace-controller/tsconfig.host.json`
- Modify: `packages/api/workspace-controller/tsconfig.client.json`

**Step 1: Implement the smallest Host service that makes Task 1 green**

Create `WorkspaceFilesController extends TypertRemoteService` with service key `workspaceFilesController` and namespace `workspaceFiles`. Mount it from `WorkspaceController` with `ctx.plugin(WorkspaceFilesController)`.

```text
@Remote('list') list(path, signal) -> WorkspaceFileLevel
@Remote('read') read(path, signal) -> WorkspaceFilePreview
```

Both methods reject paths that are not fully qualified on the current platform. `list` streams directory entries into separate name-sorted bounded windows. `read` reads no more than the text/image policy requires and converts local errors to `RemoteError`; check the abort signal before classifying local errors.

**Step 2: Run the focused Host test**

Run: `pnpm exec vitest run packages/api/workspace-controller/tests/workspace-files.host.spec.ts`

Expected: PASS.

**Step 3: Run the neighboring controller suite**

Run: `pnpm exec vitest run packages/api/workspace-controller/tests`

Expected: PASS with no regression to workspace commands or directory-picker transport.

**Step 4: Commit the Host implementation**

Run:

```text
git add packages/api/workspace-controller
git commit -m "feat: expose bounded workspace file remote"
```

### Task 3: Assemble the generated Remote contribution and client doubles

**Files:**

- Modify: `packages/api/remotes/src/client/index.ts`
- Modify: `packages/api/remotes/package.json`
- Modify: `packages/api/remotes/tsconfig.client.json`
- Modify: `packages/client/connection/src/client/fixture.ts`
- Modify: `packages/client/connection/tests/fixture.client.spec.ts`
- Modify: `tsconfig.client.json`

**Step 1: Write failing client-fixture assertions**

Assert that the browser fixture exposes deterministic `workspaceFiles.list` and `workspaceFiles.read` answers, including the exact generated Remote result shape.

**Step 2: Run the focused fixture test to verify it fails**

Run: `pnpm exec vitest run packages/client/connection/tests/fixture.client.spec.ts`

Expected: FAIL because the generated namespace is not mounted or the fixture has no handlers.

**Step 3: Make the contribution reachable**

Re-export the workspace-file types through `api-remotes`, update its client project references, and extend the deterministic connection fixture only enough for the browser assembly. Keep `api-remotes` selecting the existing workspace-controller contribution; do not add a hand-written RPC bridge.

**Step 4: Re-run the fixture and generated build checks**

Run:

```text
pnpm exec vitest run packages/client/connection/tests/fixture.client.spec.ts
pnpm exec tsc -b packages/api/workspace-controller/tsconfig.host.json packages/api/remotes/tsconfig.client.json
```

Expected: PASS.

**Step 5: Commit the Remote assembly**

Run:

```text
git add packages/api/remotes packages/client/connection tsconfig.client.json
git commit -m "feat: assemble workspace file remote for clients"
```

### Task 4: Declare the sidebar file-tree slot with a failing shell test

**Files:**

- Modify: `packages/client/ui-sidebar/src/client/contract/slots.ts`
- Modify: `packages/client/ui-sidebar/src/client/index.ts`
- Modify: `packages/client/ui-sidebar/src/client/SidebarRoot.tsx`
- Modify: `packages/client/ui-sidebar/src/client/SidebarRoot.module.css`
- Modify: `packages/client/ui-sidebar/tests/apply.client.spec.tsx`
- Modify: `packages/client/ui-sidebar/tests/sidebar-root.client.spec.tsx`
- Modify: `packages/client/ui-sidebar/tests/sidebar-snapshot.client.spec.tsx`
- Modify: `packages/client/ui-sidebar/tests/__snapshots__/sidebar-snapshot.client.spec.tsx.snap`

**Step 1: Write failing tests**

Specify that `sidebar.filetree` is a root-scope `single` child of `sidebar`, is rendered only when the sidebar is wide, and has no layout gap when unoccupied.

**Step 2: Verify the shell test is red**

Run: `pnpm exec vitest run packages/client/ui-sidebar/tests/sidebar-root.client.spec.tsx packages/client/ui-sidebar/tests/apply.client.spec.tsx`

Expected: FAIL because the slot has not been declared or rendered.

**Step 3: Implement the minimum slot and layout**

Add the slot owner contract and render it between `sidebar.workspaces` and the footer. Make its area an internal scrolling band capped at 40% of the column height; omit the area in the collapsed rail.

**Step 4: Verify the sidebar package**

Run: `pnpm exec vitest run packages/client/ui-sidebar/tests`

Expected: PASS after snapshot update is intentional and reviewed.

**Step 5: Commit the shell change**

Run:

```text
git add packages/client/ui-sidebar
git commit -m "feat: reserve sidebar file tree slot"
```

### Task 5: Add the file-tree UI package test-first

**Files:**

- Create: `packages/client/ui-file-tree/package.json`
- Create: `packages/client/ui-file-tree/tsconfig.json`
- Create: `packages/client/ui-file-tree/tsdown.config.ts`
- Create: `packages/client/ui-file-tree/src/index.ts`
- Create: `packages/client/ui-file-tree/src/client/index.ts`
- Create: `packages/client/ui-file-tree/src/client/contract/slots.ts`
- Create: `packages/client/ui-file-tree/src/client/FileTreePanel.tsx`
- Create: `packages/client/ui-file-tree/src/client/FileTreePanel.module.css`
- Create: `packages/client/ui-file-tree/src/client/locales.ts`
- Create: `packages/client/ui-file-tree/src/css-modules.d.ts`
- Create: `packages/client/ui-file-tree/tests/apply.client.spec.ts`
- Create: `packages/client/ui-file-tree/tests/file-tree-panel.client.spec.tsx`
- Modify: `tsconfig.client.json`

**Step 1: Write component and apply tests before the package implementation**

Define a small injected face around `ctx.remote.workspaceFiles.list/read` and `ctx.remote.session.openWorkspacePath`. Exercise root choice, lazy expand/collapse caching, retry, refresh, root reset, request abort on supersession/unmount, text preview, image preview, binary fallback, preview error, Escape close, and best-effort system opening.

**Step 2: Verify the new tests fail correctly**

Run: `pnpm exec vitest run packages/client/ui-file-tree/tests`

Expected: FAIL because the package and `sidebar.filetree` registrant do not exist.

**Step 3: Implement the package minimally**

Use `ctx.slots.inject('sidebar.filetree', ...)` so loading order and HMR declaration replacement are safe. Read sessions and workspaces through standard selector hooks, keep viewing state inside `FileTreePanel`, and branch on `RemoteResult.ok` at the injected boundary. Do not persist cached levels or send raw filesystem reads through a static route.

**Step 4: Run the package tests and client typecheck**

Run:

```text
pnpm exec vitest run packages/client/ui-file-tree/tests
pnpm exec tsc -b packages/client/ui-file-tree
```

Expected: PASS.

**Step 5: Commit the UI package**

Run:

```text
git add packages/client/ui-file-tree tsconfig.client.json
git commit -m "feat: add workspace file tree preview UI"
```

### Task 6: Compose the browser bundle and record the shipped design

**Files:**

- Modify: `packages/bundle/web-app/cordis.patch.yml`
- Modify: `packages/bundle/web-app/package.json`
- Create: `.agents/notes/implemented/feature/2026-09-04-workspace-file-tree-and-preview.md`
- Create: `.agents/notes/implemented/feature/2026-09-04-workspace-file-tree-and-preview.zh.md`
- Create: `.agents/notes/implemented/feature/2026-09-04-workspace-file-tree-and-preview.i18n.yaml`
- Modify: the owning API Gateway or package README and its Chinese/i18n pair when its published Remote contract changes

**Step 1: Write a failing browser-assembly test or extend the existing Web smoke test**

Verify that the default Web bundle exposes the client module and can mount it beside the unchanged BrowserAuth-protected `/api` route.

**Step 2: Verify the assembly test is red**

Run: `pnpm exec vitest run packages/bundle/web-app/tests`

Expected: FAIL because the bundle neither depends on nor lists `ui-file-tree`.

**Step 3: Compose and document**

Add the browser roster row and workspace dependency. Write the paired implemented Agent Note in present tense: document the bounds, active-root rule, use of `session.openWorkspacePath`, and the fact that all calls still pass the 0.1.2 BrowserAuth and trust fence.

**Step 4: Run targeted and repository-required checks**

Run:

```text
pnpm run test:gui
DSH_SNAPSHOT=replay pnpm run test:web
pnpm run verify-doc-budgets
pnpm run verify-md-links
pnpm run verify-translation-pairing
```

Expected: PASS. If a browser snapshot changes, inspect it before accepting it.

**Step 5: Commit the composition and documentation**

Run:

```text
git add packages/bundle/web-app .agents/notes packages/api/workspace-controller/README.md packages/api/remotes/README.md docs
git commit -m "feat: compose workspace file tree in web app"
```

### Task 7: Final verification and handoff

**Files:**

- Verify only; no new production changes.

**Step 1: Check the branch diff and working tree**

Run:

```text
git status --short --branch
git diff dsh-v0.1.2-rc.1...HEAD --check
git log --oneline dsh-v0.1.2-rc.1..HEAD
```

Expected: only the six scoped commits above, no whitespace errors, and no unrelated user changes.

**Step 2: Confirm authentication preservation explicitly**

Run: `git diff dsh-v0.1.2-rc.1...HEAD -- packages/client/connection`

Expected: no diff. The feature must continue to use the current `/api` BrowserAuth route.

**Step 3: Record final test evidence in the handoff**

Report the branch name, commit range, focused test results, GUI/web results, and any remaining manual browser check. Do not push the branch without the user's approval.
