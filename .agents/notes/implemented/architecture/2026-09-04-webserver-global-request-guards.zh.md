# Agent Note: WebServer 全局请求 guard

Status: implemented

[English](2026-09-04-webserver-global-request-guards.md) | 中文

## 问题

有些部署策略必须决定每个 HTTP 请求与 WebSocket upgrade，包括不属于任何具名 route 的静态回退。替换 `node:http` 的 request 与 upgrade listener 会触及私有实现细节，丢弃 WebServer 的错误与 socket 所有权，还可能绕过由其他 route handler 所有的浏览器令牌认证与 Host/Origin 校验。

## 决策

`dsh-host-webserver` 持有 Node listener，并在 `ctx.webServer` 上提供 `registerRequestGuard` 和 `registerUpgradeGuard`。guard 按注册顺序在 HTTP route 或 upgrade-route 查找前运行。HTTP guard 返回 `true` 时继续，或完成自己拥有的响应后返回 `false`；upgrade guard 返回 `false` 时由 WebServer 关闭候选 socket。每次注册都会返回 disposer，因此贡献它的插件通过自己的 Cordis effect 拥有 guard 生命周期。

具名 route 的匹配仍与顺序无关。guard 顺序是有意定义的策略顺序，不改变路由所有权。WebServer 仍拥有 listener 错误、upgrade socket 跟踪与资源释放。

`dsh-auth-basic` 同时使用两类注册。它让 `GET /?token=...` 继续，使 `dsh-client-connection` 能在 basic authentication 重定向到登录前交换浏览器启动令牌。浏览器完成两次交换后即可进入普通静态、API 与 WebSocket 路径；每个 API 与 upgrade 请求仍会经过既有浏览器会话与 Host/Origin 校验。

## 验证

WebServer 的真实 Loader 组合 spec 覆盖有序 HTTP guard 执行、响应拒绝、guard 释放、被阻止的 upgrade，以及释放后允许的 upgrade。使用 `dsh-auth-basic` 的临时 `dsh web` 组合验证了启动令牌交换、登录重定向、密码登录、已认证的静态页面与 API 访问、允许的已认证 WebSocket，以及未认证 upgrade 的关闭。

## 曾考虑的替代方案

**替换原始 Node listener。** 插件会在移除由 WebServer 安装的 handler 时接管私有 listener 顺序、响应失败和 socket 释放。它无法与服务器生命周期或其他策略插件安全组合。

**只包装 SPA 回退或注册 catch-all route。** 具名 route 与 upgrade route 仍在策略之外，回退包装器也不能先于每个静态或 API 响应执行。

**把部署认证移入 `dsh-client-connection`。** 浏览器会话认证属于 API 传输，并继续归它所有。把用户名密码会话策略加入该包会让一种部署选项变成浏览器传输要求。

## 后果

认证及其他全服务器策略插件有一条公共注册路径，并在释放后不保留回调或 session。guard 返回 `false` 却没有完成响应会违反 API，并使其客户端继续等待。WebServer 核心仍保持策略中立：它不提供凭据、不选择 guard，也不让网络部署成为受支持能力。

本决策补充[Web 配置树启动与传输分层](2026-07-24-web-config-tree-boot-and-transport-layering.zh.md)，后者仍拥有功能 route 的职责；也补充[浏览器启动令牌认证](2026-08-24-browser-token-authentication.zh.md)，后者仍拥有浏览器会话与请求信任规则。
