# Mobile Workspace File Picker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a mobile attachment picker that lets the Web composer choose ordinary files or photos, routes them through the existing upload/image paths, and preserves desktop drag-and-drop.

**Architecture:** Keep `ComposerAttachments` as the attachment presentation owner and add a small internal picker component with two native file inputs. The picker shares the existing MIME routing and `InputBar` upload wrapper, so the authenticated `workspace.uploadFile` RPC and host-side storage remain unchanged. Ordinary mobile uploads are processed one at a time and the existing 32 MiB server limit is mirrored by an early client guard.

**Tech Stack:** TypeScript, React 18, CSS Modules, Vitest, Testing Library/jsdom, Playwright through the existing Vitest web E2E lane, pnpm, GitHub Actions, and the existing private npm installer workflow.

---

## Working rules

- Execute this plan in `/Users/bhn/Desktop/funny_project/deepseek-harness-wt-codex-bot-commit`.
- Do not edit `/Users/bhn/Desktop/funny_project/deepseek-harness`, which is the user's separate dirty worktree.
- Follow TDD for each behavior: write the smallest failing test, run it, implement the minimum, rerun the focused test, then commit.
- Do not change the Host upload API or add a public download endpoint.
- Keep the already committed design at `docs/plans/2026-09-02-mobile-file-picker-design.md` as the behavior contract.

### Task 1: Specify the native picker surface

**Files:**
- Create: `packages/client/ui-attachment/tests/file-picker.client.spec.tsx`
- Modify: `packages/client/ui-attachment/tests/composer-attachments.client.spec.tsx` only if its shared translator fixture needs the new labels

**Step 1: Write the failing tests**

Create jsdom tests for the internal picker contract. Render it with a translator-independent label object and an `onFiles` spy. Cover:

- the attachment button has an accessible name and opens a dialog named `Upload attachment`;
- the dialog exposes `Choose file` and `Choose photos` actions;
- the generic action drives an input marked `data-file-picker-kind="file"` with `multiple` and no image-only `accept` filter;
- the photo action drives an input marked `data-file-picker-kind="photos"` with `multiple` and `accept="image/*"`;
- a selected `FileList` is forwarded as an ordered `File[]`;
- cancel and Escape close the dialog, and a disabled picker cannot open it;
- the input value is cleared after a change so selecting the same file again can be delivered.

Use Testing Library role queries for visible controls and a data attribute only for the hidden native inputs. The test should use a small text file and a PNG-shaped `File`; it must not depend on a real browser picker.

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm exec vitest run packages/client/ui-attachment/tests/file-picker.client.spec.tsx
```

Expected: FAIL because the picker component and its contract do not exist yet.

**Step 3: Commit the red specification**

```bash
git add packages/client/ui-attachment/tests/file-picker.client.spec.tsx packages/client/ui-attachment/tests/composer-attachments.client.spec.tsx
git commit -m "test(ui): specify mobile file picker"
```

### Task 2: Implement the picker component and mobile layout

**Files:**
- Create: `packages/client/ui-attachment/src/client/FilePicker.tsx`
- Create: `packages/client/ui-attachment/src/client/FilePicker.module.css`
- Modify: `packages/client/ui-attachment/tests/file-picker.client.spec.tsx`

**Step 1: Implement the smallest passing component**

Define an internal `FilePicker` component with these props:

```ts
interface FilePickerLabels {
  button: string
  dialog: string
  chooseFile: string
  choosePhotos: string
  cancel: string
  uploading: string
}

interface FilePickerProps {
  disabled: boolean
  labels: FilePickerLabels
  onFiles: (files: readonly File[]) => void | Promise<void>
}
```

Use two refs to native file inputs. The visible button opens a keyboard-accessible dialog; the two action buttons call the corresponding input's `.click()` directly from the user gesture. Convert `event.currentTarget.files` to an array, reset `event.currentTarget.value`, and await `onFiles` in a `try/finally` so the busy state always clears. Consume a rejected callback promise after the owner has surfaced its own localized error so the browser has no unhandled rejection.

Render the inputs visually hidden but still programmatically clickable. Add `aria-haspopup="dialog"`, `aria-expanded`, `aria-modal`, a stable dialog label, and focus restoration/ Escape handling. Do not set `capture`; the operating system may offer its normal photo-library choices.

Style the trigger with a minimum 44 by 44 pixel touch target. Anchor the desktop choice surface near the trigger and use a safe-area-aware bottom-sheet layout on narrow viewports. Keep the component usable with keyboard focus and avoid making the drag overlay clickable.

**Step 2: Run the focused test to verify it passes**

Run:

```bash
pnpm exec vitest run packages/client/ui-attachment/tests/file-picker.client.spec.tsx
```

Expected: PASS for dialog state, native input attributes, file forwarding, reset behavior, and disabled/cancel paths.

**Step 3: Commit the component**

```bash
git add packages/client/ui-attachment/src/client/FilePicker.tsx packages/client/ui-attachment/src/client/FilePicker.module.css packages/client/ui-attachment/tests/file-picker.client.spec.tsx
git commit -m "feat(ui): add mobile file picker"
```

### Task 3: Wire the picker into the existing attachment slot

**Files:**
- Modify: `packages/client/ui-attachment/src/client/ComposerAttachments.tsx`
- Modify: `packages/client/ui-attachment/src/client/labels.ts`
- Modify: `packages/client/ui-attachment/src/client/ComposerAttachments.module.css`
- Modify: `packages/client/ui-attachment/tests/composer-attachments.client.spec.tsx`

**Step 1: Add integration tests before changing the component**

Extend the existing jsdom suite to assert that `ComposerAttachments`:

- always renders the attachment trigger when the existing `canAcceptDrop` capability is available;
- opens the two picker actions and routes a generic selected file to `onUploadFiles`;
- routes a selected image to `onAddImages` and leaves the generic callback untouched;
- routes a mixed generic selection through both callbacks;
- uses the same routing for drag/drop and picker input;
- disables the picker when `canAcceptDrop` is false and preserves all current drop-overlay behavior.

Add the new Chinese and English label values to the test translator fixture so the tests exercise real keys rather than fallback key strings.

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm exec vitest run packages/client/ui-attachment/tests/composer-attachments.client.spec.tsx
```

Expected: FAIL because `ComposerAttachments` does not render a picker or expose the new labels.

**Step 3: Extract and reuse the file-intake routine**

In `ComposerAttachments.tsx`, extract the existing image/non-image split into one callback used by both the document drop listener and `FilePicker`. Preserve the current fallback when `onUploadFiles` is absent. The drop event should call the async routine with `void` and consume its rejection exactly as it does today.

Render `FilePicker` alongside the existing rail and pass `!canAcceptDrop` as its disabled state. Keep the drag overlay, image rail, and lightbox unchanged apart from the shared intake call. Add a `filePickerLabels` helper in `labels.ts`, and add localized button/dialog/uploading strings to `packages/client/ui-conversation/src/client/locales.ts` in both language dictionaries.

Add only the CSS needed for the trigger/placement in the attachment package; do not change the composer text layout or make the full-page drag overlay interactive.

**Step 4: Run the focused tests to verify they pass**

Run:

```bash
pnpm exec vitest run packages/client/ui-attachment/tests/file-picker.client.spec.tsx packages/client/ui-attachment/tests/composer-attachments.client.spec.tsx
```

Expected: PASS, including all pre-existing drag/drop and preview tests.

**Step 5: Commit the integration**

```bash
git add packages/client/ui-attachment/src/client packages/client/ui-attachment/tests/composer-attachments.client.spec.tsx packages/client/ui-conversation/src/client/locales.ts
git commit -m "feat(ui): wire mobile picker into composer attachments"
```

### Task 4: Add the mobile-safe upload guard and sequential upload behavior

**Files:**
- Modify: `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx`
- Modify: `packages/client/ui-conversation/tests/input-bar.client.spec.tsx`
- Modify: `packages/client/ui-conversation/src/client/locales.ts`

**Step 1: Write failing InputBar tests**

Add tests that call the existing `onUploadFiles` path with:

- two ordinary files and assert the underlying upload callback receives `[first]` and then `[second]`, never a concurrent multi-file batch;
- one file larger than `32 * 1024 * 1024` and assert the underlying upload callback is not called and the localized size error is shown;
- one successful and one failed file and assert the successful path is inserted while the failed file produces a toast and does not erase the draft;
- a normal file whose path contains spaces and assert the existing quoted path behavior remains unchanged.

Use deferred promises for the sequential assertion so the test proves the second upload does not start before the first settles.

**Step 2: Run the focused test to verify it fails**

```bash
pnpm exec vitest run packages/client/ui-conversation/tests/input-bar.client.spec.tsx
```

Expected: FAIL because the current wrapper calls the underlying uploader with the whole batch and has no ordinary-file size guard.

**Step 3: Implement the guard and queue**

Define a client-side `DEFAULT_WORKSPACE_UPLOAD_MAX_BYTES = 32 * 1024 * 1024` beside the existing input helpers. Before invoking `uploadFiles`, reject the whole incoming ordinary-file batch if any file exceeds that limit; format the message with the existing megabyte helper and a new `file.fileTooLarge` locale key. The Host remains authoritative for configured limits.

Change `uploadWorkspaceFiles` to upload ordinary files one at a time, inserting each successful returned path immediately. Keep the existing error-to-toast conversion and draft preservation. This wrapper is shared by drop, paste, and picker paths, so all three get the same memory and failure behavior.

Add the picker labels and the size-error copy to both Chinese and English locale dictionaries. Keep the existing image keys and image validation untouched.

**Step 4: Run the focused tests to verify they pass**

```bash
pnpm exec vitest run packages/client/ui-conversation/tests/input-bar.client.spec.tsx packages/client/ui-attachment/tests/composer-attachments.client.spec.tsx
```

Expected: PASS for upload sequencing, size rejection, path insertion, failure handling, and unchanged image/drop behavior.

**Step 5: Commit the upload behavior**

```bash
git add packages/client/ui-conversation/src/client/skeleton/InputBar.tsx packages/client/ui-conversation/src/client/locales.ts packages/client/ui-conversation/tests/input-bar.client.spec.tsx
git commit -m "feat(ui): make workspace uploads mobile-safe"
```

### Task 5: Add a real mobile-viewport Web E2E scenario

**Files:**
- Create: `apps/web/tests/mobile-file-picker.e2e.ts`

**Step 1: Write the scenario against the built Web surface**

Use the existing `launchWebScaffold`, `connectFreshWorkspace`, `watchConsole`, and failure-shot helpers. Launch Chromium with `{ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'en-US' }`, open the fresh workspace, and locate controls by their accessible names.

Use Playwright `setInputFiles` on `input[data-file-picker-kind="file"]` with a small `mobile-notes.md` file. Assert that the draft contains `@uploads/mobile-notes.md` and that the corresponding file is present under `scaffold.workspaceCwd/workspace/uploads/`. Open the picker again and set a valid tiny PNG on the photos input; assert that the image attachment/preview path is visible. Assert there are no page errors or console warnings.

The test must exercise the native-input path, not synthetic drag events. Keep it keyless and model-call-free so it runs in the existing replay lane.

**Step 2: Run the scenario**

```bash
pnpm run build
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/mobile-file-picker.e2e.ts
```

Expected: PASS in replay mode with a 390 by 844 touch page. If a test reveals a changed accessible snapshot, update only the owning golden after reviewing the diff.

**Step 3: Commit the E2E coverage**

```bash
git add apps/web/tests/mobile-file-picker.e2e.ts
git commit -m "test(web): cover mobile workspace file picker"
```

### Task 6: Make the installer payload guard the new client behavior

**Files:**
- Modify: `.github/workflows/filetree-package.yml`
- Modify: `scripts/ci-workflow.spec.ts`

**Step 1: Write the failing static workflow assertion**

Extend `scripts/ci-workflow.spec.ts` to require the manual package workflow to inspect exactly one `dsh-client-ui-attachment` tarball and verify that the extracted client bundle contains the picker marker (for example `FilePicker` or `data-file-picker-kind`). Keep the existing host `workspace-upload.js` and conversation `uploadFiles` assertions.

Run:

```bash
pnpm exec vitest run scripts/ci-workflow.spec.ts
```

Expected: FAIL because the workflow has no attachment tarball check.

**Step 2: Add the workflow check**

In the existing `Verify workspace upload payload` step, collect `dist/npm/deepseek-ai-dsh-client-ui-attachment-*.tgz`, assert one match, extract its `package/lib/client.js`, and grep for the stable picker marker. Do not add server SSH, credentials, or a new network dependency to CI.

**Step 3: Rerun and commit**

```bash
pnpm exec vitest run scripts/ci-workflow.spec.ts
git add .github/workflows/filetree-package.yml scripts/ci-workflow.spec.ts
git commit -m "ci: verify mobile picker in installer payload"
```

Expected: PASS for the workflow schema and the new payload guard.

### Task 7: Run repository verification and prepare the private release

**Files:**
- Modify: none unless a verification command identifies an implementation defect
- Inspect: `docs/plans/2026-09-02-mobile-file-picker-design.md`, `docs/plans/2026-09-02-mobile-file-picker.md`

**Step 1: Run focused client checks**

```bash
pnpm exec vitest run \
  packages/client/ui-attachment/tests/file-picker.client.spec.tsx \
  packages/client/ui-attachment/tests/composer-attachments.client.spec.tsx \
  packages/client/ui-conversation/tests/input-bar.client.spec.tsx \
  scripts/ci-workflow.spec.ts
```

Expected: PASS with no unexpected snapshots or console errors.

**Step 2: Run type and lint checks**

```bash
pnpm run typecheck
pnpm run lint
git diff --check
```

Expected: PASS; generated build output remains ignored and the worktree contains only intended source/docs changes.

**Step 3: Build and run the mobile Web E2E lane**

```bash
pnpm run build
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/mobile-file-picker.e2e.ts
```

Expected: PASS in keyless replay mode. Perform one manual smoke test in iOS Safari and one in Android Chrome: open the authenticated site, choose a normal file, choose a photo, and send a prompt that makes the agent read the resulting path.

**Step 4: Push the feature branch**

After all local checks pass, push only the feature branch and source/docs changes. Do not commit `.artifacts`, tarballs, credentials, or the user's other worktree changes.

**Step 5: Build an artifact-only private package run**

Dispatch the existing workflow from the feature branch with the next private revision:

```bash
gh workflow run filetree-package.yml --ref <feature-branch> -f publish=false -f private_version=0.4
```

Wait for both macOS arm64 and Linux x64 jobs. Inspect the uploaded entry/platform artifacts and confirm the workflow's host, conversation, and attachment payload checks pass.

**Step 6: Publish after artifact review**

Only after the artifact-only run passes, dispatch the same workflow with `publish=true`. Confirm the three `@bhnan/dsh-filetree*` packages are private GitHub Packages releases at `0.1.1-rc.2-bhn.0.4`. The server's scoped npm configuration must remain in place; do not use a global GitHub registry override for the nested public dependencies.

**Step 7: Deploy with rollback preserved**

On `root@123.56.81.22`, install the published version into a new versioned release directory using the existing scoped npm configuration, verify both entry/platform versions and the file-picker payload, atomically switch `/opt/dsh-filetree/current`, and restart `dsh-web.service`. Confirm the service is active and the local web endpoint still redirects to `/login`. Keep `.0.3` until the phone smoke test passes; rollback is the same symlink switch back to `.0.3` followed by a service restart.

**Step 8: Final verification**

Use `@superpowers:verification-before-completion` before claiming completion. Report the branch, commits, workflow run, published version, server release path, service status, and manual phone smoke-test result.
