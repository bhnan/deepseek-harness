# Auth-basic 0.1.2 适配规范

[English](2026-09-04-auth-basic-012-spec.md) | 中文

`dsh-host-webserver` 提供有序的 HTTP 与 upgrade guard。guard 会在路由查找前接收每一条请求；HTTP guard 返回 `true` 时继续，或自行应答后返回 `false`。upgrade guard 返回 `true` 时继续，或返回 `false` 让 WebServer 关闭 socket。注册操作返回一个 disposer。

`dsh-auth-basic` 使用这些 guard，而不是访问原始 Node listener。它的登录和登出端点保持公开，登录写入已签名的 session cookie，已认证请求继续走正常 DSH 路由，所有未认证路由保持既有的重定向或 401 行为。

这些 guard 独立于 DSH client-connection 信任机制。请求必须通过 auth-basic；当对应路由要求时，也必须通过既有的 Host/Origin/token 检查。
