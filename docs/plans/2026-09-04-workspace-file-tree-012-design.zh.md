# 工作区文件树与预览 — 0.1.2 设计

[English](2026-09-04-workspace-file-tree-012-design.md) | 中文

## 结果

Web GUI 在工作区/会话浏览器下方新增一个只读文件树，并为活动 Session 的 Workspace 提供有边界的应用内预览。文件仍可交给 Host 操作系统的默认应用打开。

## 范围

本增量只移植文件树浏览和预览。工作区上传、移动端文件选择器、安装器打包，以及任何 trusted-host 策略变更都不在范围内。

## 架构

`@deepseek-ai/dsh-api-workspace-controller` 新增一个 `workspaceFiles` Remote namespace。它的 Host controller 列出一个绝对路径目录层级，并读取一个绝对路径的常规文件，且由服务端施加边界。它独立于 `directoryPicker`：picker 决定操作员如何选择 Workspace，而只读树在当前桌面部署组合了原生 picker 时也必须工作。

controller 仅接受当前平台上的完整 Host 路径。它返回排序后的目录和常规文件两个独立有上限的窗口，将可进入的目录符号链接视作 picker 一样处理，并排除文件符号链接。预览返回最多 256 KiB 的 UTF-8 文本头、最多 8 MiB 的已识别图片（base64 加 MIME），或不带内容的二进制结果。失败、非常规或非完整路径的读取成为类型化 Remote 失败；调用者取消则成为 `gateway/cancelled`。

`@deepseek-ai/dsh-client-ui-file-tree` 填充一个新的 `sidebar.filetree` 单一槽位。它的根是活动 Session 已注册的 Workspace 路径，回退为该 Session 记录的 cwd。每个层级只在展开时加载，并在刷新、重试、根切换或卸载前保持缓存。预览对话框渲染文本、图片或二进制回退；它的外部打开动作复用 `ctx.remote.session.openWorkspacePath`。

## 认证与信任边界

`packages/client/connection` 不作改动。新的 Remote 调用与既有生成的 Remote 调用一样使用 `/api` 路由，因此 Host/Origin 信任栅栏和 BrowserAuth cookie 检查会在列出或预览 Host 文件前执行。本移植不恢复已移除的 trusted-host 例外，也不引入静态文件路由或第二套认证机制。

## 集成点

- `WorkspaceController` 加载新的 Host controller，使该包生成的 `/remote` contribution 暴露 `ctx.remote.workspaceFiles`。
- `api-remotes` 继续选择现有 workspace-controller contribution；它的 Client facade 重新导出新的客户端安全结果类型。
- `ui-sidebar` 声明并渲染仅宽屏、限高的 `sidebar.filetree` 区域，位于工作区浏览器与页脚之间。
- Web bundle 列出新的 client package，并拥有其 workspace 依赖。

## 验证

Host 测试覆盖路径限定、排序的独立边界、目录符号链接处理、预览上限、二进制回退与取消。Client 测试覆盖槽位生命周期、惰性加载、重试/重置/中止行为、文本/图片/二进制预览、以及尽力的系统打开。GUI 和浏览器快照套件必须保持绿色。已实现的 Agent Note 将记录已交付能力与 BrowserAuth 边界，并配有中文对应文件。
