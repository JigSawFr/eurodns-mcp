# HTTP transport

```bash
EURODNS_MCP_AUTH=token EURODNS_MCP_TOKEN="$(openssl rand -hex 32)" \
  docker run --rm -p 3000:3000 \
    -e EURODNS_APP_ID -e EURODNS_API_KEY \
    -e EURODNS_MCP_AUTH -e EURODNS_MCP_TOKEN \
    ghcr.io/jigsawfr/eurodns-mcp:latest
```

The endpoint is `POST /mcp`; `GET /healthz` reports readiness without authentication.
Sessions are not used, so any number of instances can sit behind a load balancer.

The server **refuses to start on a non-loopback address without authentication**. Set
`EURODNS_ALLOWED_ORIGINS` when browser-based clients need to reach it — requests carrying
an `Origin` header that is not listed are rejected, which is what stops a DNS-rebinding
attack against a loopback deployment.

### OAuth 2.1

For a worked setup with a real authorization server, including the traps that only
show up in practice, see the [Microsoft Entra ID guide](entra-id.md).
The server is an OAuth **resource server**. It does not issue tokens and embeds no identity
provider: point it at any authorization server that publishes RFC 8414 or OpenID Connect
discovery metadata.

```bash
EURODNS_MCP_AUTH=oauth \
EURODNS_OAUTH_ISSUER=https://issuer.example.com \
EURODNS_MCP_PUBLIC_URL=https://mcp.example.com/mcp \
  docker run --rm -p 3000:3000 -e EURODNS_MCP_AUTH -e EURODNS_OAUTH_ISSUER \
    -e EURODNS_MCP_PUBLIC_URL -e EURODNS_APP_ID -e EURODNS_API_KEY \
    ghcr.io/jigsawfr/eurodns-mcp:latest
```

At the authorization server, register this server as an API whose identifier is exactly
`EURODNS_MCP_PUBLIC_URL`, expose the scopes above, and let your MCP client request them.
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

---

[← Documentation](README.md) · [Tools](tools.md) · [Guardrails](guardrails.md) · [HTTP transport](http-transport.md) · [Audit log](audit-log.md) · [Secrets](secrets.md) · [Configuration](configuration.md) · [Protocol](protocol.md) · [Entra ID](entra-id.md) · [Development](development.md)
