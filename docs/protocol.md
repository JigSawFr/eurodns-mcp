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

## Which harness, and what it needs

The protocol revision a client speaks is, for this server, **almost never the thing that
matters** — the SDK serves both eras on the same endpoint and neither has to be chosen. What
does matter is how a given harness connects and how it authenticates, because those are what
you have to configure.

The table below is limited to what could be verified. Where a cell says _check the client's
own docs_, treat that as "not established here" rather than "unsupported" — this table is
deliberately not a guess.

| Harness                                                       | How it reaches this server           | What to configure                                                                                        | Known catch                                                                                                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code**                                               | Streamable HTTP, direct              | `claude mcp add --transport http … --header "Authorization: Bearer …"`                                   | None. A static token works, which makes this the quickest remote client to try.                                                                                                              |
| **Claude Desktop**                                            | Custom connector, or stdio           | Connector expects OAuth — Authorization URL, Token URL, Client ID, Client Secret under Advanced settings | **No field for a static bearer token.** Either run `EURODNS_MCP_AUTH=oauth`, or bridge with `mcp-remote` (below).                                                                            |
| **ChatGPT** (connectors / developer mode)                     | Remote HTTPS, SSE or streamable HTTP | OAuth, or none                                                                                           | **Developer mode takes arbitrary tools and needs nothing extra.** The connector, company-knowledge and deep-research paths require a `search`/`fetch` pair: set `EURODNS_COMPAT_TOOLS=true`. |
| **Any stdio client** — Cursor, VS Code, Windsurf, Zed, Cline… | Spawns the process, stdio            | `command` + `args` + `env`, as in the project README                                                     | None. stdio is the universal path and needs no authentication: the trust boundary is the OS account.                                                                                         |
| Anything else, remote                                         | Streamable HTTP                      | `EURODNS_MCP_AUTH=token` and an `Authorization` header, or OAuth                                         | Check the client's own docs for whether it can send a static header.                                                                                                                         |

### The `search` / `fetch` pair

ChatGPT's connector, company-knowledge and deep-research paths look for two tools named
exactly `search` and `fetch`, with a fixed shape, and refuse the install without them. Its
**developer mode** takes arbitrary tools and needs none of this — so the pair opens one class
of client, not the client, which is worth knowing before turning it on.

`EURODNS_COMPAT_TOOLS=true` registers them. Both are reads over operations already exposed as
`eurodns_domain_search` and `eurodns_domain_get`: `search(query)` returns one result per
matching domain as `{ id, title, text }`, and `fetch(id)` returns that domain's full registry
record. The id is the domain name itself — unique in the account, already the key the upstream
read uses, and meaningful in a citation.

**It is off by default because of the names.** Every other tool here is prefixed `eurodns_`
so it cannot collide with another server's in a client that has several connected. These two
cannot be: the contract is the bare names. Turning the switch on accepts that `search` and
`fetch` may mean two things at once to a shared client — a reasonable trade to make
deliberately, and a bad one to inherit from an upgrade. A test pins the default surface so it
can only ever happen on purpose.

### The stdio bridge

When a harness wants a local command but the server runs remotely — Claude Desktop being the
common case — `mcp-remote` bridges the two:

```json
{
  "mcpServers": {
    "eurodns": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@latest",
        "https://eurodns-mcp.example.com/mcp",
        "--header",
        "Authorization:${EURODNS_AUTH_HEADER}"
      ],
      "env": { "EURODNS_AUTH_HEADER": "Bearer your-token" }
    }
  }
}
```

`Authorization:${VAR}` has no space after the colon on purpose: some clients mis-escape
spaces inside `args`, and the header then arrives malformed.

### Where the revision does matter

Exactly one place, and it is worth knowing before enabling it: **`EURODNS_CONFIRM`**.

Confirmation is written once, against the 2026-07-28 multi-round-trip mechanism, and the SDK
shims it for 2025-era clients by turning it into a real server-to-client request. That shim
needs somewhere to hold the exchange — and a 2025-era request on the **stateless HTTP**
transport has no session, having never sent an `initialize`. Such a call is therefore
**refused rather than run unconfirmed**.

| Client era | Transport      | Confirmation                          |
| ---------- | -------------- | ------------------------------------- |
| 2026-07-28 | HTTP or stdio  | Works, in-band                        |
| 2025       | stdio          | Works, through the shim               |
| 2025       | stateless HTTP | **Refused**, with an error saying why |

If your clients are 2025-era and remote, either leave `EURODNS_CONFIRM=off` and rely on
`EURODNS_ALLOW_DESTRUCTIVE` / `EURODNS_ALLOW_BILLING` to decide once for the whole
deployment, or reach the server over stdio through the bridge above.

---

[← Documentation](README.md) · [Tools](tools.md) · [Guardrails](guardrails.md) · [HTTP transport](http-transport.md) · [Audit log](audit-log.md) · [Secrets](secrets.md) · [Configuration](configuration.md) · [Protocol](protocol.md) · [Entra ID](entra-id.md) · [Development](development.md)
