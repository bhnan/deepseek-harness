# Workspace File Upload Implementation Plan

English | [中文](2026-08-31-workspace-file-upload.zh.md)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a bounded, authenticated workspace-file upload path to the Web composer while preserving the existing image attachment pipeline and leaving parsing to the agent.

**Architecture:** Keep persistence in a host-side deep storage helper, expose it through the existing `workspace.*` RPC seam, and extend the current conversation attachment slot to partition image drops from generic workspace uploads. The client inserts only a path mention; the agent's existing filesystem tools own content access.

**Tech Stack:** TypeScript, Cordis, Zod, Node `fs/promises` and `crypto`, React, Vitest, pnpm.

---

## Task 1: Add the host workspace-upload storage module with tests

**Files:** `packages/host/apiproxy/src/workspace-upload.ts`, `packages/host/apiproxy/tests/workspace-upload.spec.ts`

1. Write failing tests for valid base64 storage under `uploads/`, returned relative paths and SHA-256, empty files, malformed base64, the 32 MiB limit, sanitized separators/control characters, symlinked `uploads`, and deterministic collision handling.
2. Run `pnpm exec vitest run packages/host/apiproxy/tests/workspace-upload.spec.ts` and confirm the new tests fail because the module does not exist.
3. Implement the helper with an explicit input/result type, strict base64 decoding, a configurable byte limit, private upload-directory creation, safe filename normalization, no path escape, and atomic/no-overwrite finalization.
4. Re-run the focused test until it passes and commit the storage slice.

## Task 2: Expose `workspace.uploadFile` through the host RPC contract

**Files:** `packages/host/apiproxy/src/api/workspace.ts`, `packages/host/apiproxy/src/api/workspace.schema.ts`, `packages/host/apiproxy/src/api/rpc-map.ts`, `packages/host/apiproxy/src/fetch/handler.ts`, `packages/host/apiproxy/src/fetch/client.ts`, `packages/host/apiproxy/src/api-proxy.ts`, `packages/host/apiproxy/src/index.ts`

1. Add the request/response contract and write failing route/schema tests in the existing API proxy test files for valid payloads, malformed payloads, and response decoding.
2. Run the narrow API proxy tests and confirm the new route is missing from the compiler-locked maps or dispatch table.
3. Add the route schema and value schema, map row, client method, and host implementation. Resolve the workspace id through `ctx.workspaceRegistry`; map unknown workspaces to `workspace-not-found` and storage validation failures to `attachment-error`.
4. Add `workspaceUploadMaxBytes` to `ApiProxyDefaults` and `ApiProxyService.Config`, defaulting to the storage helper's 32 MiB limit.
5. Update every typed fake/fixture required by the `IApiClient` contract and run the focused host/connection tests plus the host type build.
6. Commit the RPC slice.

## Task 3: Add the client upload callback and path insertion

**Files:** `packages/client/ui-conversation/src/client/contract/slots.ts`, `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx`, `packages/client/ui-conversation/src/client/apply.ts`, `packages/client/ui-conversation/src/client/locales.ts`, `packages/client/ui-conversation/tests/input-bar.client.spec.tsx`

1. Add failing tests for a mixed file intake, a successful upload inserting a path-only mention, a rejected upload leaving the draft unchanged, and a missing active workspace producing a visible error.
2. Run the focused InputBar tests and confirm the new upload behavior is absent.
3. Add the narrow injected callback and workspace-file result type, resolve the workspace id from the active session membership, encode browser bytes, call the new API method, and insert safe `@file` text at the current draft caret using the existing input machine write path.
4. Add localized upload/drop/error copy and preserve all existing image pre-checks and image submission behavior.
5. Run the focused conversation tests and commit the client orchestration slice.

## Task 4: Route generic drops through the attachment presentation slot

**Files:** `packages/client/ui-attachment/src/client/ComposerAttachments.tsx`, `packages/client/ui-attachment/src/client/labels.ts`, `packages/client/ui-attachment/tests/composer-attachments.client.spec.tsx`, `packages/client/ui-conversation/src/client/contract/slots.ts`

1. Write failing component tests for generic-only and mixed drops, blocked drops, upload callback forwarding, and unchanged image callbacks.
2. Run the focused attachment tests and confirm generic files are still sent to the image callback.
3. Partition dropped files by image MIME type, call the image callback for images, call the async workspace callback for generic files, and keep the document drag overlay behavior coherent for both kinds.
4. Update package README limitations and localized labels to describe generic workspace uploads separately from image attachments.
5. Run `pnpm exec vitest run packages/client/ui-attachment packages/client/ui-conversation` and commit the UI slice.

## Task 5: Integrate the bundle, notes, and local verification

**Files:** package metadata/README files as required by repository checks, `packages/bundle/web-app/cordis.patch.yml` if the existing mount needs an update, `.agents/notes/implemented/feature/2026-08-31-workspace-file-upload.md`, `.agents/notes/implemented/feature/2026-08-31-workspace-file-upload.zh.md`

1. Add the implemented Agent Note and cross-link the existing image-attachment and file-reference notes without changing their ownership boundaries.
2. Run package invariant, client-domain, documentation, and translation-pair checks relevant to the changed files; fix generated/package references if a gate identifies one.
3. Run the full focused GUI suite with `pnpm run test:gui`, then build the Web profile and run its local Web regression where available.
4. Manually exercise a temporary workspace upload in the dedicated worktree, verify the file exists below `uploads/`, verify the draft contains the relative `@file` mention, and verify a second run does not alter the user's main worktree.
5. Inspect `git diff`, report exact tests and any known JSON/base64 size limitation, and leave the branch ready for review without pushing or merging.
