# Workspace file tree and preview — 0.1.2 design

## Outcome

The Web GUI gains a read-only file tree below the workspace/session browser and a bounded in-app preview for the active Session's Workspace. A file can still be handed to the host operating system's default application.

## Scope

This increment ports only file-tree browsing and preview. Workspace upload, the mobile file picker, installer packaging, and any trusted-host policy changes remain out of scope.

## Architecture

`@deepseek-ai/dsh-api-workspace-controller` gains a `workspaceFiles` Remote namespace. Its Host controller lists one absolute directory level and reads one absolute regular file with server-side bounds. It is independent of `directoryPicker`: the picker decides how an operator selects a Workspace, while a read-only tree must also work when the current desktop deployment composes the native picker.

The controller accepts only fully qualified host paths. It returns sorted, separately bounded directory and regular-file windows, follows enterable directory symlinks as the picker does, and excludes file symlinks. Previews return a UTF-8 text head up to 256 KiB, a recognised image up to 8 MiB as base64 plus MIME type, or a binary result with no content. Failed, non-regular, or non-qualified reads become a typed Remote failure; caller cancellation becomes `gateway/cancelled`.

`@deepseek-ai/dsh-client-ui-file-tree` fills a new `sidebar.filetree` single slot. Its root is the active Session's registered Workspace path, falling back to that Session's recorded cwd. Each level loads only when expanded and stays cached until refresh, retry, root change, or unmount. A preview dialog renders text, images, or the binary fallback; its external-open action reuses `ctx.remote.session.openWorkspacePath`.

## Authentication and trust boundary

No code in `packages/client/connection` changes. The new Remote calls use the same `/api` route as every current generated Remote call, so the 0.1.2 Host/Origin trust fence and BrowserAuth cookie check run before either listing or previewing host files. This port does not restore the removed trusted-host exception and does not introduce a static file route or a second authentication mechanism.

## Integration points

- `WorkspaceController` loads the new Host controller so the package's generated `/remote` contribution exposes `ctx.remote.workspaceFiles`.
- `api-remotes` keeps selecting the existing workspace-controller contribution; its Client facade re-exports the new client-safe result types.
- `ui-sidebar` declares and renders the wide-only, height-bounded `sidebar.filetree` region between the workspace browser and the footer.
- The Web bundle lists the new client package and owns its workspace dependency.

## Verification

Host tests cover path qualification, sorted independent bounds, directory-symlink handling, preview limits, binary fallback, and cancellation. Client tests cover slot lifecycle, lazy loading, retry/reset/abort behavior, text/image/binary previews, and best-effort system opening. GUI and browser snapshot suites must remain green. An implemented Agent Note will record the shipped capability and the BrowserAuth boundary with its Chinese counterpart.
