# Workspace File Upload Design

## Goal

Allow the Web composer to accept a dragged non-image file, store it inside the active workspace, and put a path-only `@file` mention into the draft so the existing agent file tools can inspect it.

## Non-goals

This change does not parse documents, upload files as multimodal model content, expose an unauthenticated static file route, or replace the existing image attachment pipeline.

## User flow

The browser drops files on the existing composer drop target, keeps image files on the current image-attachment path, and sends other files through a workspace upload RPC.

The host resolves the authenticated workspace id, writes the file below `<workspace>/uploads/`, and returns a relative path plus basic metadata.

The composer inserts a safe path-only mention such as `@uploads/report.pdf` at the current draft caret; the normal prompt submission logs that text, and the agent decides whether and how to read or parse the file.

## Host boundary

The workspace API gains `workspace.uploadFile`, using the existing authenticated JSON RPC carrier with a bounded base64 payload for the local v1 implementation.

The request carries `workspaceId`, browser `name`, optional `mediaType`, and base64 `data`; the response carries the workspace-relative `path`, stored `name`, byte count, SHA-256 digest, and optional media type.

The host stores files in a dedicated `uploads/` directory, creates the directory with private permissions, sanitizes path separators and control characters from names, rejects empty or oversized payloads, and never follows an `uploads` symlink.

A name collision with different content receives a deterministic short-digest suffix; an existing identical upload is reused. The returned path is always relative to the workspace root and uses `/` separators.

The default per-file limit is 32 MiB. This deliberately fits the current JSON transport and gives the local feature a clear bound; a later streaming multipart route can raise the limit without changing the workspace-relative response contract.

The endpoint relies on the deployment's existing API authentication/trust wrapper. It does not add a public download route; the existing agent filesystem capability remains the only file-content path.

## Client boundary

The conversation composer attachment owner accepts both image additions and a workspace-file upload callback. The document-level drag listeners partition a mixed drop by MIME type, so image admission and file persistence remain independent.

The conversation bar resolves the active workspace from the current session's workspace membership, calls `workspace.uploadFile` for each non-image file, and inserts returned mentions using the current draft snapshot. Upload failures surface through the existing composer toast and do not mutate the draft.

The existing image preview, image limits, image admission, and image-only model payload remain unchanged.

## Verification

Host unit tests cover base64 validation, filename/path safety, size limits, private upload-directory handling, deterministic collision naming, and returned relative paths.

RPC tests cover request and response schema coverage, authenticated carrier dispatch, unknown workspace handling, and the business error returned for invalid uploads.

Client tests cover mixed drag routing, upload callback invocation, successful path insertion, failed-upload draft preservation, and the unchanged image route.

The Web bundle and package checks run after the focused tests; local manual verification uses the dedicated worktree and a temporary workspace, not the user's main `feat/workspace-file-tree` worktree.

## Docker implication

The image needs the source or built package and the Web bundle, while the runtime container must persist the DSH home and every configured workspace directory. Uploads are ordinary files under those workspace mounts, so container replacement preserves them when the volume mapping is preserved.
