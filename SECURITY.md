# Security policy

## Reporting a vulnerability

Report privately through GitHub, from the repository's **Security** tab:
[Report a vulnerability](https://github.com/JigSawFr/eurodns-mcp/security/advisories/new).
That opens a private advisory visible only to you and the maintainers. Please do not open a
public issue for a vulnerability — an issue is world-readable from the moment it is filed.

Expect an acknowledgement within a few days. If a report is confirmed, the fix ships in a
patch release and the advisory is published once it is available.

Include, if you can: what an attacker gains, the configuration it needs (which
`EURODNS_MCP_AUTH` mode, whether the audit log is enabled), and the smallest sequence of
calls that shows the behaviour.

## Supported versions

The latest release on the default branch. This project is below `1.0.0`, so fixes land in a
new minor or patch release rather than being backported.

## What is in scope

The server handles registrar credentials and can change DNS. The reports that matter most:

- **Authentication and authorization** — a call succeeding without a valid token, a token
  minted for another resource being accepted, or a scope check that can be bypassed.
- **Credential exposure** — the upstream API key, a caller's bearer token, or a 1Password
  Connect token reaching a log line, an error message, or an upstream request that should
  not carry it.
- **Guardrail bypass** — reaching a billing or destructive operation that
  `EURODNS_ALLOW_BILLING` or `EURODNS_ALLOW_DESTRUCTIVE` should have blocked.
- **Audit integrity** — an action that leaves no line in the log, or a line attributed to
  the wrong caller. The upstream API sees one shared key for every user, so this log is the
  only record of who did what.

## What is not

- **Running with `EURODNS_MCP_AUTH=none`.** That mode is for a loopback-bound development
  server, and the process refuses to start on any other address without authentication.
- **Whatever a legitimately scoped caller is allowed to do.** A token carrying
  `eurodns.dns.write` can change DNS records; that is the product.
- **The EuroDNS API itself.** Report those to the vendor. This project is not affiliated
  with EuroDNS.
- **Reaching a deployment whose egress IP is not allowlisted upstream.** Calls fail with
  `403` by design.
