# Agent Note: WebServer global request guards

Status: implemented

English | [中文](2026-09-04-webserver-global-request-guards.zh.md)

## Problem

Some deployment policies must decide every HTTP request and WebSocket upgrade, including the static fallback that does not belong to a named route. Replacing `node:http` request and upgrade listeners reaches a private implementation detail, discards the WebServer's error and socket ownership, and can bypass browser-token authentication and Host/Origin checks owned by other route handlers.

## Decision

`dsh-host-webserver` owns the Node listeners and exposes `registerRequestGuard` and `registerUpgradeGuard` on `ctx.webServer`. Guards run in registration order before HTTP route or upgrade-route lookup. An HTTP guard returns `true` to continue, or completes its own response and returns `false`; an upgrade guard returns `false` to make WebServer close the candidate socket. Each registration returns a disposer, so the contributing plugin owns guard lifetime through its Cordis effect.

Named-route matching remains order-independent. Guard order is deliberate policy order and does not change route ownership. WebServer still owns listener errors, upgrade-socket tracking, and teardown.

`dsh-auth-basic` uses both registrations. It lets `GET /?token=...` continue so `dsh-client-connection` can exchange the browser launch token before basic authentication redirects to login. A browser that completes both exchanges reaches the ordinary static, API, and WebSocket paths; every API and upgrade request still passes the existing browser-session and Host/Origin checks.

## Verification

The WebServer real-Loader composition spec proves ordered HTTP guard evaluation, response denial, guard disposal, blocked upgrades, and upgrades admitted after disposal. A temporary `dsh web` composition with `dsh-auth-basic` verifies the launch-token exchange, the login redirect, password login, authenticated static page and API access, an admitted authenticated WebSocket, and closure of an unauthenticated upgrade.

## Alternatives considered

**Replace raw Node listeners.** The plugin would own private listener order, response failures, and socket teardown while removing handlers installed by the WebServer. It cannot safely compose with the server's lifecycle or with another policy plugin.

**Wrap only the SPA fallback or register a catch-all route.** Named routes and upgrade routes would remain outside the policy, and a fallback wrapper cannot precede every static or API response.

**Move deployment authentication into `dsh-client-connection`.** Browser-session authentication belongs to the API transport and remains there. Adding username/password session policy to that package would turn one deployment option into a browser transport requirement.

## Consequences

Authentication and other whole-server policy plugins have one public registration path and dispose without retaining callbacks or sessions. A guard that returns `false` without completing its response violates the API and leaves its client waiting. The WebServer core remains policy-neutral: it does not supply credentials, choose a guard, or make network deployment supported.

This decision supplements [Web config-tree boot and transport layering](2026-07-24-web-config-tree-boot-and-transport-layering.md), which remains the owner of feature-route responsibilities, and [browser launch-token authentication](2026-08-24-browser-token-authentication.md), which remains the owner of browser-session and request-trust rules.
