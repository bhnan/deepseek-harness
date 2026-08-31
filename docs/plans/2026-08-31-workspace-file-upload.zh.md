# 工作区文件上传实施计划

[English](2026-08-31-workspace-file-upload.md) | 中文

> **For Claude：** REQUIRED SUB-SKILL：使用 superpowers:executing-plans 按任务执行此计划。

**目标：** 为 Web composer 增加有大小上限且经过认证的工作区文件上传路径，同时保留现有图片附件流程，并将解析交给 agent（智能体）。

**架构：** 将持久化保留在 Host 侧的深层存储辅助模块中，通过现有的 `workspace.*` RPC 接缝暴露，并扩展当前的 conversation 附件 slot，将图片拖放与通用工作区上传分流。Client 只插入路径引用；agent 已有的文件系统工具负责读取内容。

**技术栈：** TypeScript、Cordis、Zod、Node `fs/promises` 与 `crypto`、React、Vitest、pnpm。

---

## 任务 1：添加 Host 工作区上传存储模块及测试

**文件：** `packages/host/apiproxy/src/workspace-upload.ts`、`packages/host/apiproxy/tests/workspace-upload.spec.ts`

1. 为有效 base64 写入 `uploads/`、返回相对路径和 SHA-256、空文件、错误 base64、32 MiB 上限、分隔符／控制字符清理、符号链接 `uploads` 和确定性冲突处理编写失败测试。
2. 运行 `pnpm exec vitest run packages/host/apiproxy/tests/workspace-upload.spec.ts`，确认新测试因模块不存在而失败。
3. 实现带明确输入／结果类型的辅助模块、严格 base64 解码、可配置字节上限、私有上传目录创建、安全文件名规范化、防止路径逃逸以及原子／不覆盖的最终落盘。
4. 重新运行聚焦测试直到通过，并提交存储切片。

## 任务 2：通过 Host RPC 约定暴露 `workspace.uploadFile`

**文件：** `packages/host/apiproxy/src/api/workspace.ts`、`packages/host/apiproxy/src/api/workspace.schema.ts`、`packages/host/apiproxy/src/api/rpc-map.ts`、`packages/host/apiproxy/src/fetch/handler.ts`、`packages/host/apiproxy/src/fetch/client.ts`、`packages/host/apiproxy/src/api-proxy.ts`、`packages/host/apiproxy/src/index.ts`

1. 增加请求／响应约定，并在已有 API proxy 测试文件中为有效载荷、错误载荷和响应解码编写失败的路由／schema 测试。
2. 运行范围窄的 API proxy 测试，确认新路由尚未出现在编译器锁定的 map 或分发表中。
3. 增加路由 schema、值 schema、map 行、client 方法和 Host 实现。通过 `ctx.workspaceRegistry` 解析 Workspace id；将未知工作区映射为 `workspace-not-found`，将存储校验失败映射为 `attachment-error`。
4. 在 `ApiProxyDefaults` 与 `ApiProxyService.Config` 中增加 `workspaceUploadMaxBytes`，默认使用存储辅助模块的 32 MiB 上限。
5. 更新 `IApiClient` 约定所需的所有类型化 fake／fixture，运行聚焦 Host／connection 测试以及 Host 类型构建。
6. 提交 RPC 切片。

## 任务 3：增加 Client 上传回调和路径插入

**文件：** `packages/client/ui-conversation/src/client/contract/slots.ts`、`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx`、`packages/client/ui-conversation/src/client/apply.ts`、`packages/client/ui-conversation/src/client/locales.ts`、`packages/client/ui-conversation/tests/input-bar.client.spec.tsx`

1. 为混合文件接收、成功上传并插入仅路径引用、拒绝上传时保留草稿以及没有当前 Workspace 时显示错误编写失败测试。
2. 运行聚焦 InputBar 测试，确认上传行为尚不存在。
3. 增加窄化的注入回调和工作区文件结果类型，根据当前会话成员关系解析 Workspace id，编码浏览器字节，调用新的 API 方法，并使用现有输入状态机写入路径安全的 `@file` 文本。
4. 增加上传／拖放／错误的本地化文案，并保留所有现有图片预检和图片提交行为。
5. 运行聚焦 conversation 测试并提交 Client 编排切片。

## 任务 4：通过附件呈现 slot 分流通用文件拖放

**文件：** `packages/client/ui-attachment/src/client/ComposerAttachments.tsx`、`packages/client/ui-attachment/src/client/labels.ts`、`packages/client/ui-attachment/tests/composer-attachments.client.spec.tsx`、`packages/client/ui-conversation/src/client/contract/slots.ts`

1. 为仅通用文件和混合拖放、禁用拖放、上传回调转发以及不变的图片回调编写失败的组件测试。
2. 运行聚焦附件测试，确认通用文件仍被发送到图片回调。
3. 按图片 MIME 类型分流拖入文件，为图片调用图片回调，为通用文件调用异步工作区回调，并保持两种类型一致的文档拖拽遮罩行为。
4. 更新包 README 限制与本地化文案，分别说明通用工作区上传和图片附件。
5. 运行 `pnpm exec vitest run packages/client/ui-attachment packages/client/ui-conversation` 并提交 UI 切片。

## 任务 5：整合 bundle、Note 和本地验证

**文件：** 按仓库检查需要更新的包元数据／README，必要时更新 `packages/bundle/web-app/cordis.patch.yml`，以及 `.agents/notes/implemented/feature/2026-08-31-web-workspace-file-upload.md`、`.agents/notes/implemented/feature/2026-08-31-web-workspace-file-upload.zh.md`

1. 增加已实现的 Agent Note，并交叉链接已有图片附件 Note 和文件引用 Note，不改变它们的归属边界。
2. 运行与变更文件相关的包不变量、Client domain、文档和翻译配对检查；如果门禁发现问题，修复生成文件／包引用。
3. 使用 `pnpm run test:gui` 运行完整聚焦 GUI 套件，然后构建 Web profile，并在可用时运行本地 Web 回归。
4. 在独立工作树中手动验证临时工作区上传，确认文件位于 `uploads/` 下，确认草稿包含相对 `@file` 引用，并确认再次运行不会修改用户的 `feat/workspace-file-tree` 主工作树。
5. 检查 `git diff`，报告准确的测试结果和已知 JSON／base64 大小限制，让分支在不 push 或 merge 的情况下可供评审。
