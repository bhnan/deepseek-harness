# Web Password Login Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add opt-in username-and-password login to the Web profile, with independent multi-device browser sessions lasting at least seven days.

**Architecture:** `dsh-client-connection` remains the single owner of browser-session cookies and API/WebSocket authentication. Its optional password-login mode serves named login and logout routes, mints the existing authority-bound cookie after credential verification, and returns a clean URL instead of a launch-token URL. `dsh-web-app` only maps launch-environment values into that mode.

**Tech Stack:** TypeScript ESM, Cordis, Schemastery, node:http, node:crypto HMAC, Vitest, YAML profile overlays, paired Markdown documentation.

---

### Task 1: Repair the selected file-tree base's Host compile face

**Files:**
- Modify: `packages/api/workspace-controller/tsconfig.host.json`
- Modify: `packages/api/workspace-controller/src/index.ts:4-25,117-125`

**Step 1: Reproduce the baseline failure**

Run: `pnpm run build:lib:host`

Expected: FAIL because `workspace-upload.ts` is imported but absent from the Host `files` list, and `RemoteError` is not imported.

**Step 2: Complete the Host program declaration**

Add `src/workspace-upload.ts` after `src/workspace-files.ts` in the `files` list. Add `RemoteError` to the `@deepseek-ai/dsh-typert-protocol` import. Add this JSDoc above the existing Remote method:

```ts
/**
 * Save one browser-selected file under the target Workspace's uploads directory.
 * @param request - Workspace identity plus the file name, media type, and base64 bytes.
 * @returns the stored file projection.
 */
```

**Step 3: Verify and commit the prerequisite**

Run: `pnpm run build:lib:host`

Expected: PASS; `workspace-upload.ts` belongs to the Host program and the catalog can read `uploadFile()` JSDoc.

```bash
git add packages/api/workspace-controller/tsconfig.host.json packages/api/workspace-controller/src/index.ts
git commit -m "fix(workspace): complete upload host face"
```

### Task 2: Define password-login configuration and browser-session semantics

**Files:**
- Create: `packages/client/connection/src/password-login.ts`
- Modify: `packages/client/connection/src/browser-auth.ts`
- Modify: `packages/client/connection/src/index.ts:59-105`
- Test: `packages/client/connection/tests/browser-auth.host.spec.ts`
- Test: `packages/client/connection/tests/node-half.host.spec.ts`

**Step 1: Write the failing BrowserAuth tests**

Add cases for a configured account that prove:

- password mode returns a clean root from `authenticatedUrl()`;
- a valid login mints `HttpOnly`, `Secure`, `SameSite=Strict`, authority-bound cookie data with a seven-day default lifetime;
- two login calls create different cookies that both authenticate;
- a restart with unchanged credentials accepts a cookie, and changed credentials reject all old password-mode cookies;
- a token-mode cookie cannot satisfy enabled password mode.

Run: `pnpm exec vitest run packages/client/connection/tests/browser-auth.host.spec.ts`

Expected: FAIL because BrowserAuth only supports launch-token cookie exchange.

**Step 2: Add the resolved configuration**

Create the host-only configuration type:

```ts
export interface PasswordLoginConfig {
  readonly username: string
  readonly password: string
  readonly sessionMaxAgeDays: number
  readonly failureDelayMs: number
  readonly secureCookie: boolean
}
```

Extend `ConnectionConfig` and its Schemastery schema with optional `passwordLogin`. Require non-empty username and password together, require `sessionMaxAgeDays >= 7`, expose the duration and failure delay as configuration, and default `secureCookie` to `true`. Preserve the current token-mode `cookieMaxAgeDays` default when the new object is absent.

**Step 3: Extend BrowserAuth without a second session store**

Pass the resolved password configuration to `BrowserAuth.create()`. Retain the durable `client-connection/browser-session` HMAC secret. Add package-private operations that compare submitted values through same-size keyed digests and `timingSafeEqual`, derive a keyed credential revision, mint a password-mode cookie, reject a bad signature/authority/expiry/revision, expire one authority cookie, and select clean versus tokenized URL output.

Use a new versioned cookie payload. Never serialize a password, raw password hash, or signing secret into the cookie.

**Step 4: Verify and commit the session owner**

Run: `pnpm exec vitest run packages/client/connection/tests/browser-auth.host.spec.ts packages/client/connection/tests/node-half.host.spec.ts`

Expected: PASS, including the existing token-mode tests.

```bash
git add packages/client/connection/src/password-login.ts packages/client/connection/src/browser-auth.ts packages/client/connection/src/index.ts packages/client/connection/tests/browser-auth.host.spec.ts packages/client/connection/tests/node-half.host.spec.ts
git commit -m "feat(connection): add password browser sessions"
```

### Task 3: Serve localized login and logout through named routes

**Files:**
- Modify: `packages/client/connection/src/password-login.ts`
- Modify: `packages/client/connection/src/index.ts:111-138`
- Test: `packages/client/connection/tests/node-half.host.spec.ts`

**Step 1: Write failing route tests**

Extend the mounted fixture to receive `passwordLogin`. Test exact `/auth/login` and `/auth/logout` routes:

- trusted `GET /auth/login` returns localized HTML without configured values;
- untrusted or cross-site login is 403 before the body is read;
- valid form-encoded login redirects to `/` and sets one Secure cookie;
- invalid username, invalid password, malformed body, and unsupported method return non-enumerating failures without a cookie;
- the issued cookie permits `/api`, while a request without it remains 401;
- logout invalidates only the current browser cookie.

Run: `pnpm exec vitest run packages/client/connection/tests/node-half.host.spec.ts`

Expected: FAIL because Connection currently registers only `/api`.

**Step 2: Implement the narrow HTTP owner**

In `password-login.ts`, add a fixed-size `application/x-www-form-urlencoded` parser, an English/Chinese host-owned login dictionary selected from `Accept-Language`, HTML escaping, generic failure responses, and bounded failed-login delay. Reuse `isTrustedApiRequest()` before password handling.

In `index.ts`, register exact `/auth/login` and `/auth/logout` routes with `ctx.effect()` only when password mode is enabled. Dispatch only the expected methods; never replace a raw Node listener, alter API ownership, or add a second WebSocket check.

**Step 3: Verify and commit the route owner**

Run: `pnpm exec vitest run packages/client/connection/tests/node-half.host.spec.ts packages/client/connection/tests/browser-auth.host.spec.ts`

Expected: PASS, including removal of the named routes when the fiber disposes.

```bash
git add packages/client/connection/src/password-login.ts packages/client/connection/src/index.ts packages/client/connection/tests/node-half.host.spec.ts
git commit -m "feat(connection): serve password login routes"
```

### Task 4: Wire password login from the Web profile environment

**Files:**
- Modify: `packages/bundle/web-app/cordis.patch.yml:158-170`
- Test: `packages/client/connection/tests/node-half.host.spec.ts`
- Test: `packages/bundle/web-app/tests/web-app.spec.ts`

**Step 1: Write failing configuration and startup tests**

Add Connection-load coverage that rejects a partial account configuration and accepts both values. Extend the Web runtime fixture with a password-mode Connection double returning a clean URL, then assert that the printed and opened URL contains no token.

Run: `pnpm exec vitest run packages/client/connection/tests/node-half.host.spec.ts packages/bundle/web-app/tests/web-app.spec.ts`

Expected: FAIL until the profile maps password configuration and BrowserAuth owns clean URL selection.

**Step 2: Add launch-environment expressions**

Keep the current `trustedHosts` entry and add a `passwordLogin` expression to the connection row. It must read only:

- `DSH_WEB_AUTH_USERNAME`
- `DSH_WEB_AUTH_PASSWORD`
- `DSH_WEB_AUTH_SESSION_DAYS` (default `7`)
- `DSH_WEB_AUTH_FAILURE_DELAY_MS` (documented default)
- `DSH_WEB_AUTH_SECURE_COOKIE` (default `true`)

Construct the nested object only when either credential environment name is present. Let the Connection schema reject a missing peer or malformed numeric/boolean value. Do not expose secrets to browser bootstrap data or logs.

**Step 3: Verify and commit profile wiring**

Run: `pnpm exec vitest run packages/client/connection/tests/node-half.host.spec.ts packages/client/connection/tests/browser-auth.host.spec.ts packages/bundle/web-app/tests/web-app.spec.ts`

Expected: PASS. Token mode remains tokenized; password mode prints and opens a clean URL.

```bash
git add packages/bundle/web-app/cordis.patch.yml packages/client/connection/tests/node-half.host.spec.ts packages/bundle/web-app/tests/web-app.spec.ts
git commit -m "feat(web): configure password login from environment"
```

### Task 5: Add the decision record and paired package documentation

**Files:**
- Create: `.agents/notes/proposed/architecture/2026-09-05-web-password-authentication.md`
- Create: `.agents/notes/proposed/architecture/2026-09-05-web-password-authentication.zh.md`
- Create: `.agents/notes/proposed/architecture/2026-09-05-web-password-authentication.i18n.yaml`
- Modify: `packages/client/connection/README.md`
- Modify: `packages/client/connection/README.zh.md`
- Modify: `packages/client/connection/README.i18n.yaml`
- Modify: `packages/bundle/web-app/README.md`
- Modify: `packages/bundle/web-app/README.zh.md`
- Modify: `packages/bundle/web-app/README.i18n.yaml`
- Modify: `docs/plans/2026-09-05-web-password-auth-design.md`

**Step 1: Write the proposed architecture note**

Read the active browser-token authentication note first. Keep it as token-mode authority and create a separate proposed note because password login adds a distinct deployment and credential decision. Record the user-approved one-account scope, multi-device concurrency, seven-day minimum, per-device logout, credential-rotation invalidation, HTTPS/Caddy requirement, loopback-only DSH binding, and the rejected raw-listener and reverse-proxy-only alternatives.

**Step 2: Update package contracts**

Document configuration names, clean password-mode URL, cookie attributes, mode-specific token behavior, Host/Origin trust versus identity, and deliberately absent device management or external IdPs. The login document uses host-owned localized copy; package READMEs retain the consumer contract while the note owns the alternatives.

**Step 3: Re-record pairs and regenerate docs**

Run:

```bash
pnpm run verify-translation-pairing --write .agents/notes/proposed/architecture/2026-09-05-web-password-authentication.md
pnpm run verify-translation-pairing --write packages/client/connection/README.md
pnpm run verify-translation-pairing --write packages/bundle/web-app/README.md
pnpm run doc-sync
```

Expected: PASS after Task 1's JSDoc repair.

**Step 4: Commit documentation**

```bash
git add .agents/notes/proposed/architecture/2026-09-05-web-password-authentication* packages/client/connection/README* packages/bundle/web-app/README* docs/plans/2026-09-05-web-password-auth-design.md
git commit -m "docs: describe web password authentication"
```

### Task 6: Run scope-matched verification and prepare the branch

**Files:**
- Verify: all files changed by Tasks 1-5

**Step 1: Run focused behavior tests**

Run:

```bash
pnpm exec vitest run packages/client/connection/tests/browser-auth.host.spec.ts packages/client/connection/tests/node-half.host.spec.ts packages/bundle/web-app/tests/web-app.spec.ts packages/bundle/web-app/tests/browser-open.spec.ts packages/host/frontend-static/tests/frontend-static.spec.ts
```

Expected: PASS.

**Step 2: Run compilation, lint, and documentation gates**

Run:

```bash
pnpm run typecheck
pnpm run lint
pnpm run doc-sync
git diff --check
```

Expected: PASS with no generated-file drift or vendor changes.

**Step 3: Review and finish**

Inspect `git status --short`, `git log --oneline port/workspace-file-tree-0.1.2..HEAD`, and `git diff port/workspace-file-tree-0.1.2...HEAD`. Confirm that the branch contains only the approved base repair, password login, documentation, and tests; it must contain no server credentials or deployment changes. Commit only generated tracked output that a gate requires.
