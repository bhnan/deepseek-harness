---
description: "Read-only workspace file-tree and bounded preview panel for the wide Web sidebar."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-file-tree

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-client-ui-file-tree` fills the wide-sidebar `sidebar.filetree` slot with a read-only tree rooted at the active Session's Workspace, falling back to that Session's cwd. It opens bounded text and image previews through the existing authenticated `workspaceFiles` Remote namespace and can hand a selected file to the Host's normal external-open action. Load it in the Web bundle beside `ui-sidebar`, `ui-workspace`, and `dsh-api-workspace-controller`; it deliberately adds no static file route and no authentication path of its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Compose this browser-only plugin with the workspace Remote controller and sidebar. The panel appears only in the wide sidebar and only when the current Session has a Workspace path or cwd. Expanding a directory fetches one level from `ctx.remote.workspaceFiles`; choosing a regular file opens its bounded preview. The refresh control discards cached levels for the active root, while a root change or unmount aborts outstanding requests rather than retaining an old directory tree.

The external-open control delegates to `ctx.remote.session.openWorkspacePath`. The file's bytes never pass through a browser-owned static route: all listing and preview calls retain the existing `/api` BrowserAuth and trusted-host checks.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The client injects one `sidebar.filetree` slot registration and one `filetree` locale namespace as Cordis effects, making both disposable on HMR or plugin teardown. `FileTreePanel` keeps expanded state, level results, and request controllers locally. A level is cached only after its request settles successfully; retry and refresh create a replacement `AbortController`. The panel branches on the typed Host preview result: text is shown in a wrapped `pre`, an allowed image is rendered from its returned MIME/base64 pair, and a binary result intentionally has no browser-side content renderer.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace Controller](../../api/workspace-controller/README.md) — owns the `workspaceFiles` Remote contract and Host bounds.
- [Workspace subsystem](../../../docs/subsystems/workspace.md#workspace-file-tree) — documents the file-tree payloads and access boundary.
- [UI Sidebar](../ui-sidebar/README.md) — declares and renders the `sidebar.filetree` slot.
- [Web Server subsystem](../../../docs/subsystems/web-server.md) — owns the route and policy-guard layer under the existing BrowserAuth composition.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package is browser chrome and does not add prompt content, tools, provider parameters, or model-visible session events.

#### KV Cache effect

None; file browsing and previews do not alter model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The tree is read-only: it does not search, upload, rename, delete, or edit files.
- Directory levels are bounded by the Host, and previews are bounded text/image heads; large or binary files intentionally show no content.
- The panel's cache is local to the mounted active root and is lost on refresh, root changes, and plugin teardown.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** Every browser file operation goes through the generated `workspaceFiles` or Session Remote namespace; this package never opens a direct filesystem or unauthenticated HTTP path.
