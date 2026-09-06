# Auth-basic 0.1.2 适配意图

[English](2026-09-04-auth-basic-012-intent.md) | 中文

## 问题

本地安装的 `dsh-auth-basic` 插件会直接替换 Node HTTP listener。DSH 0.1.2 在 `dsh-host-webserver` 内部拥有该 listener，因此插件无法可靠地保护 HTTP 路由或 WebSocket upgrade。

## 范围

在保留 0.1.2 浏览器信任与 token 检查的前提下，将 `dsh-auth-basic` 适配到 DSH 0.1.2 WebServer API。这项工作同时解决来自 `bhn/0.1.1-rc.2-patched` 的剩余 trusted-host 兼容冲突。

## 成功条件

- 未认证的浏览器导航重定向到登录页，未认证的 `/api` 请求返回 401。
- 成功登录后可访问普通路由和 WebSocket upgrade。
- DSH 的 trusted-host 与 browser-auth 检查继续拒绝不受信任的来源。
- 插件卸载时不保留请求过滤器、计时器或会话。

## 非目标

本变更不公开服务、不添加 TLS，也不改动 DSH 原生的 browser-auth token 协议。
