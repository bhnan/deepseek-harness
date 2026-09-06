# Auth-basic 0.1.2 implementation plan

English | [中文](2026-09-04-auth-basic-012-plan.zh.md)

1. Add public HTTP and upgrade guard registration to `packages/host/webserver`, with real-composition tests for continue, denial, disposal, and upgrades.
2. Update the webserver README and an Agent Note describing why global policy uses guards rather than raw listener replacement.
3. Replace the local `dsh-auth-basic` raw-listener interceptor with the guard API and add a standalone HTTP/WebSocket smoke test.
4. Carry forward only the old trusted-host behavior compatible with the 0.1.2 browser-auth model, then run focused tests, build, and browser verification.
