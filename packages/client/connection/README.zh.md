---
description: "Web GUI 的浏览器-Host 线层：Remote RPC、带重连的事件流投递、精确 Fetch 路由、/api HTTP 桥与浏览器信任栅栏。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-connection

[English](README.md) | 中文

## 概述

本包承载浏览器到 Host 的 Remote 调用、精确 Fetch 响应与 connection generation。Client 插件挂载 `ctx.connection`，其中包含当前页面的 loopback 状态、通用 RPC、当前 generation 及其 Host 信息、可观察的恢复状态、立即重连命令，以及单一 generation source 的注册点。source 报告 ready 后 generation 才可见；source 结束、失败、被撤回或显式 stop 都会清空它，再由 `ConnectionController` 执行重试策略。

## 目录

- [使用本包](#use-this-package)
- [浏览器认证与请求信任](#browser-authentication-and-request-trust)
- [Connection generation](#connection-generation)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

浏览器通过 HTTP POST 执行 Remote 一元调用。API Gateway 自己拥有 `/api/remote.mux` WebSocket 及其逻辑流。进程内组合通过 `connection.rpc.open` 提供等价的 Remote 流，不打开 WebSocket。Host half 拥有唯一 `/api` route、Fetch bridge、浏览器认证、Host/Origin 校验与精确 `GET`/`HEAD`/`POST` 路由注册表。每条精确路由会在 bridge 读取任何字节前声明缓冲或流式请求体处理方式。Typert Gateway 认领生成的 Remote endpoint，功能包注册 Session 日志下载、原始文件上传等非 JSON 响应，未认领的请求返回 404。Loopback hostname 判定只供浏览器侧当前页面状态使用，留在包内。浏览器原始请求体传输由 [`dsh-client-file-upload`](../file-upload/README.zh.md) 提供。

-----

<a id="browser-authentication-and-request-trust"></a>
## 浏览器认证与请求信任

每个 Host RPC 方法和 WebSocket stream 都要求同一个浏览器会话，不存在按方法区分的 loopback 层。`passwordLogin` 缺失时，token 模式生成一个随机进程 token。`dsh-web-app` 打印并打开带 `?token=...` 的根 URL；`frontend-static` 只在 `GET /` 接受该 token，写入绑定 authority 的签名 cookie，再重定向到干净的 `/`。HTTP 载体不在这次根路径交换之外接受 query token，也不接受 Authorization header token。token cookie 通过 `cookieMaxAgeDays` 的默认值拥有 30 天绝对有效期，并为随附的 loopback HTTP 应用刻意不设置 `Secure`。

`passwordLogin` 存在时，它选择一个由部署管理的账户并关闭 token 接受。Web 应用打印并打开干净的根 URL。`GET /auth/login` 提供由 `Accept-Language` 选择、由 Host 直接提供的英文或中文表单；`POST /auth/login` 在表单凭据有效后签发会话，精确的 `POST /auth/logout` 只使请求浏览器在该 authority 上的 cookie 过期。登录页绝不包含已配置的凭据值。没有有效会话的受保护 index 请求返回 401，可信但没有有效会话的 API 请求也一样；非 index 静态资产仍然公开。

| `passwordLogin` 字段 | 默认值 | 语义 |
|---|---:|---|
| `username` 与 `password` | — | 两者都必填且非空；畸形配置会导致加载失败，且不暴露任一值。 |
| `sessionMaxAgeDays` | `7` | 密码会话的绝对有效期（天）；必须至少为 7。 |
| `failureDelayMs` | `500` | 通用登录失败延迟（毫秒）；不得超过 10,000。 |
| `secureCookie` | `true` | 向密码会话 cookie 添加 `Secure`。 |

cookie 签名密钥是 `ctx.credentials` 中由 `client-connection/browser-session` 拥有的 grant 记录。本地提供方把它持久化到 `$DSH_HOME/.credentials.yaml`；`BrowserAuth` 在 Connection 激活期间加载或创建该记录，并把密钥留在内存中，因此请求认证同步执行。删除或替换该记录会在下一次 Connection 激活时生效。所有 cookie 都在确定性名称与签名 payload 中绑定规范化 hostname 和 port，是 host-only、`Path=/`、`HttpOnly`、`SameSite=Strict`，并带有绝对签发与过期时间。密码 cookie 为 v2，额外携带带键的凭据版本和随机 session id，绝不携带密码、密码 hash 或签名密钥。独立浏览器和设备可以同时持有有效 cookie；更改已配置凭据并重启 DSH 会使每个密码 cookie 失效，跨重启保持不变的凭据会保留它们。

认证之前，每个 `/api` 请求和每条密码路由都经过 `src/api-request-trust.ts`。其 `Host` 必须是 loopback，或与 `trustedHosts` 条目匹配：带端口的 `host:port` 精确匹配，不带端口的条目匹配任意端口，两侧均经 WHATWG 归一化。若附带 `Origin`，它必须等于该 Host；`sec-fetch-site: cross-site` 一律拒绝。只有发往 `POST /auth/login` 的原生同源文档导航可使用字面量 `Origin: null`，且必须同时带有 `Sec-Fetch-Mode: navigate` 与 `Sec-Fetch-Dest: document`；`/api`、登录 GET 与 logout 继续使用严格规则。畸形配置 authority 会让插件加载失败。这些检查防御 DNS rebinding 与跨站浏览器请求，绝不建立身份。Host/Origin 校验失败会在读取登录 body 前返回 403；Host 可信但未认证的请求返回 401。`dsh web --host 0.0.0.0` 仍不受支持。决策记录：[浏览器请求信任](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.zh.md)、[浏览器 token 认证](../../../.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.zh.md)与[Web 密码认证](../../../.agents/notes/implemented/architecture/2026-09-05-web-password-authentication.zh.md)。

<a id="connection-generation"></a>
## Connection generation

API Gateway Client 把内部 `$events` logical stream 注册为唯一 generation source，与有无 `$on` 订阅无关。Host 在 API Remotes source factory 同步挂好所有增量 listener 后，先发送唯一 `{ type: 'ready', clientId, host: { home } }` 项，再发送事件。`ConnectionController` 仅在收到该 ready 项后发布 generation 并调用 `onConnected`，因此 baseline 不会跑在增量 listener 前面。

`$events` 结束、返回 Remote stream error、收到非 ready 首项或畸形事件项，都会使当前 generation 失效。浏览器报告网络可用时，Controller 发布 `connecting`，并在 500ms、1s、2s、4s、8s 与 10s 上限内采用 50%–100% 抖动重试。它记录每次尝试、要求 Gateway 替换物理 WebSocket，再重开 `$events`；10s 档失败后发布终态 `disconnected`。`ctx.connection.reconnect()` 会中断活动工作、重置序列，并立即开始 retry 1。浏览器 `offline` 会中断活动工作、发布 `disconnected` 并暂停自动尝试；下一次 `online` 转换会重置序列并从 500ms 档开始。ready 项会发布 `connected`。Gateway mux 每次收到请求只做一次物理连接尝试，不再运行另一套重试调度。[连接恢复决策](../../../.agents/notes/implemented/feature/2026-08-28-web-connection-recovery-control.zh.md)规定重试节奏和手动恢复行为。

<a id="model-experience"></a>
## 模型体验

无。协议消费层只在浏览器与主机之间搬运已经组合好的消息；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **缓冲型 `/api` 路由会把每个请求体保留在内存里**：`maxRequestBodyBytes`（默认 300 MiB，按默认 200 MiB 图片总量上限经 base64 膨胀加信封余量得出）限制普通图片与 RPC 信封。显式启用的流式路由接收带背压的分块并绕过总量上限；路由实现负责持久化、取消与存储配额。
- **密码登录是一个共享账户**：它没有外部 IdP、角色、多账户支持、设备清单或按设备的服务端撤销。`POST /auth/logout` 只会使请求浏览器的 cookie 过期；凭据轮换加 DSH 重启会使每个密码会话失效。
- **密码模式预期 TLS 面向浏览器的部署**：`secureCookie` 默认是 `true`；将其设为 false 只改变 cookie 属性，不改变仅 loopback listener 或代理身份策略。密码认证决策定义预期的 Caddy 部署姿态。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。授权请求会异步读取 credential 权威记录，commit-event 生命周期由 credentials 伴生入口负责；流、重连、rpcId 与路由释放关系由行为测试及 webserver 不变式覆盖。
