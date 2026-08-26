# Experimental basic web authentication implementation plan

English | [中文](2026-08-26-experimental-basic-web-auth.zh.md)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Migrate the server's basic web authentication behavior into a credential-free experimental DSH bundle stacked after the workspace-file-tree branch.

**Architecture:** The experimental function plugin wraps the current `dsh-host-webserver` Node listener before the Web SPA fallback. It keeps the server's login form, signed in-memory sessions, HTTP/API gate, and WebSocket gate, while an effect restores the original listeners during plugin disposal. The bundle reads credentials only from profile environment expressions and never contains deployment-specific values.

**Tech Stack:** TypeScript, Cordis Loader, `node:http`, Web Crypto HMAC, Vitest, Schemastery, and DSH's bilingual documentation gates.

---

### Task 1: Register the experimental bundle package

**Files:**

- Create: `packages/experimental/auth-basic/package.json`
- Create: `packages/experimental/auth-basic/tsconfig.json`
- Create: `packages/experimental/auth-basic/cordis.patch.yml`
- Modify: `tsconfig.base.json`
- Modify: `tsconfig.host.json`
- Modify: `packages/experimental/README.md`
- Modify: `packages/experimental/README.zh.md`
- Modify: `packages/experimental/README.i18n.yaml`

**Step 1:** Add the private `@deepseek-ai/dsh-experimental-auth-basic` manifest, its bundle patch, project references, and source-resolution aliases.

**Step 2:** Make the patch require `DSH_AUTH_BASIC_USERNAME` and `DSH_AUTH_BASIC_PASSWORD`, with an optional `DSH_AUTH_BASIC_SESSION_SECRET`; do not add literal credentials.

**Step 3:** Run `pnpm run verify-cordis-config` and `pnpm run constraints`.

### Task 2: Specify the observable authentication behavior first

**Files:**

- Create: `packages/experimental/auth-basic/tests/auth-basic.spec.ts`

**Step 1:** Write a real Loader composition test that starts `dsh-host-webserver`, mounts the auth plugin before `dsh-host-frontend-static`, and exercises the served HTTP surface.

**Step 2:** Assert the unauthenticated API rejection, login page, rejected and accepted login, cookie-backed SPA request, logout, and listener restoration after fiber disposal.

**Step 3:** Snapshot the real login page from that composition, then run `pnpm exec vitest run packages/experimental/auth-basic/tests/auth-basic.spec.ts` and confirm the expected red failure before implementation exists.

### Task 3: Port the plugin without server credentials

**Files:**

- Create: `packages/experimental/auth-basic/src/index.ts`
- Create: `packages/experimental/auth-basic/src/invariant.ts`

**Step 1:** Port the login form, timing-safe credential comparison, HMAC cookie codec, in-memory session store, HTTP interception, and upgrade interception from the server plugin.

**Step 2:** Scope timers, retries, listener replacement, and listener restoration to a Cordis effect so the source package remains unloadable; do not alter normal authentication decisions.

**Step 3:** Add the package invariant companion with its package-specific no-runtime-invariant reason, then rerun the focused test until green.

### Task 4: Document configuration and the intentional limitation

**Files:**

- Create: `packages/experimental/auth-basic/README.md`
- Create: `packages/experimental/auth-basic/README.zh.md`
- Create: `packages/experimental/auth-basic/README.i18n.yaml`
- Create: `.agents/notes/implemented/architecture/2026-08-26-experimental-basic-web-auth.md`
- Create: `.agents/notes/implemented/architecture/2026-08-26-experimental-basic-web-auth.zh.md`
- Create: `.agents/notes/implemented/architecture/2026-08-26-experimental-basic-web-auth.i18n.yaml`

**Step 1:** Document the profile bundle order, required environment values, authenticated remote trusted-host prerequisite, and in-memory-session behavior.

**Step 2:** Record that this is an experimental adapter over a private Node listener rather than a new `WebServer` extension point, and cross-link the trusted-host decision.

**Step 3:** Re-record each changed bilingual pair with `pnpm run verify-translation-pairing --write <pair>`.

### Task 5: Verify, commit, and publish the stacked branch

**Files:**

- Modify: generated configuration and module-graph documents only when their owning generators produce a change

**Step 1:** Run the focused Vitest test, package typecheck/build, config and invariant checks, relevant documentation checks, and `git diff --check`.

**Step 2:** Run the repository pre-push selection for the changed paths, then create one focused commit.

**Step 3:** Push `feat/workspace-file-tree-auth-basic` without rewriting any existing remote branch.
