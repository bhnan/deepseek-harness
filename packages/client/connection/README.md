---
description: "Browser-host wire layer for the web GUI: Remote RPC, event-stream delivery with reconnect, exact Fetch routes, the /api HTTP bridge, and the browser-trust fence."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-connection

English | [中文](README.zh.md)

## Summary

The package carries browser-to-Host Remote calls, exact Fetch responses, and connection generations. The Client plugin mounts `ctx.connection` with current-page loopback state, generic RPC, the active generation and its Host facts, observable recovery state, an immediate reconnect command, and the registration point for one generation source. A generation becomes visible when its source reports ready; source completion, failure, withdrawal, or an explicit stop clears it before `ConnectionController` applies its retry policy.

## Table of Contents

- [Use this package](#use-this-package)
- [Browser authentication and request trust](#browser-authentication-and-request-trust)
- [Connection generation](#connection-generation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The browser uses HTTP POST for Remote unary calls. API Gateway owns the `/api/remote.mux` WebSocket and its logical streams; in-process compositions provide equivalent Remote streams through `connection.rpc.open` without opening a WebSocket. The Host half owns the sole `/api` route, Fetch bridge, browser authentication, Host/Origin checks, and exact `GET`/`HEAD`/`POST` route registry. Each exact route declares buffered or streaming request-body handling before the bridge reads any bytes. Typert Gateway claims generated Remote endpoints, feature packages register non-JSON responses such as Session-log downloads and raw file uploads, and unclaimed requests return 404. Loopback hostname classification remains package-internal to the browser-facing Client state. Browser raw-body transfer is provided by [`dsh-client-file-upload`](../file-upload/README.md).

-----

<a id="browser-authentication-and-request-trust"></a>
## Browser authentication and request trust

Every Host RPC method and WebSocket stream requires one browser session; there is no method-specific loopback tier. When `passwordLogin` is absent, token mode mints a random process token. `dsh-web-app` prints and opens the root URL with `?token=...`; `frontend-static` accepts that token only on `GET /`, writes an authority-bound signed cookie, and redirects to clean `/`. The HTTP carrier accepts no query token outside that root exchange and no Authorization-header token. Token cookies have a 30-day absolute lifetime by default through `cookieMaxAgeDays`, and deliberately omit `Secure` for the shipped loopback-HTTP application.

When `passwordLogin` is present, it selects one deployment-managed account and disables token acceptance. The Web app prints and opens a clean root URL. `GET /auth/login` serves a host-owned English or Chinese form chosen from `Accept-Language`; `POST /auth/login` mints a session after valid form credentials, and exact `POST /auth/logout` expires only the requesting browser's cookie for that authority. The login page never includes configured credential values. A protected index request without a valid session returns 401, as does a trusted API request without one; static non-index assets remain public.

| `passwordLogin` field | Default | Semantics |
|---|---:|---|
| `username` and `password` | — | Both are required and nonempty; malformed configuration fails loading without exposing either value. |
| `sessionMaxAgeDays` | `7` | Absolute password-session lifetime in days; it must be at least 7. |
| `failureDelayMs` | `500` | Generic invalid-login delay in milliseconds; it must not exceed 10,000. |
| `secureCookie` | `true` | Adds `Secure` to password-session cookies. |

The cookie signing secret is the owner-scoped `client-connection/browser-session` grant record in `ctx.credentials`. The local provider persists it in `$DSH_HOME/.credentials.yaml`; `BrowserAuth` loads or creates the record during Connection activation and retains the secret in memory, so request authentication is synchronous. Deleting or replacing the record takes effect on the next Connection activation. All cookies bind the normalized hostname plus port in their deterministic name and signed payload, are host-only, `Path=/`, `HttpOnly`, and `SameSite=Strict`, and carry absolute issue and expiry times. Password cookies are v2 and add a keyed credential revision plus a random session id, never a password, password hash, or signing secret. Independent browsers and devices can hold valid cookies simultaneously; changing the configured credentials and restarting DSH invalidates every password cookie, while unchanged credentials across restart preserve them.

Before authentication, every `/api` request and every password route passes `src/api-request-trust.ts`. Its `Host` must be loopback or match a `trustedHosts` entry: exact on `host:port`, any port on port-less entries, both sides WHATWG-normalized. An attached `Origin` must equal that Host and `sec-fetch-site: cross-site` is refused. Only a native same-origin document navigation to `POST /auth/login` may use literal `Origin: null`, and it must also carry `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`; `/api`, login GET, and logout retain the strict rule. Malformed configured authorities fail plugin load. These checks defend DNS rebinding and cross-site browser requests; they never establish identity. A failed Host/Origin check returns 403 before a login body is read, while a trusted but unauthenticated request returns 401. `dsh web --host 0.0.0.0` remains unsupported. Decision records: [browser request trust](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md), [browser token authentication](../../../.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.md), and [Web password authentication](../../../.agents/notes/implemented/architecture/2026-09-05-web-password-authentication.md).

<a id="connection-generation"></a>
## Connection generation

API Gateway Client registers the internal `$events` logical stream as the sole generation source, independently of whether any `$on` listener exists. The Host attaches all incremental listeners in the API Remotes source factory, then sends one `{ type: 'ready', clientId, host: { home } }` item before events. `ConnectionController` publishes that generation and calls `onConnected` only after the ready item arrives, so baseline acquisition cannot race ahead of incremental observation.

An ended `$events` stream, a Remote stream error, a non-ready opening item, or a malformed event item invalidates the current generation. While the browser reports network availability, the controller publishes `connecting` and retries with 50%–100% jitter under caps of 500ms, 1s, 2s, 4s, 8s, and 10s. It logs each attempt, asks Gateway to replace the physical WebSocket, and reopens `$events`; failure in the 10s tier publishes terminal `disconnected`. `ctx.connection.reconnect()` interrupts active work, resets the sequence, and starts retry 1 immediately. Browser `offline` aborts active work, publishes `disconnected`, and suspends automatic attempts; the next `online` transition resets the sequence and starts at the 500ms tier. A ready item publishes `connected`. The Gateway mux performs one physical connection attempt per request rather than running an independent retry schedule. The [connection recovery decision](../../../.agents/notes/implemented/feature/2026-08-28-web-connection-recovery-control.md) owns the cadence and manual recovery behavior.

<a id="model-experience"></a>
## Model Experience

None, as the wire consumer layer moves already-composed messages between browser and host; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Buffered `/api` routes retain each request body in memory** — `maxRequestBodyBytes` (default 300 MiB, sized for the default 200 MiB aggregate image limit after base64 expansion plus envelope headroom) bounds ordinary image and RPC envelopes. Opt-in streaming routes receive backpressured chunks and bypass the aggregate cap; route implementations own persistence, cancellation, and any storage quota.
- **Password login is one shared account** — it has no external IdP, roles, multi-account support, device inventory, or per-device server-side revocation. `POST /auth/logout` only expires the requesting browser's cookie; credential rotation plus a DSH restart invalidates every password session.
- **Password mode expects a TLS-facing deployment** — `secureCookie` defaults to `true`; setting it false changes a cookie attribute, not the loopback-only listener or proxy-identity policy. The password decision defines the intended Caddy deployment posture.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Browser-session verification reads the credential record asynchronously at the request that authorizes work, while the credentials companion owns record commit-event lifetime. Stream/reconnect sequencing and rpcId round-trip discipline are exercised directly by behavior specs, and route register/dispose symmetry is audited by the webserver companion.
