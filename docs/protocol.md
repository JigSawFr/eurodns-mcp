# Protocol revisions

The server speaks the **2026-07-28** revision — a stateless core, header-based routing,
cacheable list results — and answers 2025-era clients on the same endpoint without any
configuration. That matters because the two eras handshake differently: 2026-07-28 removed
`initialize` in favour of `server/discover`, so a 2025 client's handshake is what identifies
it. Nothing is stranded, and nothing has to be chosen up front.

One consequence is worth knowing before you point a client at it. Answers on the 2025-era
path now arrive as a **single SSE frame** rather than a plain JSON body, so the endpoint
requires the `Accept` header streamable HTTP has always specified:

```
Accept: application/json, text/event-stream
```

A client sending only `application/json` — or `*/*` — is answered `406`. Every conforming
MCP client already sends both; a hand-rolled `curl` probe usually does not, and that is the
one thing that will surprise you.

---

[← Documentation](README.md) · [Tools](tools.md) · [Guardrails](guardrails.md) · [HTTP transport](http-transport.md) · [Audit log](audit-log.md) · [Secrets](secrets.md) · [Configuration](configuration.md) · [Protocol](protocol.md) · [Development](development.md)
