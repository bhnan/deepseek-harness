# Auth-basic 0.1.2 adaptation specification

English | [中文](2026-09-04-auth-basic-012-spec.zh.md)

`dsh-host-webserver` provides ordered HTTP and upgrade guards. A guard receives every request before route lookup; an HTTP guard returns `true` to continue or answers the response and returns `false`. An upgrade guard returns `true` to continue or `false` to make WebServer close the socket. Registration returns a disposer.

`dsh-auth-basic` uses these guards instead of accessing raw Node listeners. Its login and logout endpoints stay public, login writes the signed session cookie, authenticated requests proceed to the normal DSH routes, and all unauthenticated routes retain the existing redirect or 401 behavior.

Guards are independent from DSH client-connection trust. A request must pass auth-basic and the existing Host/Origin/token checks where those routes require them.
