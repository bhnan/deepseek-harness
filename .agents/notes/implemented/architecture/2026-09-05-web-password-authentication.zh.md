# Agent Note: Web 密码认证

Status: implemented

[English](2026-09-05-web-password-authentication.md) | 中文

## 问题

启动 token 流程通过在启动时打印的 URL 中放入进程凭据，为 loopback 浏览器认证。面向一个公开 authority 的 HTTPS 部署需要人工登录，使启动输出和浏览器交接不带凭据，同时保留完整 Host API 的单一认证规则。

该部署需要一个共享账户和彼此独立的浏览器会话，而不是用户目录、角色系统、外部身份提供方或服务端设备清单。它的 Host/Origin 校验必须继续阻止 DNS rebinding 与跨站请求，且不能被误当作调用方身份。

## 决定

`dsh-client-connection` 在可选 `passwordLogin` 配置存在时选择密码登录。它只接受一个由部署管理的用户名和密码；两者都不能为空，配置失败会隐去它们的值，密码会话默认七天且不能更短，失败登录默认延迟 500 ms、上限为 10,000 ms，`secureCookie` 默认值为 `true`。

在密码模式中，`dsh web` 打印并打开干净的根 URL。Host 拥有精确的 `GET` 与 `POST /auth/login` 路由，以及精确的 `POST /auth/logout` 路由；登录页按 `Accept-Language` 在英文与中文之间本地化，且不含任何已配置的凭据值。共享 Host/Origin 信任校验会在读取登录表单 body 前运行，以 403 拒绝不可信请求，并继续充当 DNS rebinding 与跨站信任栅栏，而不是调用方身份。只有同源文档导航且同时携带 `Sec-Fetch-Mode: navigate` 和 `Sec-Fetch-Dest: document` 时，`POST /auth/login` 才接受字面量 `Origin: null`；每个 API 请求、登录 GET 与 logout 都保留严格的 Origin 规则。没有有效会话的受保护 index 请求得到 401，可信但没有有效会话的 API 调用方也一样。有效登录重定向至 `/`；一次按浏览器的 logout 会使该 authority 的 cookie 过期并重定向至 `/auth/login`。

每次成功登录都会签发一枚独立的 v2 cookie。它是 host-only、`Path=/`、`HttpOnly`、`SameSite=Strict`、绑定 authority、经 HMAC 签名且使用绝对过期时间；当 `secureCookie` 为 true 时携带 `Secure`。其 payload 包含带键的凭据版本和随机 session id，却从不包含用户名、密码、密码 hash 或签名密钥。服务器不存储账户映射或设备状态，因此浏览器与设备可以独立保持登录。更改已配置凭据并重启 DSH 会使所有密码 cookie 失效；跨重启保持不变的配置会保留它们。

预期的公开部署由 Caddy 终止 HTTPS，而 DSH 仅监听 loopback，并通过 `--trusted-host` 声明公开 authority。实现不会配置 Caddy、不会使公开的非 loopback listener 受支持，也不接受转发或代理身份 header。建立调用方身份的是 cookie 认证，不是 Host、Origin 或代理 header。

密码与 token 模式按选择共存，而不是按凭据兼容。当 `passwordLogin` 缺失时，[浏览器启动 token 决策](2026-08-24-browser-token-authentication.zh.md)仍是有效权威，其中包括 token 交换和 30 天 cookie 默认值。启用密码登录时，不接受启动 token 或 token 模式 cookie。

## 考虑过的替代方案

**为登录安装原始 HTTP listener。** 否决：webserver 的精确路由注册表把路由归属、释放和既有 Host/Origin 校验留在同一载体中；并行 listener 可能绕过或复制这些规则。

**接受反向代理身份或转发 header。** 否决：代理提供的 header 不能替代浏览器凭据，除非应用定义并执行一个代理身份系统。本部署不接受这两类 header，并把 Caddy 排除在调用方身份之外。

**集成外部 IdP。** 否决：重定向流、callback 处理、账户映射与提供方生命周期会在没有当前 consumer 的情况下增加另一套身份系统。一个已配置账户是刻意更小的操作。

**保留服务端账户和设备管理存储。** 否决：会话清单、按设备的服务端撤销、角色与多账户管理，并不是独立浏览器 cookie 的必要条件。凭据轮换加重启是全局失效操作；logout 有意按浏览器进行。

**通过 JavaScript fetch 提交登录表单。** 否决：原生表单导航无需客户端 JavaScript，精确的路由级 Fetch-Metadata 例外则为其他每种请求保留 Host 与跨站校验。

## 后果

Web profile 支持一个共享账户和独立的浏览器及设备会话。它不提供外部 IdP、角色、多个账户、设备清单或按设备的服务端撤销。一次 logout 只影响发出请求的浏览器所持有的 cookie；操作者通过轮换凭据并重启 DSH 使每个密码会话失效。

默认的 `Secure` cookie 要求浏览器面向的 authority 使用 HTTPS。将 `secureCookie` 设为 false 是显式选择 cookie 属性，不是支持直接通过公开明文或非 loopback listener 暴露 DSH。Caddy/loopback 姿态和 `--trusted-host` 声明仍是部署责任。

本决策仅在密码模式替换其启动流程之处部分取代启动 token 决策。[浏览器启动 token 决策](2026-08-24-browser-token-authentication.zh.md)在密码配置缺失时仍保持 active，而[载体级浏览器信任决策](2026-07-28-api-browser-trust-boundary.zh.md)在 Host、Origin、Fetch-Metadata 和配置 authority 校验方面仍保持 active。

## 验证

Connection 测试覆盖密码配置校验与值隐去、干净的密码模式 URL、v2 cookie 签名与属性、独立会话、重启后的凭据版本失效，以及密码模式拒绝启动 token 会话。Host 路由测试覆盖本地化且不含凭据的登录 HTML、读取 body 前的信任校验、有界的通用失败、登录、logout 和一致的 401/403 结果。Web profile 测试覆盖环境映射和精确的布尔值解析。

## 暂缓事项

Windows 继承环境的大小写行为及其验证仍然暂缓。密码登录配置不对额外的 Windows 大小写处理作出承诺。
