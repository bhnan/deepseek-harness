# Agent Note：Web 工作区文件上传

Status: implemented

[English](2026-08-31-web-workspace-file-upload.md) | 中文

## 问题

Web 输入区已经可以持久化粘贴和拖入的图片，但通用文件还没有进入当前 Workspace 的持久交接路径。浏览器 `File` 对象或临时路径不适合作为可迁移的输入：页面关闭或重载后它会消失，或者 Host 侧 agent（智能体）无法读取。因此，用户无法把文档移动到 agent 已经知道如何检查的同一个 Workspace 中。

[Web 多模态图片输入 Note](2026-07-22-web-multimodal-image-input-and-durable-attachments.zh.md) 有意将图片内容保持为独立的持久附件类型，而[文件与会话引用 Note](2026-07-27-web-file-and-session-references.zh.md) 定义了仅包含路径的 `@file` 引用和 agent pre-step 读取。通用工作区上传需要连接这两个已有边界，同时不能让浏览器把任意文档变成模型内容。

## 决策

Host 通过已有的认证 JSON RPC 边界暴露 `workspace.uploadFile`。每次请求为一个已注册 Workspace 携带浏览器文件名、可选媒体类型和 base64 数据。Host 解码并限制载荷大小，创建私有的 `<workspace>/uploads/` 目录，清理文件名，拒绝符号链接逃逸，并返回工作区相对路径、字节数、SHA-256 及可选媒体类型。默认单文件解码后上限为 32 MiB，可用 `workspaceUploadMaxBytes` 覆盖。

Web 输入区按声明的图片 MIME 类型对每次拖入或粘贴的文件分流。图片保留现有附件栏、准入策略、持久图片内容和历史渲染。非图片文件经过 `workspace.uploadFile`；成功后，输入区在当前草稿光标处插入仅包含路径的 `@file` 引用。agent（智能体）及其已有的文件系统工具决定是否以及如何读取或解析该路径。上传路径不增加通用文件预览、历史卡片、进度栏或客户端解析器。

存储辅助模块绝不替换已有路径。相同内容的冲突会复用已有文件；不同内容则在扩展名前添加确定性的短摘要后缀。返回路径使用 `/` 分隔，并始终相对于已注册的 Workspace 根目录。

## 产品行为

- 拖入或粘贴图片的行为保持不变，包括图片限制、预览、发送准入和历史渲染。
- 拖入或粘贴非图片文件会将其存入当前 Workspace 的 `uploads/` 目录，并插入类似 `@uploads/report.pdf` 的仅路径引用。
- 混合输入会独立分流图片和非图片文件，因此通用文件不会进入图片附件栏。
- 上传失败沿用现有 composer toast 路径提示，且不改变草稿文字；上传成功后按上传顺序在当前选区插入引用。
- 没有当前 Workspace 时会在本地拒绝；RPC 仍要求部署已有的认证与 Workspace 授权。

## Host 边界

`workspace.uploadFile` 属于 `WorkspaceApi`、`RpcMethodMap`、fetch handler 和类型化 client。未知 Workspace id 返回 `workspace-not-found`；无效 base64、存储条件不安全和超出大小限制返回 `attachment-error`。该路由不创建公开下载面：文件内容仍通过 agent 已有且已授权的 Workspace 文件系统能力读取。

## Client 边界

`ui-attachment` 只负责分流文档拖放，并通过可选的 `onUploadFiles` owner 回调转交通用文件。`ui-conversation` 根据当前 Session 的成员关系解析 Workspace，读取浏览器字节，调用 API，并用共享的文件引用语法格式化返回的相对路径。该语法拒绝控制字符与引号，因此 Host 会先清理这些文件名字符，再返回可以安全插入的路径。

## 考虑过的替代方案

### 将通用文件字节放进 prompt

否决，因为任意文档不是图片内容，而用户明确希望由 agent 选择解析器。让字节进入模型可见内容还会重复已有文件系统工具路径，并使回放和提供方协议复杂化。

### 只保留浏览器对象 URL 或临时路径

否决，因为重载、进程退出、Docker 替换和不同 Host 进程都可能使这些位置失效。只要保留 Workspace 挂载，Workspace 相对文件就能随部署保存和迁移。

### 增加公开文件下载路由

否决，因为这会扩大暴露的文件系统面，并重复 Workspace 授权。上传沿用已有认证 RPC；agent 通过已经授权的 Workspace 工具读取文件。

### 上传时解析文件

否决，因为解析取决于内容和 agent，会给 Host 边界增加延迟与内存压力，并让上传路径承担模型上下文策略。

## 后果

- 通用文件是 Workspace 下的持久普通文件，因此 Docker 部署只要保留配置的 Workspace volume，文件就会保留。
- v1 路径每个 JSON 请求只上传一个文件，并承担 base64／信封开销；解码后文件上限为 32 MiB。未来的流式 multipart 载体可以提高吞吐，而不必改变相对路径响应约定。
- 上传依赖部署已有的认证、Workspace 成员关系和文件系统能力；本变更不增加第二套授权模型。
- 文件不会因为上传就自动进入模型可见内容。prompt 只包含相对路径，是否读取由 agent 决定。
- 没有多文件事务、进度 UI、通用预览或行内解析。批量上传可能部分成功；相同内容复试时会安全复用已有文件。

## 验证

Host 测试覆盖严格 base64 校验、空文件、解码后大小限制、文件名／路径安全、私有上传目录、符号链接拒绝、确定性冲突命名、RPC 分发、未知 Workspace 和业务错误映射。Client 测试覆盖混合拖放分流、仅通用文件拖放、粘贴文件上传、包含带空格路径的引用插入和 API 字节编码。独立工作树会在交回此分支前运行 Host 与 Client 聚焦套件，以及组装后的 GUI／Web 回归。
