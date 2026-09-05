# Web password login design

## Goal

The Web profile accepts one deployment-managed username and password at a dedicated login page. A successful login gives each browser an independent, authority-bound session that remains valid for a configurable period of at least seven days. The same account may have concurrent sessions on multiple phones, computers, and browsers.

## Non-goals

This increment does not add user registration, multiple accounts, roles, device inventory, per-device revocation, external identity providers, or a reverse-proxy identity-header integration. The existing process launch token remains available only when password login is disabled.

## Configuration

The Web bundle reads `DSH_WEB_AUTH_USERNAME` and `DSH_WEB_AUTH_PASSWORD` from its launch environment. Both values must be present and non-empty to enable password login; supplying only one fails during startup. The password never enters a URL, browser bootstrap data, log line, session event, or normal DSH credential file.

Password-login configuration includes `sessionMaxAgeDays`, with a default of seven and a minimum of seven, plus a secure-cookie setting that defaults to enabled. The bundle exposes those deployment choices through environment expressions so a systemd unit or other process supervisor can supply them without source edits. The regular token-based browser-session lifetime remains unchanged when password login is disabled.

## Request lifecycle

When password login is enabled, `dsh web` prints a clean canonical URL. A browser without a valid session that requests the frontend index receives a redirect to `/auth/login`. The exact login route serves a small localized HTML form and accepts only its form submission. A valid username and password mint the existing browser-session cookie and redirect to `/`; an invalid submission receives the same generic failure response for either field after a bounded delay. The route checks the same Host and Origin trust rules as the Web API before it reads a password.

The browser automatically sends the resulting cookie to frontend-index, `/api`, and WebSocket requests. The existing Connection request check continues to reject every protected API and upgrade request without that cookie. A `POST /auth/logout` expires only the cookie presented by that browser and redirects to the login page.

## Cookie and session model

Password login reuses the persistent HMAC signing secret already owned by `BrowserAuth`. Its cookie stays host-only, `HttpOnly`, `Secure`, and `SameSite=Strict`, and its payload remains bound to the request authority and absolute expiry. Each successful browser login mints a separate cookie; no server-side single-session map means a second device cannot invalidate the first one.

The cookie payload also carries a keyed revision derived from the active username and password. On every request, password mode compares that revision with the active configuration. Restarting DSH with unchanged environment values preserves valid sessions through the durable signing secret; changing either credential invalidates every existing password-login session. Password-mode cookies and launch-token cookies remain distinguishable so a token-only session cannot satisfy an enabled password-login deployment.

## Security and deployment

Password login is for an HTTPS deployment in which DSH listens only on loopback and Caddy is the sole public entry point. The Web invocation declares the public authority through `--trusted-host`; direct access to the DSH port remains unavailable. The implementation neither accepts nor trusts client-provided forwarding or identity headers.

The login page contains no account enumeration, returns one generic credential failure, compares supplied values in constant time after validation, and applies a configurable bounded failure delay. The login form receives an authority check before processing, and credentials are not retained beyond the in-memory configuration used for verification.

## Components

`@deepseek-ai/dsh-client-connection` remains the owner of browser-session cookies and protected request checks. It gains an optional password-login configuration, a login-route owner, and the minimal `BrowserAuth` operations needed to mint, verify, and revoke password-mode sessions. `@deepseek-ai/dsh-web-app` supplies the optional configuration from the launch environment and continues to own URL reporting. The legacy experimental raw-listener authentication package is not mounted or extended.

The login document is server-rendered rather than part of the DSH React application. Its visible copy comes from a host-owned English and Chinese dictionary selected from the request language, so it does not require the normal client plugin roster to load before authentication succeeds.

## Verification

Focused host tests cover startup validation, clean URL reporting, successful and failed form submissions, generic failures, authority checks, API and upgrade rejection, logout, concurrent browser cookies, expiry, restart persistence, and credential-rotation invalidation. Web-profile tests prove that the named routes take precedence over the static fallback. Documentation covers the environment variables, HTTPS/Caddy deployment requirement, session lifetime, and limits. An Agent Note records why password login extends the current browser-session owner instead of reviving the raw-listener adapter.
