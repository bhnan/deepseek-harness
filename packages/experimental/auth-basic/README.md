# `@deepseek-ai/dsh-experimental-auth-basic`

English | [中文](README.zh.md)

Experimental basic HTTP authentication for the DSH Web composition. The function plugin wraps the current `dsh-host-webserver` raw Node listener before the SPA fallback, serves its own `/login` document, signs an in-memory session cookie, rejects unauthenticated `/api/*` requests, and destroys unauthenticated upgrade sockets. It adds no Harness UI layout, settings page, or model-visible behavior.

This package is intentionally private and experimental. It preserves the server deployment's single shared login rather than introducing an authentication seam or changing `dsh-host-webserver`.

## Configuration

Install the built package in the profile, then list this bundle after `@deepseek-ai/dsh-base` and before `@deepseek-ai/dsh-web-app` so the interceptor sees the Web server's original listener before the static fallback serves pages.

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

The bundle patch reads credentials only from these profile-process environment values. `DSH_AUTH_BASIC_SESSION_SECRET` is optional in development, but a network-facing deployment should set an opaque stable value; it signs cookies but does not preserve the in-memory sessions through a restart.

```sh
export DSH_AUTH_BASIC_USERNAME='<login-name>'
export DSH_AUTH_BASIC_PASSWORD='<login-password>'
export DSH_AUTH_BASIC_SESSION_SECRET='<opaque-random-secret>'
```

`sessionMaxAge` defaults to 86,400 seconds and `realm` defaults to `DeepSeek Harness`; override either in the profile's `cordis.patch.yml` row. A remote deployment also needs the Web process started with its public authority in `--trusted-host`, plus a TLS-terminating reverse proxy and firewall policy that keep the direct DSH port private. The [trusted-host decision](../../../.agents/notes/implemented/architecture/2026-08-25-trusted-host-privileged-methods.md) explains why authentication is required before remote pages can use privileged DSH methods.

## Model Experience

None, as authentication completes before the browser reaches the DSH RPC carrier or model-request assembly.

#### KV Cache effect

None; the login document and session checks never enter a provider request.

## Known Limitations and Deferred Work

- **One shared identity** — every successful login receives the same DSH authority; there are no users, roles, tenant isolation, rate limits, or audit records.
- **Process-local sessions** — sessions live only in memory, so a restart invalidates every login and multiple processes do not share sessions.
- **Private listener dependency** — the adapter replaces raw Node listeners owned by the current `dsh-host-webserver`; it must stay experimental until a supported interception interface exists.
- **Deployment, not isolation** — the cookie is `HttpOnly` and `SameSite=Lax` but not `Secure`; use HTTPS, do not expose the direct DSH port, and do not treat this wrapper as protection against untrusted same-process plugins. To preserve the server implementation, an internal interception error delegates to the original listener.
