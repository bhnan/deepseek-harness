# Agent Note：特权 /api 方法按 trustedHosts 解析

Status: implemented

[English](2026-08-25-trusted-host-privileged-methods.md) | 中文

## 问题

`/api` 的特权方法集合（`host.pickDirectory`、`host.openPath`、`host.readFile`、整个 `settings.*`／`credentials.*` 配置面、`llm.discoverModels` 与 `agentPreset` 编辑面）把浏览器信任栅栏传入了一个**空**信任列表，因而被固定在回环请求上——理由是 `trustedHosts` 是 DNS rebinding 栅栏，不是鉴权。于是由鉴权反向代理（例如带 HMAC 签名会话 cookie 的 `dsh-auth-basic`）承载的公开部署无法使用文件预览或设置／凭据面：来自其已声明服务 authority 的每个特权 RPC 都得到 `403`。

## 决定

特权方法栅栏按配置的 `trustedHosts` 解析（`!isTrustedApiRequest(request, trustedHosts)`），并在客户端一侧将任意已提供页面的 authority 视为回环（`connection.isLoopback: true`），让设置／凭据镜像能在已鉴权远程页面中打开。该栅栏仍是混淆代理人防御；放宽的前提是服务组合会在 RPC bridge 前鉴权远程调用者（Web carrier 自身仍不提供鉴权层）。

## 考虑过的备选

- **保留空信任列表，并增加单独的配置开关。**否决：部署已经在路由层守住每个请求；第二个标志只是对同一栅栏输入重复开关。
- **只允许读取。**否决：`settings.update`／`mutate` 与 `credentials.set` 正是远程管理页要编辑的内容；在没有调用者区分的情况下拆分读写只会增加表面。

## 后果

- 鉴权代理后的 trusted-host 组合可以到达文件预览以及 settings／credentials／agentPreset 面。
- 信任 host 却没有鉴权的组合，会将这些方法暴露给任意 `Host` 匹配的调用者——栅栏不再单独把它们固定到回环。
- 上游的回环专属测试（`pins privileged methods to loopback even for a declared trusted authority`、`answers a declared LAN authority with 403 on every configuration method`）更新为验证放宽后的边界，以及仍会被拒绝的未声明 authority。
- 部分取代[api 浏览器信任边界决策](../../implemented/architecture/2026-07-28-api-browser-trust-boundary.zh.md)：该 Note 的 carrier 级栅栏架构与媒体类型栅栏仍然有效，但其中「特权方法携带空信任列表通过」的后果不再成立；本 Note 保留并交叉链接这项边界决策。
