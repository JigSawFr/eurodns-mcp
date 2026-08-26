# eurodns-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for the **EuroDNS User API**.
It exposes domains, DNS zones, contacts, subscriptions, SSL, invoices and orders as MCP
tools, so an MCP client can manage them in natural language.

> This is an independent open-source project. It is **not affiliated with, endorsed by, or
> supported by EuroDNS**. "EuroDNS" is used only to identify the API this server talks to.

> Written by a professional engineer with AI assistance. Every line was reviewed before it
> was committed, and the responsibility for what it does is human.

## What you get

- **Full API coverage** — 79 tools generated from the OpenAPI document, across 17 areas.
- **Three DNS workflow tools** that make record edits safe (see below).
- **Guardrails** so a deployment can refuse operations that spend money or destroy things.
- **Two transports** — `stdio` for a local client, streamable HTTP for a shared deployment.
- **OAuth 2.1 or a shared token** on HTTP, with an audit line per call.

## Requirements

- Node.js 20 or newer.
- EuroDNS API credentials: an **Application ID** and an **API key**, created in the EuroDNS
  dashboard under API access.
- **The public IP of the machine running this server must be allowlisted** in the same
  dashboard. A `403` from the API is almost always a missing allowlist entry, not bad
  credentials.

## Quick start (stdio)

```bash
npx eurodns-mcp
```

with the credentials in the environment. For a client that spawns the server itself, such as
Claude Desktop:

```json
{
  "mcpServers": {
    "eurodns": {
      "command": "npx",
      "args": ["-y", "eurodns-mcp"],
      "env": {
        "EURODNS_APP_ID": "your-application-id",
        "EURODNS_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Keeping the key out of the config file

That file stores the values in **clear text** in your user profile. To avoid it, point the
client at a wrapper that reads the key from your OS keychain at launch:

```bash
#!/usr/bin/env bash
# eurodns-mcp-wrapper — chmod +x, then use it as "command" in the client config.
set -euo pipefail

# macOS
export EURODNS_APP_ID="$(security find-generic-password -s eurodns-app-id -w)"
export EURODNS_API_KEY="$(security find-generic-password -s eurodns-api-key -w)"

# Linux (libsecret):
#   export EURODNS_API_KEY="$(secret-tool lookup service eurodns key api)"
# Windows (PowerShell, with the SecretManagement module):
#   $env:EURODNS_API_KEY = Get-Secret -Name eurodns-api-key -AsPlainText

exec npx -y eurodns-mcp
```

Store the secrets once with, for example,
`security add-generic-password -s eurodns-api-key -a "$USER" -w`.

## The DNS workflow tools

`PUT /dns-zones/{domain}` replaces the **entire** zone document: a caller that sends a
partial zone silently deletes everything it left out. Three tools exist so that never
happens by accident.

| Tool                        | What it does                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `eurodns_dns_diff_zone`     | Reports what a proposed record set would change. Writes nothing.                                             |
| `eurodns_dns_upsert_record` | Reads the zone, applies one change, validates it with the API, and saves only if validation passes.          |
| `eurodns_dns_delete_record` | Resolves a record's id from its type and host, then deletes it. Refuses to guess when several records match. |

The raw generated tools (`eurodns_dns_save_zone`, `eurodns_dns_add_records`,
`eurodns_dns_delete_record_by_id`) remain available for callers that know exactly what they
are doing.

Two details worth knowing, both of which this server enforces for you:

- The record value field is **`rdata`**, not `data`. Sending `data` fails with an opaque
  "unexpected technical error".
- TTL accepts only twelve values: 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400,
  172800, 432000, 604800.
- `MAIL` and `URL` are **not** record types. They are pseudo types for the zone's mail and
  URL forwards, which carry different fields. The record tools refuse them and say so.

## Guardrails

Every operation is classified by what it can cost you. Two gates apply, and both must pass.

**1. Deployment gates** — what this deployment permits at all:

| Variable                    | Default | Effect when unset                                                                                                    |
| --------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `EURODNS_READ_ONLY`         | `false` | —                                                                                                                    |
| `EURODNS_ALLOW_BILLING`     | `false` | The **11** operations that create a charge or extend a paid term are refused.                                        |
| `EURODNS_ALLOW_DESTRUCTIVE` | `false` | The **8** irreversible operations outside DNS (subscription deletions, SSL revocation and cancellation) are refused. |

Setting `EURODNS_READ_ONLY=true` means state-changing tools are not advertised at all.
A refusal always names the variable to set — nothing fails silently.

DNS record deletion stays available by default: a zone can be restored from a snapshot,
whereas a revoked certificate or a deleted subscription cannot.

**2. Scopes** — who, within that cap, may do it. Only in OAuth mode:

| Scope                 | Grants                                                 |
| --------------------- | ------------------------------------------------------ |
| `eurodns.read`        | The 36 read operations                                 |
| `eurodns.dns.write`   | DNS writes (zones, records, profiles)                  |
| `eurodns.destructive` | Deletions outside DNS, SSL revocation and cancellation |
| `eurodns.billing`     | The 11 operations that cost money                      |

Keeping both gates means enabling OAuth never silently widens what the server can do, and an
operator can shut off a whole class without touching the identity provider.

## HTTP transport

```bash
EURODNS_MCP_AUTH=token EURODNS_MCP_TOKEN="$(openssl rand -hex 32)" \
  HOST=0.0.0.0 PORT=3000 npx eurodns-mcp-http
```

The endpoint is `POST /mcp`; `GET /healthz` reports readiness without authentication.
Sessions are not used, so any number of instances can sit behind a load balancer.

The server **refuses to start on a non-loopback address without authentication**. Set
`EURODNS_ALLOWED_ORIGINS` when browser-based clients need to reach it — requests carrying
an `Origin` header that is not listed are rejected, which is what stops a DNS-rebinding
attack against a loopback deployment.

### OAuth 2.1

The server is an OAuth **resource server**. It does not issue tokens and embeds no identity
provider: point it at any authorization server that publishes RFC 8414 or OpenID Connect
discovery metadata.

```bash
EURODNS_MCP_AUTH=oauth \
EURODNS_OAUTH_ISSUER=https://issuer.example.com \
EURODNS_MCP_PUBLIC_URL=https://mcp.example.com/mcp \
  npx eurodns-mcp-http
```

At the authorization server, register this server as an API whose identifier is exactly
`EURODNS_MCP_PUBLIC_URL`, expose the four scopes above, and let your MCP client request them.
Names differ by product — an _API/Application ID URI_ in Microsoft Entra ID, an _audience_ in
Auth0, a _client scope_ on a Keycloak client — but the shape is the same everywhere.

A pre-registered `client_id` is fine, and is what the specification prefers: dynamic client
registration (RFC 7591) is deprecated in favour of Client ID Metadata Documents, so an
authorization server that does not implement RFC 7591 is not a problem.

What the server does with a token:

- Validates the signature against the discovered JWKS, plus `iss`, `exp` and `nbf`.
- **Validates `aud` against its own identifier.** Without this, a token minted for any other
  resource behind the same authorization server would be accepted here.
- Never forwards the token upstream. The EuroDNS API is called with the server's own
  credentials, as the specification requires.
- Answers a missing scope with `403` and
  `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`, so a client can request
  consent for exactly what is missing rather than failing outright.

## Audit log

One JSON line per tool call, on stderr by default:

```json
{
  "ts": "2026-01-01T10:00:00.000Z",
  "correlationId": "…",
  "actor": { "mode": "oauth", "subject": "alice@example.com" },
  "tool": "eurodns_dns_upsert_record",
  "risk": "write",
  "target": "example.com",
  "verdict": "allowed",
  "upstreamStatus": 204,
  "durationMs": 412
}
```

The upstream API sees a single shared key for every caller, so this log is the only place an
action can be traced to a person.

- **Refusals are logged too**, with their reason — usually the most interesting line.
- State-changing calls write a `started` line **before** the upstream request, so a crash
  mid-write still leaves a trace of what was attempted.
- Arguments are reduced to scalars and long strings become a length marker. Request bodies
  and record values are never written: a TXT value is often a short-lived secret.

Set `EURODNS_AUDIT_DESTINATION` to `stderr` (default), `stdout`, `file` (with
`EURODNS_AUDIT_FILE`) or `none`. `stdout` is refused under stdio, where it carries the
JSON-RPC stream.

## Environment variables

| Variable                      | Default                        | Purpose                                                |
| ----------------------------- | ------------------------------ | ------------------------------------------------------ |
| `EURODNS_APP_ID`              | —                              | **Required.** Application ID.                          |
| `EURODNS_API_KEY`             | —                              | **Required.** API key.                                 |
| `EURODNS_BASE_URL`            | `https://rest-api.eurodns.com` | API base URL.                                          |
| `EURODNS_TIMEOUT_MS`          | `30000`                        | Upstream request timeout.                              |
| `EURODNS_MAX_RETRIES`         | `2`                            | Retries, for 429 and 5xx only.                         |
| `EURODNS_CHARACTER_LIMIT`     | `25000`                        | Response size before truncation.                       |
| `EURODNS_READ_ONLY`           | `false`                        | Advertise read tools only.                             |
| `EURODNS_ALLOW_BILLING`       | `false`                        | Permit operations that cost money.                     |
| `EURODNS_ALLOW_DESTRUCTIVE`   | `false`                        | Permit irreversible non-DNS operations.                |
| `EURODNS_AUDIT_DESTINATION`   | `stderr`                       | `stderr`, `stdout`, `file`, `none`.                    |
| `EURODNS_AUDIT_FILE`          | —                              | Required when the destination is `file`.               |
| `HOST`                        | `127.0.0.1`                    | HTTP bind address.                                     |
| `PORT`                        | `3000`                         | HTTP port.                                             |
| `EURODNS_MCP_AUTH`            | `none`                         | `oauth`, `token` or `none`.                            |
| `EURODNS_MCP_TOKEN`           | —                              | Shared secret, at least 32 characters.                 |
| `EURODNS_MCP_TOKEN_LABEL`     | `static-token`                 | Name recorded in the audit log for that token.         |
| `EURODNS_MCP_PUBLIC_URL`      | —                              | Canonical public URL; also the default OAuth audience. |
| `EURODNS_ALLOWED_ORIGINS`     | —                              | Comma-separated origins allowed to call the server.    |
| `EURODNS_OAUTH_ISSUER`        | —                              | Authorization server issuer.                           |
| `EURODNS_OAUTH_AUDIENCE`      | `EURODNS_MCP_PUBLIC_URL`       | Expected `aud` claim.                                  |
| `EURODNS_OAUTH_JWKS_URI`      | discovered                     | Overrides JWKS discovery.                              |
| `EURODNS_OAUTH_SUBJECT_CLAIM` | `sub`                          | Claim recorded as the actor.                           |
| `EURODNS_OAUTH_SCOPE_CLAIM`   | `scope`, `scp`, `roles`        | Claim carrying scopes.                                 |

## Development

```bash
npm install
npm run gen      # regenerate src/generated from spec/openapi.json
npm run build
npm test
npx @modelcontextprotocol/inspector node dist/index.js
```

The tool surface is generated from `spec/openapi.json`; CI regenerates it and fails if the
committed output has drifted. Edit the generator or the curated names and descriptions in
`src/tools/`, never `src/generated/`.

Tests run against a real MCP client over an in-memory transport, with the HTTP layer driven
through the real Express app. No test touches the network.

## Protocol version

Built on MCP `2025-11-25`, the revision the TypeScript SDK implements. Revision `2026-07-28`
removes sessions and the initialization handshake; this server is already stateless, and the
authorization design it relies on is unchanged in that revision, so adopting it will be an
SDK upgrade rather than a rewrite.

## License

MIT.
