# Agent Note: privileged /api methods resolve against trustedHosts

Status: implemented

## Problem

The `/api` privileged method set (`host.pickDirectory`, `host.openPath`, the whole `settings.*` / `credentials.*` configuration plane, `llm.discoverModels`, and the `agentPreset` authoring plane) was pinned to loopback by passing the browser-trust fence an **empty** trust list — on the ground that `trustedHosts` is a DNS-rebinding fence, not authentication. A public deployment fronted by an authenticating reverse proxy (HMAC-signed session cookie, e.g. `dsh-auth-basic`) therefore could not use the settings/credential plane at all: every privileged RPC answered `403` for its own declared serving authority.

## Decision

Resolve the privileged-method fence against the configured `trustedHosts` (`!isTrustedApiRequest(request, trustedHosts)`), and treat any served page authority as loopback on the client half (`connection.isLoopback: true`), so the settings/credentials mirror opens for an authenticated remote page. The fence stays a confused-deputy defense; the relaxation is conditional on the serving composition authenticating remote callers before the RPC bridge (the Web carrier itself still provides no authentication layer).

## Alternatives considered

- **Keep the empty trust list and add a separate config toggle.** Rejected: the deployment already gates every request at the route layer; a second flag would be a redundant switch over the same fence inputs.
- **Allow-list only reads.** Rejected: `settings.update`/`mutate` and `credentials.set` are exactly what a remote admin page edits; splitting reads from writes adds surface without a caller distinction.

## Consequences

- A trusted-host deployment (`dsh web --host 0.0.0.0 --trusted-host <authority>` behind an authenticating proxy) reaches the settings/credential/agentPreset plane.
- A composition that trusts a host but does not authenticate it now exposes those methods to any caller whose `Host` matches — the fence no longer pins them alone.
- Upstream loopback-only tests (`pins privileged methods to loopback even for a declared trusted authority`, `answers a declared LAN authority with 403 on every configuration method`) were updated to assert the relaxed boundary plus a still-denied undeclared authority.
- Partially supersedes the [api browser-trust boundary decision](../../implemented/architecture/2026-07-28-api-browser-trust-boundary.md): that note's carrier-level fence architecture and its media-type fence remain current, but its "privileged methods pass with an empty trust list" consequence no longer holds; this note keeps the boundary decision active and cross-linked.
