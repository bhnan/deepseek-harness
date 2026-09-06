# Auth-basic 0.1.2 adaptation intent

English | [中文](2026-09-04-auth-basic-012-intent.zh.md)

## Problem

The locally installed `dsh-auth-basic` plugin replaces Node HTTP listeners directly. DSH 0.1.2 owns that listener inside `dsh-host-webserver`, so the plugin cannot reliably protect HTTP routes or WebSocket upgrades.

## Scope

Adapt `dsh-auth-basic` to the DSH 0.1.2 WebServer API while retaining the 0.1.2 browser trust and token checks. The work also resolves the remaining trusted-host compatibility conflict from `bhn/0.1.1-rc.2-patched`.

## Success

- Unauthenticated browser navigation redirects to login and unauthenticated `/api` requests return 401.
- A successful login grants access to ordinary routes and WebSocket upgrades.
- The DSH trusted-host and browser-auth checks continue to reject untrusted origins.
- The plugin unloads without retaining request filters, timers, or sessions.

## Non-goals

This change does not expose the service publicly, add TLS, or alter DSH's native browser-auth token protocol.
