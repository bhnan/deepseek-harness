# Mobile Workspace File Picker Design

**Date:** 2026-09-02
**Status:** Approved for implementation
**Scope:** Web composer in the file-tree installer build

## Goal

Add a mobile-friendly file upload entry point to the Web composer. A user should be
able to choose arbitrary workspace files from a phone's file picker and choose
images from the phone photo library. The existing desktop drag-and-drop behavior
must continue to work.

The browser remains responsible only for selecting and transporting bytes. The
host stores ordinary files in the active workspace, and the agent's existing
filesystem tools remain responsible for reading and parsing them.

## Context and non-goals

The current attachment implementation accepts document-level drag-and-drop and
already routes ordinary files through `workspace.uploadFile`. It does not render
an `input[type=file]`, so a phone has no way to initiate a selection.

This change does not:

- replace or redesign the authenticated `workspace.uploadFile` RPC;
- add a public file-download route;
- parse documents in the browser or host;
- make camera capture a separate product action;
- change the image limits or image message pipeline.

## Interaction

The existing attachment slot gets a visible attachment/plus control with a touch
target of at least 44 by 44 pixels. It is available on both desktop and mobile so
the two input paths do not diverge.

Clicking the control opens a small, keyboard-accessible choice surface with:

1. **Choose file** — a hidden `input[type=file][multiple]` without an image-only
   filter, allowing documents, archives, and other files;
2. **Choose photos** — a hidden `input[type=file][multiple][accept="image/*"]`,
   allowing a phone's photo-library flow. The implementation does not force
   `capture`, leaving the operating system free to expose its normal choices.

The surface closes on cancel, backdrop press, Escape, or the platform back action.
The input value is reset after each change so choosing the same file again still
fires a change event. While a selection is being uploaded, the relevant controls
are disabled and the user gets an explicit uploading state.

## Component ownership

`ComposerAttachments` remains the owner of the attachment control, picker surface,
hidden inputs, and file selection state because it already owns the drop overlay,
image rail, and preview surface. `InputBar` continues to provide the existing
`onAddImages` and `onUploadFiles` callbacks through the attachment slot.

The picker and drag/drop paths share one intake routine:

- image MIME types go to `onAddImages`, preserving image validation and previews;
- all other files go to `onUploadFiles`;
- if the upload callback is unavailable, the existing fallback behavior is kept.

Translations and accessible labels are added to the conversation locale namespace;
the picker must not rely on an icon without an accessible name.

## Data flow

```text
phone attachment button
        |
        v
native file/photo picker -> File[] -> MIME split
                                  |          |
                                  |          +--> existing image preview path
                                  v
                       InputBar upload wrapper
                                  |
                                  v
                       authenticated workspace.uploadFile
                                  |
                                  v
                    workspace/uploads/<safe-name>
                                  |
                                  v
                 path-only @file mention in the draft
```

For ordinary files, `InputBar` keeps the existing active-session workspace lookup,
base64 transport, RPC error handling, and path insertion. The host continues to
sanitize names, prevent path escape, enforce workspace authorization, and return a
workspace-relative path. The agent can then use its existing workspace tools to
read the file after the message is sent.

The picker submits ordinary files one at a time. This avoids reading several large
mobile files into memory concurrently and lets each successful path enter the
draft independently. A failed file produces the existing upload error notice and
does not erase the user's draft or prevent a later retry.

## Limits and failure handling

- The server's 32 MiB decoded per-file limit remains authoritative.
- The client performs an early size check using the default 32 MiB limit before
  calling `arrayBuffer()`, so an obviously oversized mobile file does not create a
  large base64 string unnecessarily.
- A missing active workspace is reported before an upload request is made.
- The existing authenticated API boundary is reused; no unauthenticated upload
  path is introduced.
- The browser does not display file contents or attempt document parsing.
- A failed upload leaves the draft intact and reports a localized, retryable error.
- Existing image count/type/size validation remains unchanged.

The current JSON/base64 carrier is sufficient for the first mobile implementation.
Resumable or chunked uploads are intentionally deferred until real mobile files
show a need for them.

## Testing and acceptance

Component tests cover:

- opening and closing the choice surface;
- invoking the generic and image file inputs;
- multiple selections and re-selecting the same file;
- image/ordinary-file routing;
- disabled/uploading state and cancellation.

`InputBar` tests cover path insertion, error preservation, no-workspace handling,
and the client-side size guard. Existing drag/drop tests remain unchanged and must
continue to pass.

The Web E2E suite adds a mobile viewport case that uses Playwright's file-input
selection API (rather than desktop drag events), verifies the upload request and
draft path, and checks that the authenticated page remains usable. Before release,
perform one manual smoke test in iOS Safari and one in Android Chrome.

Acceptance requires:

1. a phone can open the authenticated site and choose a normal file;
2. a phone can choose one or more photos;
3. ordinary files land in the active workspace and their paths enter the draft;
4. images still preview and follow the existing image submission flow;
5. cancellation, oversized files, missing workspaces, and failed uploads give
   clear feedback without losing the draft;
6. desktop drag-and-drop still works.

## Release and rollback

Implement in the isolated feature worktree, run focused tests plus the existing
installer/package smoke checks, and publish the next package version as
`0.1.1-rc.2-bhn.0.4` through the GitHub Action. The server deployment keeps the
current release-directory layout: install the new package in a new versioned
directory, verify it, atomically move the `current` symlink, and restart
`dsh-web.service`. Keep `.0.3` in place until the mobile smoke test passes so the
symlink can be rolled back without rebuilding the previous release.
