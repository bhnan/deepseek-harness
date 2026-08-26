# Agent Note: 实验性基础 Web 鉴权是原始 listener 适配器

Status: implemented

[English](2026-08-26-experimental-basic-web-auth.md) | 中文

## 问题

远程 trusted-host 组合需要在 Web RPC carrier 之前设置鉴权层，但服务器部署中的 `dsh-auth-basic` 代码是一个未跟踪、带有凭据的目录，并直接访问 `dsh-host-webserver` 的原始 Node listener。把该目录复制到 release 包会把服务器凭据和私有实现依赖混进产品主干。

## 决定

`@deepseek-ai/dsh-experimental-auth-basic` 是一个私有实验性 bundle。它保留已部署的登录页、时序安全的共享凭据比较、已签名的内存会话 cookie、HTTP/API 请求拦截和升级请求拦截。它的 `cordis.patch.yml` 只读取 `DSH_AUTH_BASIC_*` 环境表达式，profile 会把它挂载在 `dsh-base` 与 `dsh-web-app` 之间。

该包刻意适配当前 `dsh-host-webserver` 的原始 listener，而不是为 WebServer 接口添加方法。listener 替换、重试计时器、会话清理和恢复都归属于一个 Cordis effect，因此卸载插件会恢复原有 Web 请求路径。

## 考虑过的备选

- **添加公开的 WebServer 拦截接口。** 本次迁移不采用：这会创建新的产品接口，需要独立的设计、兼容性和安全决策，而不是保留服务器上已经工作的部署行为。
- **只使用反向代理鉴权。** 当前部署不采用：现有产品行为包含自包含登录页和 HMAC 会话 cookie，而该分支的目标正是把这些行为同步到 fork。
- **将此适配器作为 release 包发布。** 不采用：原始 listener 属于私有实现知识，而单用户内存会话模型没有稳定支持承诺。

## 后果

- 该分支不包含服务器用户名、密码、session secret、主机路径或其他服务器专属 profile 配置。
- 该适配器不提供 Harness 设置 UI 或插件 UI；它只在普通 Web 应用之前提供独立登录页。
- 对于此部署模型，远程页面要以足够安全的方式到达 DSH 特权方法，需要采用 [trusted-host 决策](2026-08-25-trusted-host-privileged-methods.zh.md) 中的适配器。
- 包的真实 Loader 组合测试固定了登录、拒绝、已鉴权转发、登出和 listener 恢复；它并未使原始 listener 依赖成为受支持的 WebServer 接口。
- 该适配器保留服务器实现的进程本地会话和错误转交行为，因此 HTTPS、反向代理控制和可信插件安装仍是部署职责。
