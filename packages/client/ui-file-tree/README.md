# @deepseek-ai/dsh-client-ui-file-tree

English | [中文](README.zh.md)

Workspace file-tree plugin: fills the sidebar shell's `sidebar.filetree` band ([ui-sidebar](../ui-sidebar/README.md)) with a collapsible directory/file tree and an in-app file preview. The root is the active Session's Workspace path, falling back to the Session's recorded cwd when it belongs to no Workspace; with neither, the panel renders nothing and the band collapses to zero height. A root change is a hard reset of every cached level and expansion.

Levels load lazily: expanding a directory row calls `ctx.workspaces.listDirectory(path, signal, { files: true })` — the [directory-picker seam's](../../host/directory-picker/README.md) browse listing with its additive `files` option — so the tree never scans ahead of the user, and a collapsed row keeps its cached level until the header's refresh drops them all. Hidden entries render dimmed rather than filtered, a truncated group states its cut in place, a failed level is a retriable row, and every in-flight listing aborts when a retry supersedes it or the panel departs.

Clicking a file opens the preview modal over `ctx.workspaces.readFile`, a server-bounded read: a UTF-8 text head of at most 256 KiB (`truncated` marks the cut), a whole image base64-encoded up to 8 MiB, or a declined `binary` verdict for everything else — NUL-bearing content and oversized images included. The footer reports the true byte size, marks a head-only text preview as truncated, and offers a system-open fallback that hands the path to `host.openPath` best-effort, so a declined preview still has a route to the file.

Registration goes through `ctx.slots.inject('sidebar.filetree', …)`, so the panel waits for the shell's declaration and leaves with this plugin's fiber. The injected face carries the three Host actions (`listLevel`/`readFile`/`openPath`) as plain callbacks, and the plugin registers the `filetree` locale namespace (zh default / en). There is no plugin store: the collapse toggle, expanded set, cached levels, and open preview are component-local viewing state. Design rationale: [the workspace file-tree Agent Note](../../../.agents/notes/implemented/feature/2026-08-14-workspace-file-tree-and-preview.md).

## Model Experience

None, as the panel renders Host directory listings and file previews in the browser; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Listing requires the `browse` directory-picker capability** — under the `native` backend `host.listDirectory` answers `directory-picker-unavailable` and the panel shows its retriable error row; the [`-auto` chooser](../../host/directory-picker-auto/README.md) resolves `native` on desktop loopback deployments, so the default desktop composition hits exactly this until listing decouples from the picking seam.
- **Remote preview inherits deployment authentication** — [`host.readFile`](../connection/README.md) is privileged because it reads arbitrary Host files; loopback reaches it directly, while a `trustedHosts` deployment must authenticate callers before the RPC bridge.
- **Per-level 1000-entry bound** — the backend's `maxEntries` window cuts directories and files as separate windows; the panel states the truncation and offers no paging.
- **No symlinked-file rows** — the `files` window reports regular files only, so a file behind a symlink never appears (directories keep the picker's follow-for-enterability rule).
- **No persisted expansion state** — expansion, cached levels, and the collapse toggle reset on remount and on every root change.
