# Configuration reference

<details>
<summary>All environment variables</summary>

| Variable                       | Default                        | Purpose                                                  |
| ------------------------------ | ------------------------------ | -------------------------------------------------------- |
| `EURODNS_APP_ID`               | —                              | **Required.** Application ID.                            |
| `EURODNS_API_KEY`              | —                              | **Required.** API key.                                   |
| `EURODNS_BASE_URL`             | `https://rest-api.eurodns.com` | API base URL.                                            |
| `EURODNS_TIMEOUT_MS`           | `30000`                        | Upstream request timeout.                                |
| `EURODNS_MAX_RETRIES`          | `2`                            | Retries, for 429 and 5xx only.                           |
| `EURODNS_CHARACTER_LIMIT`      | `25000`                        | Response size before truncation.                         |
| `EURODNS_READ_ONLY`            | `false`                        | Advertise read tools only.                               |
| `EURODNS_ALLOW_BILLING`        | `false`                        | Permit operations that cost money.                       |
| `EURODNS_ALLOW_DESTRUCTIVE`    | `false`                        | Permit irreversible non-DNS operations.                  |
| `EURODNS_CONFIRM`              | `off`                          | `off`, `destructive` or `all`. Ask before running.       |
| `EURODNS_AUDIT_DESTINATION`    | `stderr`                       | `stderr`, `stdout`, `file`, `none`.                      |
| `EURODNS_AUDIT_FILE`           | —                              | Required when the destination is `file`.                 |
| `EURODNS_AUDIT_QUERY`          | `off`                          | `off`, `own` or `all`. Requires the `file` destination.  |
| `EURODNS_AUDIT_MAX_BYTES`      | `67108864`                     | Size at which the log rotates to `<file>.1`.             |
| `OP_CONNECT_HOST`              | —                              | 1Password Connect server, when using `op://` references. |
| `OP_CONNECT_TOKEN`             | —                              | Connect token for that server.                           |
| `HOST`                         | `127.0.0.1`                    | HTTP bind address.                                       |
| `PORT`                         | `3000`                         | HTTP port.                                               |
| `EURODNS_MCP_AUTH`             | `none`                         | `oauth`, `token` or `none`.                              |
| `EURODNS_MCP_TOKEN`            | —                              | Shared secret, at least 32 characters.                   |
| `EURODNS_MCP_TOKEN_LABEL`      | `static-token`                 | Name recorded in the audit log for that token.           |
| `EURODNS_MCP_PUBLIC_URL`       | —                              | Canonical public URL; also the default OAuth audience.   |
| `EURODNS_ALLOWED_ORIGINS`      | —                              | Comma-separated origins allowed to call the server.      |
| `EURODNS_MAX_BODY_BYTES`       | `1048576`                      | Largest JSON body accepted, checked before auth.         |
| `EURODNS_METRICS_TOKEN`        | —                              | Enables `GET /metrics` and is the bearer it requires.    |
| `EURODNS_RATE_LIMIT`           | `300`                          | Requests per window on `/mcp`. `0` disables it.          |
| `EURODNS_RATE_LIMIT_WINDOW_MS` | `60000`                        | The window, in milliseconds.                             |
| `EURODNS_TRUST_PROXY`          | `0`                            | Proxy hops to trust for the client address.              |
| `EURODNS_OAUTH_ISSUER`         | —                              | Authorization server issuer.                             |
| `EURODNS_OAUTH_AUDIENCE`       | `EURODNS_MCP_PUBLIC_URL`       | Expected `aud` claim.                                    |
| `EURODNS_OAUTH_JWKS_URI`       | discovered                     | Overrides JWKS discovery.                                |
| `EURODNS_OAUTH_SUBJECT_CLAIM`  | `sub`                          | Claim recorded as the actor.                             |
| `EURODNS_OAUTH_SCOPE_CLAIM`    | `scope`, `scp`, `roles`        | Claim carrying scopes.                                   |
| `EURODNS_OAUTH_ALGORITHMS`     | asymmetric set                 | Signature algorithms accepted. Never includes `HS*`.     |

</details>

---

[← Documentation](README.md) · [Tools](tools.md) · [Guardrails](guardrails.md) · [HTTP transport](http-transport.md) · [Audit log](audit-log.md) · [Secrets](secrets.md) · [Configuration](configuration.md) · [Protocol](protocol.md) · [Development](development.md)
