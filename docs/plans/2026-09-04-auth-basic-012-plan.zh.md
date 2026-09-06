# Auth-basic 0.1.2 实现计划

[English](2026-09-04-auth-basic-012-plan.md) | 中文

1. 在 `packages/host/webserver` 添加公开的 HTTP 与 upgrade guard 注册，并为继续、拒绝、释放和 upgrade 编写真实组合测试。
2. 更新 webserver README，并写一份 Agent Note，说明为什么全局策略应使用 guard 而不是直接替换 listener。
3. 将本地 `dsh-auth-basic` 的原始 listener 拦截器替换为 guard API，并添加独立的 HTTP/WebSocket 冒烟测试。
4. 仅保留与 0.1.2 browser-auth 模型兼容的旧 trusted-host 行为，然后运行聚焦测试、构建和浏览器验证。
