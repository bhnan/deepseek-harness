# Agent Note: Workspace file tree and in-app file preview

Status: implemented

English | [中文](2026-08-14-workspace-file-tree-and-preview.zh.md)

## Problem

The web GUI shows conversations and tool output but no view of the workspace's files: an operator following an agent's work leaves the browser for a terminal or editor to see what exists on disk or what a file now contains. The sidebar needs a read-only file tree rooted at the active Workspace plus a quick in-app preview — without a new filesystem wire surface duplicating what the Host already serves, and without coupling GUI browsing to the model's `ctx.fs` confinement stack. The existing primitives fall short in two specific ways: `host.listDirectory` returns directories only (it was built for the [workspace picker dialog](../architecture/2026-07-28-directory-picker-capability-seam.md)), and no wire method reads file content at all — the session log carries tool output, never arbitrary files.

## Decision

### Listing rides the browse capability, additively

`DirectoryPickerBrowseCapability.list` gains a third parameter, `DirectoryListOptions`; `{ files: true }` makes the listing also carry the level's direct child regular files as optional `files`/`filesTruncated` fields on `DirectoryListing`, and `host.listDirectory` gains the matching optional `files` boolean. Everything new is optional on both the request and the response, so the picker dialog, its wire schema round-trip, and every existing consumer are untouched — the seam extension is purely additive, and a backend that ignores the option still satisfies the contract by omitting the fields.

### Two bounded windows

In `BrowseDirectoryPicker`, files ride their own `maxEntries + 1` streamed window beside the directory window, under the same discipline (name-sorted head, O(maxEntries) memory, binary insertion with O(1) full-window tail rejection, hidden = POSIX dot convention). Separate windows mean a file-heavy level cannot evict directory rows and vice versa; each group reports its own cut (`truncated` / `filesTruncated`). The file window takes only rows the dirent already proves are regular files: following a file symlink would add a stat probe per candidate to every listing, so symlinked files stay absent (directory symlinks keep the existing follow-for-enterability probe).

### Preview is a privileged gateway read on HostApi

`host.readFile` lives on `HostApi` in the gateway, not on the picker capability: reading a file for display is not a directory-picking interaction, and the preview must not change behavior with the composed picker backend. It is also not `ctx.fs` — the same authority-domain ruling the picker seam recorded; the model's confinement stack must never alter GUI behavior. The read is bounded where the complete result is known, server-side: a UTF-8 text head of 256 KiB with `truncated` marking the cut, an extension-recognized image base64-encoded whole up to 8 MiB with its `mime`, and everything else — a NUL in the head, an oversized image — declined as `kind: 'binary'` with no content, which the client answers with a `host.openPath` system-open fallback. A path that is not fully qualified (the same fence as the browse listing: no wire value may resolve against the host cwd or, on Windows, its current drive), unreadable, or not a regular file fails with the new `file-unreadable` code; an abort maps to `cancelled`. The method joins `PRIVILEGED_METHODS` in dsh-client-connection: an arbitrary host-filesystem content read is at least as sensitive as the settings/credentials planes beside it, so loopback reaches it directly while a declared `trustedHosts` authority requires deployment authentication before the RPC bridge.

### The sidebar band and the panel

ui-sidebar declares one new `single` root-scope hole, `sidebar.filetree` — a wide-only band between the browsing region and the foot, capped at 40% of the column height, rendering nothing while empty. The new `@deepseek-ai/dsh-client-ui-file-tree` package registers the panel through `ctx.slots.inject`, with `listLevel`/`readFile`/`openPath` injected as plain callbacks over `ctx.workspaces` and a `filetree` locale namespace (zh default / en). The root is the active Session's Workspace path, else the Session's recorded cwd, else nothing; levels load lazily on expand, one fetch per root lifetime unless explicitly retried, and a root change hard-resets the cache. Expansion, cached levels, and the open preview are component-local viewing state — nothing persists and nothing enters a store.

### The native-picker gap and its follow-up

`host.listDirectory` is served only under the `browse` capability, so under the `native` backend the panel's first fetch answers `directory-picker-unavailable` and renders the retriable error row. The [`-auto` chooser](2026-07-29-directory-picker-adaptive-default.md) resolves `native` on desktop loopback deployments — the shipped default — so the default desktop composition sees exactly that error state. The follow-up direction is to decouple level listing from the picking seam: the capability union discriminates how an operator *picks* a directory, and a read-only tree picks nothing, so the listing primitive belongs either in a capability every backend can serve (Node stdlib is available to all of them) or on the gateway beside `host.readFile`. Until that lands, the limitation is documented in the [package README](../../../../packages/client/ui-file-tree/README.md).

## Alternatives considered

**Extend `ctx.fs` with the tree and preview reads.** Rejected for the reason the picker seam already recorded: swapping the model's filesystem backend must never change GUI behavior, and display listings/previews are not storage primitives.

**A separate listing RPC instead of an option on `host.listDirectory`.** Rejected: a second method would duplicate the bounded-window scan, the fully-qualified path fence, and the error mapping, differing only in whether files are included; the additive option reuses all of it and the picker dialog never sees the change.

**A new picker capability kind for file-capable browsing.** Rejected: the union discriminates operator interaction shapes, and browsing-with-files is the same interaction as browsing; a new kind would force a composition to choose between the picker dialog and the file tree.

**Serving previews from a static file route instead of an RPC.** Rejected: a GET route would sit outside the `/api` unary path where the per-method privileged set and request schemas live; the RPC rides the existing carrier, validation, abort propagation, and privileged-method trust policy unchanged.

**Truncating previews client-side.** Rejected by the standing bounds rule: limits apply where the complete result is known, and shipping an unbounded file over the wire to cut it in the browser is exactly the hole that rule names.

**Following symlinked files in the file window.** Rejected: one stat probe per candidate on every listing prices all consumers for rows the tree renders no differently; recorded as a package limitation instead.

**Persisting expansion state.** Rejected for now: the panel is a live viewing aid over a filesystem that changes underneath it, and a restored deep expansion would re-fetch stale levels nobody asked for; component-local state keeps the cache lifetime equal to the mount.

## Consequences

- The wire gains one optional request field, two optional listing fields, the `host.readFile` method, and the `file-unreadable` error code; every addition is optional or new, so no existing client or backend revalidates.
- The picker dialog's contract is frozen through the change — the additive option means directory-picking consumers cannot observe the extension.
- Under the native picker the tree shows a retriable error rather than content, on the very deployments the auto chooser targets by default; the listing-decoupling follow-up owns the fix.
- `host.readFile` uses the privileged-method trust policy: loopback reaches it directly, while a declared `trustedHosts` authority reaches it only under the deployment's authentication layer.

## Testing

The connection fixture answers `host.readFile` with a deterministic text head, keeping keyless assembled-browser coverage replayable, and the test-support workspaces double records `readFile` calls with a stubbable answer for image, binary, and error flows. Coverage follows the GUI tier map: browse-backend suites pin the second window's bounds, group-independent truncation, and symlinked-file exclusion beside the existing directory-window cases; gateway suites pin the preview bounds, the qualified-path fence, and the `file-unreadable`/`cancelled` mapping; component specs drive the panel's lazy loading, retry, reset, and preview states through the doubles.
