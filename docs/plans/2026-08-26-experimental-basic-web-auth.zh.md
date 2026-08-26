# 实验性基础 Web 鉴权实施计划

[English](2026-08-26-experimental-basic-web-auth.md) | 中文

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**目标：** 将服务器的基础 Web 鉴权行为迁入一个不含凭据的实验性 DSH bundle，并叠加在 workspace-file-tree 分支之后。

**架构：** 该实验性函数插件会在 Web SPA 回退处理之前包装当前 `dsh-host-webserver` 的 Node listener。它保留服务器上的登录表单、已签名的内存会话、HTTP/API 拦截和 WebSocket 拦截，同时在插件 dispose（资源释放）时通过 effect 恢复原始 listener。bundle 仅从 profile 的环境表达式读取凭据，绝不包含部署专用值。

**技术栈：** TypeScript、Cordis Loader、`node:http`、Web Crypto HMAC、Vitest、Schemastery，以及 DSH 的双语文档门禁。

---

### 任务 1：注册实验性 bundle 包

**文件：**

- 新建：`packages/experimental/auth-basic/package.json`
- 新建：`packages/experimental/auth-basic/tsconfig.json`
- 新建：`packages/experimental/auth-basic/cordis.patch.yml`
- 修改：`tsconfig.base.json`
- 修改：`tsconfig.host.json`
- 修改：`packages/experimental/README.md`
- 修改：`packages/experimental/README.zh.md`
- 修改：`packages/experimental/README.i18n.yaml`

**步骤 1：** 添加私有的 `@deepseek-ai/dsh-experimental-auth-basic` manifest、其 bundle patch、项目引用和源码解析别名。

**步骤 2：** 让 patch 要求 `DSH_AUTH_BASIC_USERNAME` 和 `DSH_AUTH_BASIC_PASSWORD`，并允许可选的 `DSH_AUTH_BASIC_SESSION_SECRET`；不得加入字面量凭据。

**步骤 3：** 运行 `pnpm run verify-cordis-config` 和 `pnpm run check-workspace-constraints`。

### 任务 2：先规定可观察的鉴权行为

**文件：**

- 新建：`packages/experimental/auth-basic/tests/auth-basic.spec.ts`

**步骤 1：** 编写真实 Loader 组合测试，启动 `dsh-host-webserver`，在 `dsh-host-frontend-static` 之前挂载鉴权插件，并覆盖实际对外 HTTP 行为。

**步骤 2：** 断言未鉴权 API 拒绝、登录页、失败与成功登录、带 cookie 的 SPA 请求、登出，以及 fiber dispose 后 listener 的恢复。

**步骤 3：** 对该组合的真实登录页做快照，然后运行 `pnpm exec vitest run packages/experimental/auth-basic/tests/auth-basic.spec.ts`，并在实现出现前确认预期的 red 失败。

### 任务 3：迁移不含服务器凭据的插件

**文件：**

- 新建：`packages/experimental/auth-basic/src/index.ts`
- 新建：`packages/experimental/auth-basic/src/invariant.ts`

**步骤 1：** 从服务器插件迁移登录表单、时序安全的凭据比较、HMAC cookie 编解码、内存会话存储、HTTP 拦截和升级请求拦截。

**步骤 2：** 将计时器、重试、listener 替换和 listener 恢复纳入 Cordis effect，使源码包可以卸载；不得改变正常鉴权判定。

**步骤 3：** 添加带有包专属无运行时 invariant 说明的 invariant 配套插件，再次运行聚焦测试直至 green。

### 任务 4：记录配置与刻意保留的限制

**文件：**

- 新建：`packages/experimental/auth-basic/README.md`
- 新建：`packages/experimental/auth-basic/README.zh.md`
- 新建：`packages/experimental/auth-basic/README.i18n.yaml`
- 新建：`.agents/notes/implemented/architecture/2026-08-26-experimental-basic-web-auth.md`
- 新建：`.agents/notes/implemented/architecture/2026-08-26-experimental-basic-web-auth.zh.md`
- 新建：`.agents/notes/implemented/architecture/2026-08-26-experimental-basic-web-auth.i18n.yaml`

**步骤 1：** 记录 profile bundle 顺序、必需环境值、已鉴权远程 trusted-host 前提，以及内存会话行为。

**步骤 2：** 记录这是私有 Node listener 上的实验性适配器，而不是新的 `WebServer` 扩展点，并交叉链接 trusted-host 决策。

**步骤 3：** 对每个变更的双语对侧运行 `pnpm run verify-translation-pairing --write <pair>` 重新记录。

### 任务 5：验证、提交并发布堆叠分支

**文件：**

- 修改：仅当所属生成器产生变化时，修改生成的配置和模块图文档

**步骤 1：** 运行聚焦 Vitest 测试、包类型检查／构建、配置与 invariant 检查、相关文档检查，以及 `git diff --check`。

**步骤 2：** 按变更路径运行仓库的 pre-push 选择，再创建一个聚焦提交。

**步骤 3：** 推送 `feat/workspace-file-tree-auth-basic`，不改写任何已有远端分支。
