# Agent Note: experimental basic Web authentication is a raw-listener adapter

Status: implemented

English | [中文](2026-08-26-experimental-basic-web-auth.zh.md)

## Problem

The remote trusted-host composition needs an authentication layer before the Web RPC carrier, but the server deployment's `dsh-auth-basic` code was an untracked, credential-bearing directory that reached into `dsh-host-webserver`'s raw Node listener. Copying that directory into a release package would mix server credentials and a private implementation dependency into the product spine.

## Decision

`@deepseek-ai/dsh-experimental-auth-basic` is a private experimental bundle. It preserves the deployed login page, timing-safe shared credential comparison, signed in-memory session cookie, HTTP/API request gate, and upgrade gate. Its `cordis.patch.yml` reads only `DSH_AUTH_BASIC_*` environment expressions, and a profile mounts it between `dsh-base` and `dsh-web-app`.

The package deliberately adapts the current `dsh-host-webserver` raw listener rather than adding a method to the WebServer interface. Listener replacement, retry timers, session cleanup, and restoration belong to one Cordis effect, so unloading the plugin returns the original Web request path.

## Alternatives considered

- **Add a public WebServer interception interface.** Rejected for this migration: it would create a new product interface and require an independent design, compatibility, and security decision instead of preserving the server's working deployment behavior.
- **Use only reverse-proxy authentication.** Rejected for the current deployment: the existing product behavior includes the self-contained login page and HMAC session cookie, and this branch is specifically synchronizing that behavior into the fork.
- **Ship the adapter as a release package.** Rejected: the raw listener is private implementation knowledge, and the single-user in-memory session model has no stable support promise.

## Consequences

- The branch contains no server username, password, session secret, host path, or other server-specific profile configuration.
- The adapter supplies no Harness settings UI or plugin UI; it only serves a standalone login page before the normal Web application.
- The adapter is required by the [trusted-host decision](2026-08-25-trusted-host-privileged-methods.md) for a remote page to reach privileged DSH methods safely enough for this deployment model.
- The package's real Loader composition test pins login, rejection, authenticated forwarding, logout, and listener restoration; it does not make the raw-listener dependency a supported WebServer interface.
- The adapter retains the server implementation's process-local sessions and error delegation behavior, so HTTPS, reverse-proxy controls, and trusted plugin installation remain deployment responsibilities.
