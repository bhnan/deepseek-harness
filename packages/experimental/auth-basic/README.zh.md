# `@deepseek-ai/dsh-experimental-auth-basic`

[English](README.md) | 中文

为 DSH Web 组合提供的实验性基础 HTTP 鉴权。该函数插件会在 SPA 回退处理之前包装当前 `dsh-host-webserver` 的原始 Node listener，提供独立的 `/login` 文档，为内存会话 cookie 签名，拒绝未鉴权的 `/api/*` 请求，并销毁未鉴权的升级 socket。它不添加任何 Harness UI 布局、设置页面或模型可见行为。

该包刻意保持私有和实验性。它保留服务器部署中的单一共享登录方式，而不是引入鉴权 seam 或修改 `dsh-host-webserver`。

## 配置

先在 profile 中安装已构建的包，再把本 bundle 放在 `@deepseek-ai/dsh-base` 之后、`@deepseek-ai/dsh-web-app` 之前，使拦截器在静态回退服务页面之前看到 Web server 的原始 listener。

```json
{
  "dependencies": {
    "@deepseek-ai/dsh-experimental-auth-basic": "file:<built-plugin-path>"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-experimental-auth-basic",
        "@deepseek-ai/dsh-web-app"
      ]
    }
  }
}
```

bundle patch 仅从这些 profile 进程环境值读取凭据。`DSH_AUTH_BASIC_SESSION_SECRET` 在开发中可选，但面向网络的部署应设置一个稳定的不透明值；它为 cookie 签名，但不会让内存会话跨重启保留。

```sh
export DSH_AUTH_BASIC_USERNAME='<login-name>'
export DSH_AUTH_BASIC_PASSWORD='<login-password>'
export DSH_AUTH_BASIC_SESSION_SECRET='<opaque-random-secret>'
```

`sessionMaxAge` 默认值为 86,400 秒，`realm` 默认值为 `DeepSeek Harness`；可在 profile 的 `cordis.patch.yml` 行中覆盖任一值。远程部署还需要以公共 authority 传入 `--trusted-host` 启动 Web 进程，并配置终止 TLS 的反向代理和防火墙策略，使 DSH 直接端口保持私有。[trusted-host 决策](../../../.agents/notes/implemented/architecture/2026-08-25-trusted-host-privileged-methods.zh.md)说明了为什么远程页面使用 DSH 特权方法前必须先经过鉴权。

## 模型体验

无，因为鉴权在浏览器进入 DSH RPC carrier 或模型请求组装之前完成。

#### KV Cache 影响

无；登录文档和会话检查永不进入提供方请求。

## 已知限制与延期工作

- **单一共享身份**：每次成功登录都取得相同的 DSH authority；没有用户、角色、租户隔离、速率限制或审计记录。
- **进程本地会话**：会话只存在于内存中，因此重启会使所有登录失效，多个进程也不会共享会话。
- **私有 listener 依赖**：该适配器替换当前 `dsh-host-webserver` 所拥有的原始 Node listener；在存在受支持的拦截接口之前，它必须保持实验性。
- **部署而非隔离**：cookie 是 `HttpOnly` 和 `SameSite=Lax`，但不是 `Secure`；请使用 HTTPS，不要暴露 DSH 直接端口，也不要把此包装层当作对不受信任的同进程插件的防护。为保持服务器实现，内部拦截错误会转交给原始 listener。
