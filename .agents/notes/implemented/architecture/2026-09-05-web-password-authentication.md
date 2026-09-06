# Agent Note: Web password authentication

Status: implemented

English | [中文](2026-09-05-web-password-authentication.zh.md)

## Problem

The launch-token flow authenticates a loopback browser by putting a process credential in the URL printed at startup. An HTTPS deployment serving one public authority needs a human login that leaves startup output and browser handoff credential-free, while retaining the complete Host API's single authentication rule.

The deployment needs one shared account and independent browser sessions, not a user directory, role system, external identity provider, or server-side device inventory. Its Host/Origin checks must continue to stop DNS rebinding and cross-site requests without being mistaken for caller identity.

## Decision

`dsh-client-connection` selects password login when its optional `passwordLogin` configuration exists. It accepts exactly one deployment-managed username and password; both are nonempty, configuration failures redact their values, password sessions default to seven days and cannot be shorter, failed logins default to a 500 ms delay capped at 10,000 ms, and `secureCookie` defaults to `true`.

In password mode, `dsh web` prints and opens a clean root URL. The host owns exact `GET` and `POST /auth/login` routes and exact `POST /auth/logout`; the login page is localized in English or Chinese from `Accept-Language` and contains no configured credential values. The shared Host/Origin trust check runs before a login form body is read, rejects an untrusted request with 403, and remains a DNS-rebinding and cross-site trust fence rather than caller identity. `POST /auth/login` accepts literal `Origin: null` only for a same-origin document navigation with `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`; every API request, login GET, and logout keeps the strict Origin rule. A protected index request without a valid session receives 401, as does a trusted API caller without one. A valid login redirects to `/`; a per-browser logout expires that authority's cookie and redirects to `/auth/login`.

Each successful login mints an independent v2 cookie. It is host-only, `Path=/`, `HttpOnly`, `SameSite=Strict`, authority-bound, HMAC-signed, and absolutely expired; it carries `Secure` when `secureCookie` is true. Its payload includes a keyed credential revision and a random session id, but never the username, password, password hash, or signing secret. No account map or device state is stored by the server, so browsers and devices can remain logged in independently. Changing the configured credentials and restarting DSH invalidates all password cookies; an unchanged configuration across restart preserves them.

The intended public deployment terminates HTTPS in Caddy while DSH listens only on loopback, with the public authority declared through `--trusted-host`. The implementation does not configure Caddy, make a public non-loopback listener supported, or accept forwarding or proxy identity headers. Cookie authentication, not Host, Origin, or a proxy header, establishes the caller identity.

Password and token modes coexist by selection, not by credential acceptance. When `passwordLogin` is absent, the [browser launch-token decision](2026-08-24-browser-token-authentication.md) remains authoritative, including its token exchange and 30-day cookie default. When password login is enabled, no launch token or token-mode cookie is accepted.

## Alternatives considered

**Install a raw HTTP listener for login.** Rejected: the webserver's exact-route registry keeps route ownership, disposal, and the established Host/Origin check in one carrier; a parallel listener could bypass or duplicate those rules.

**Accept reverse-proxy identity or forwarding headers.** Rejected: headers supplied by a proxy do not replace a browser credential unless the application defines and enforces a proxy-identity system. This deployment accepts neither class of header and keeps Caddy outside caller identity.

**Integrate an external IdP.** Rejected: redirect flows, callback handling, account mapping, and provider lifecycle would add a separate identity system without a current consumer. One configured account is the deliberately smaller operation.

**Keep a server-side account and device-management store.** Rejected: session inventory, per-device server revocation, roles, and multi-account administration are not required for independent browser cookies. Credential rotation plus restart is the global invalidation operation; logout is intentionally per browser.

**Submit the login form through JavaScript fetch.** Rejected: native form navigation works without client JavaScript and the exact route-specific Fetch-Metadata exception preserves the Host and cross-site checks for all other requests.

## Consequences

The Web profile supports one shared account with independent browser and device sessions. It does not provide an external IdP, roles, multiple accounts, device inventory, or per-device server-side revocation. A logout affects only the cookie held by the requesting browser; operators rotate credentials and restart DSH to invalidate every password session.

The default `Secure` cookie requires HTTPS at the browser-facing authority. Setting `secureCookie` false is an explicit cookie-attribute choice, not support for exposing DSH directly over a public plaintext or non-loopback listener. The Caddy/loopback posture and `--trusted-host` declaration remain deployment responsibilities.

This decision partially supersedes the launch-token decision only where password mode replaces its bootstrap flow. The [browser launch-token decision](2026-08-24-browser-token-authentication.md) remains active for absent password configuration, and the [carrier-level browser trust decision](2026-07-28-api-browser-trust-boundary.md) remains active for Host, Origin, Fetch-Metadata, and configured-authority validation.

## Verification

Connection tests cover password configuration validation and value redaction, clean password-mode URLs, v2 cookie signing and attributes, independent sessions, credential-revision invalidation after restart, and rejection of launch-token sessions in password mode. Host-route tests cover localized credential-free login HTML, trust-before-body-read behavior, bounded generic failures, login, logout, and uniform 401/403 outcomes. The Web profile tests cover environment mapping and exact boolean parsing.

## Deferred

Windows inherited-environment case behavior and its verification remain deferred. Password-login configuration makes no additional Windows case-handling promise.
