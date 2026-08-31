# Agent Note: Web workspace file upload

Status: implemented

English | [中文](2026-08-31-web-workspace-file-upload.zh.md)

## Problem

The Web composer can already persist pasted and dropped images, but generic files have no durable handoff into the active Workspace. A browser `File` object or a temporary path is not a migration-safe input: it disappears with the page or remains unreadable to the Host-side agent. Users therefore cannot move a document into the same Workspace that the agent already knows how to inspect.

The [Web multimodal image-input note](2026-07-22-web-multimodal-image-input-and-durable-attachments.md) deliberately keeps image content as a separate durable attachment type, while the [file and session reference note](2026-07-27-web-file-and-session-references.md) defines path-only `@file` references and agent pre-step reads. Generic Workspace uploads need to connect those two existing boundaries without turning arbitrary documents into model content in the browser.

## Decision

The Host exposes `workspace.uploadFile` through the existing authenticated JSON RPC boundary. Each request carries one browser filename, optional media type, and base64 data for a registered Workspace. The Host decodes and bounds the payload, creates a private `<workspace>/uploads/` directory, sanitizes the filename, refuses symlink escapes, and returns a Workspace-relative path plus byte count, SHA-256, and optional media type. The default decoded per-file limit is 32 MiB and `workspaceUploadMaxBytes` overrides it.

The Web composer partitions every dropped or pasted file by declared image MIME type. Images retain the existing attachment rail, admission policy, durable image content, and history rendering. Non-image files go through `workspace.uploadFile`; after success the composer inserts a path-only `@file` mention at the current draft caret. The agent and its existing filesystem tools decide whether and how to read or parse that path. The upload path adds no generic-file preview, history card, progress rail, or client-side parser.

The storage helper never replaces an existing path. A same-content collision reuses the existing file; different content receives a deterministic short-digest suffix before the extension. The returned path uses `/` separators and remains relative to the registered Workspace root.

## Product behavior

- Dragging or pasting images behaves as before, including image limits, previews, send admission, and history rendering.
- Dragging or pasting non-image files stores them below the active Workspace's `uploads/` directory and inserts a path-only mention such as `@uploads/report.pdf`.
- Mixed input partitions images and non-image files independently, so a generic file does not enter the image rail.
- An upload failure shows the existing composer toast path and leaves the draft text unchanged; a successful upload inserts mentions in upload order at the current selection.
- A missing active Workspace is rejected locally; the RPC still requires the deployment's existing authentication and Workspace authorization.

## Host boundary

`workspace.uploadFile` is part of the `WorkspaceApi`, `RpcMethodMap`, fetch handler, and typed client. Unknown Workspace ids return `workspace-not-found`; invalid base64, unsafe storage conditions, and size violations return `attachment-error`. The route does not create a public download surface: the existing agent filesystem capability remains the content-reading path.

## Client boundary

`ui-attachment` only partitions the document drop and forwards generic files through its optional `onUploadFiles` owner callback. `ui-conversation` resolves the Workspace by the active Session's membership, reads browser bytes, calls the API, and formats the returned relative path with the shared file-reference grammar. The grammar rejects control characters and quotes, so the Host sanitizes those filename characters before returning a path that can be inserted safely.

## Alternatives considered

### Put generic file bytes in the prompt

Rejected because arbitrary documents are not image content and the user explicitly wants the agent to choose the parser. Making bytes model-visible would also duplicate the existing filesystem-tool path and complicate replay and provider contracts.

### Keep only a browser object URL or temporary path

Rejected because reloads, process exits, Docker replacement, and a different Host process can invalidate those locations. A Workspace-relative file survives when the Workspace is mounted and migrated with the deployment.

### Add a public file-download route

Rejected because it would widen the exposed filesystem surface and duplicate Workspace authorization. The upload uses the existing authenticated RPC; the agent reads the file through its already-authorized Workspace tools.

### Parse files during upload

Rejected because parsing is content- and agent-dependent, would add latency and memory pressure to the Host boundary, and would make the upload path responsible for model context policy.

## Consequences

- Generic files are durable ordinary files under the Workspace, so Docker deployments preserve them by preserving the configured Workspace volume.
- The v1 path is one file per JSON request and pays base64/envelope overhead; the decoded file limit is 32 MiB. A future streaming multipart carrier can raise throughput without changing the relative-path response contract.
- Uploads rely on the deployment's existing authentication, Workspace membership, and filesystem capability; this change does not add a second authorization model.
- Files are not model-visible merely because they were uploaded. The prompt contains only a relative path, and the agent must choose to read it.
- There is no multi-file transaction, progress UI, generic preview, or inline parsing. A batch can partially succeed, and a retry is safe because identical content is reused.

## Verification

Host tests cover strict base64 validation, empty files, decoded size limits, filename/path safety, private upload-directory handling, symlink refusal, deterministic collisions, RPC dispatch, unknown Workspaces, and business-error mapping. Client tests cover mixed drop routing, generic-only drops, pasted-file upload, path insertion including quoted paths, and API byte encoding. The dedicated worktree runs the focused host and client suites plus the assembled GUI/Web regression before this branch is handed back.
