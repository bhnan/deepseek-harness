# @deepseek-ai/dsh-client-ui-file-tree

[English](README.md) | 中文

工作区文件树插件：把可折叠的目录／文件树和应用内文件预览填入侧边栏外壳的 `sidebar.filetree` 区带（[ui-sidebar](../ui-sidebar/README.md)）。树根是当前活动 Session 所属 Workspace 的路径；Session 不属于任何 Workspace 时回退到其记录的 cwd；两者皆无时面板什么都不渲染，区带收缩到零高度。树根变化会硬重置所有已缓存层级与展开状态。

层级惰性加载：展开一个目录行会调用 `ctx.workspaces.listDirectory(path, signal, { files: true })`——即[目录选择 seam](../../host/directory-picker/README.md) 的 browse 列举加上其增量 `files` 选项——因此树从不超前于用户扫描；收起的行保留其缓存层级，直到标题栏的刷新一次性丢弃全部缓存。隐藏条目以变暗方式渲染而非被过滤，被截断的分组就地说明截断，失败的层级是可点击重试的行，而重试取代或面板卸载会中止所有在途列举。

点击文件会经 `ctx.workspaces.readFile` 打开预览弹窗，这是一次服务端有界读取：至多 256 KiB 的 UTF-8 文本头部（`truncated` 标注截断）、整幅 base64 编码且不超过 8 MiB 的图片，或对其余内容——包括检出 NUL 的内容与超限图片——给出拒绝预览的 `binary` 判定。底部报告真实字节大小、把只含头部的文本预览标注为截断，并提供系统打开兜底：把路径尽力交给 `host.openPath`，因此被拒绝预览的文件仍有一条抵达路径。

注册经由 `ctx.slots.inject('sidebar.filetree', …)`，因此面板会等待外壳的声明出现，并随本插件的 fiber 一起离开。注入面以普通回调携带三个宿主动作（`listLevel`／`readFile`／`openPath`），插件注册 `filetree` locale 命名空间（zh 默认／en）。这里没有插件 store：折叠开关、展开集合、缓存层级与打开的预览都是组件本地的查看状态。设计依据：[工作区文件树 Agent Note](../../../.agents/notes/implemented/feature/2026-08-14-workspace-file-tree-and-preview.md)。

## 模型体验

无。面板在浏览器中渲染宿主的目录列举与文件预览；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包（package）既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **列举依赖 `browse` 目录选择能力**：在 `native` 后端下 `host.listDirectory` 应答 `directory-picker-unavailable`，面板显示可重试的错误行；[`-auto` 选择器](../../host/directory-picker-auto/README.md)在桌面回环部署上会解析为 `native`，因此默认桌面组合恰好命中此处，直到列举与选择 seam 解耦。
- **`host.readFile` 只限回环特权**（[dsh-client-connection](../connection/README.md)）：受信任的非回环部署能列举层级，但每次预览读取都会被拒绝。
- **单层 1000 条目上限**：后端的 `maxEntries` 窗口对目录与文件各自独立截断；面板说明截断但不提供分页。
- **不显示符号链接文件行**：`files` 窗口只报告常规文件，位于符号链接之后的文件不会出现（目录仍沿用选择器「跟随以判定可进入」的规则）。
- **展开状态不持久**：展开集合、缓存层级与折叠开关在重新挂载与每次树根变化时重置。
