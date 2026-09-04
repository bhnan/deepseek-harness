---
description: "用于宽屏 Web 侧栏的只读工作区文件树与有边界预览面板。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-file-tree

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-client-ui-file-tree` 为宽屏侧栏的 `sidebar.filetree` 槽位提供一个只读文件树。它以当前 Session 的 Workspace 为根，缺失时回退到该 Session 的 cwd；通过既有、已鉴权的 `workspaceFiles` Remote namespace 打开有边界的文本和图片预览，并可将选中文件交给 Host 常规的外部打开动作。请在 Web bundle 中与 `ui-sidebar`、`ui-workspace` 和 `dsh-api-workspace-controller` 一同加载；本包刻意不新增静态文件路由，也不拥有自己的鉴权路径。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把这个仅浏览器端插件与工作区 Remote controller 和侧栏组合起来。面板只在宽屏侧栏中出现，并且只有当前 Session 具备 Workspace 路径或 cwd 时才显示。展开目录会从 `ctx.remote.workspaceFiles` 获取一个层级；选择常规文件会打开其有边界预览。刷新控件会丢弃活动根目录的缓存层级，而根目录切换或卸载会中止未完成请求，不会保留旧目录树。

外部打开控件委托给 `ctx.remote.session.openWorkspacePath`。文件字节绝不经过浏览器所有的静态路由：所有列出与预览调用都保留现有 `/api` BrowserAuth 与受信任 Host 检查。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

客户端将一个 `sidebar.filetree` 槽位注册和一个 `filetree` locale namespace 作为 Cordis effect 安装，因此 HMR 或插件卸载时二者均可释放。`FileTreePanel` 在本地保存展开状态、层级结果与请求控制器。一个层级只有在请求成功结束后才会被缓存；重试和刷新会创建替换用的 `AbortController`。面板按类型化的 Host 预览结果分支：文本在自动换行的 `pre` 中显示，允许的图片由返回的 MIME/base64 对渲染，而二进制结果有意不提供浏览器侧内容渲染器。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Workspace Controller](../../api/workspace-controller/README.zh.md)——拥有 `workspaceFiles` Remote 合约与 Host 边界。
- [工作区子系统](../../../docs/subsystems/workspace.zh.md#workspace-file-tree)——说明文件树负载与访问边界。
- [UI Sidebar](../ui-sidebar/README.zh.md)——声明并渲染 `sidebar.filetree` 槽位。
- [Web Server 子系统](../../../docs/subsystems/web-server.zh.md)——拥有现有 BrowserAuth 组合下的路由与策略 guard 层。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包属于浏览器界面，不会增加提示词内容、工具、provider 参数或模型可见的会话事件。

#### KV Cache 影响

无；文件浏览与预览不会改变模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 文件树是只读的：不支持搜索、上传、重命名、删除或编辑文件。
- 目录层级受 Host 限制，预览为有边界的文本/图片头部；大文件或二进制文件有意不显示内容。
- 面板缓存只属于已挂载的活动根目录，并会在刷新、根目录切换和插件卸载时丢失。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 每一项浏览器文件操作都经生成的 `workspaceFiles` 或 Session Remote namespace 进行；本包从不直接打开文件系统或未经鉴权的 HTTP 路径。
