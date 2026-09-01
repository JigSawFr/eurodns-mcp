<div align="center">

# eurodns-mcp

**Manage your domains, DNS zones and subscriptions by asking for it.**

A [Model Context Protocol](https://modelcontextprotocol.io) server for the EuroDNS User API —
domains, DNS zones, contacts, subscriptions, SSL, invoices and orders.

[![CI](https://github.com/JigSawFr/eurodns-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/JigSawFr/eurodns-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](package.json)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-8A63D2.svg)](https://modelcontextprotocol.io/specification/2026-07-28)
[![Image](https://img.shields.io/badge/ghcr.io-eurodns--mcp-2496ED.svg)](https://github.com/JigSawFr/eurodns-mcp/pkgs/container/eurodns-mcp)

**[Documentation](docs/README.md)** · [Tools](docs/tools.md) · [Guardrails](docs/guardrails.md) · [Deploying](deploy/README.md)

</div>

> This is an independent open-source project. It is **not affiliated with, endorsed by, or
> supported by EuroDNS**. "EuroDNS" is used only to identify the API this server talks to.

> Written by a professional engineer with AI assistance. Every line was reviewed before it
> was committed, and the responsibility for what it does is human.

---

## What you get

- **Full API coverage** — 79 tools generated from the OpenAPI document, grouped into 16 areas.
- **Three DNS workflow tools** that make record edits safe, because saving a zone replaces it.
- **Guardrails** so a deployment can refuse operations that spend money or destroy things.
- **Two transports** — `stdio` for a local client, streamable HTTP for a shared deployment.
- **Both protocol eras on one endpoint** — speaks the 2026-07-28 revision natively and
  still serves 2025-era clients, which is most of them today.
- **OAuth 2.1 or a shared token** on HTTP, with an audit line per call.
- **Queryable history** — ask the server what has been done, and by whom.
- **1Password Connect** as an optional source for any secret it reads.

## How it works

```mermaid
flowchart TD
    client(["MCP client"])

    client -->|stdio| registry
    client -->|streamable HTTP| origin

    subgraph http ["HTTP transport only"]
        origin["Origin check"] --> bearer["Bearer token<br/>OAuth 2.1 or shared secret"]
        bearer --> scopes["Scope gate"]
    end

    scopes --> registry["Tool registry"]
    registry --> guard{"Guardrails<br/>read-only, billing, destructive"}
    guard -->|refused| deny["Error naming the setting to change"]
    guard -->|allowed| api[("EuroDNS User API")]

    op[("1Password Connect")] -.->|"op:// refs, at startup"| creds["Credentials"]
    creds -.-> api

    registry -.-> log[("Audit log")]
    guard -.-> log
    log -.->|eurodns_audit_query| client
```

Two things are worth reading off that diagram. Authorisation has **two independent gates** —
what the deployment permits at all, then what the caller's scopes permit within it. And the
audit log is fed by **every** path, including refusals, because the upstream API
authenticates every caller with one shared key and cannot attribute anything itself.

## Requirements

- Node.js 22 or newer. Node 20 reached end of life on 30 April 2026 and receives no
  security patches; the container image runs Node 24, the active LTS.
- EuroDNS API credentials: an **Application ID** and an **API key**, created in the EuroDNS
  dashboard under API access.
- **The public IP of the machine running this server must be allowlisted** in the same
  dashboard. A `403` from the API is almost always a missing allowlist entry, not bad
  credentials.

## Quick start

The package is not on npm yet, so it installs from this repository. For a client that spawns
the server itself, such as Claude Desktop:

```json
{
  "mcpServers": {
    "eurodns": {
      "command": "npx",
      "args": ["-y", "-p", "github:JigSawFr/eurodns-mcp", "eurodns-mcp"],
      "env": {
        "EURODNS_APP_ID": "your-application-id",
        "EURODNS_API_KEY": "your-api-key"
      }
    }
  }
}
```

To try it in a terminal first:

```bash
npx -y -p github:JigSawFr/eurodns-mcp eurodns-mcp
```

`-p … eurodns-mcp` names the command to run. Without it npm looks for a command matching the
package name, `eurodns-mcp-server`, finds two that do not match, and refuses to guess:
`could not determine executable to run`. `eurodns-mcp-http` is the other one, for the HTTP
transport.

Installing this way clones the repository and builds it, so it needs read access — until the
repository is public, that means being signed in to a git account that has it.

For a shared deployment over HTTP, use the container instead — see [Deployment](#deployment).

Try not to put the API key in the client config file: [Secrets](docs/secrets.md) shows two
ways around it.

## What you can ask it

| Ask                                                   | Tool it reaches for                   |
| ----------------------------------------------------- | ------------------------------------- |
| "What DNS records does example.com have?"             | `eurodns_dns_get_zone`                |
| "Add a TXT record `_acme-challenge` on example.com"   | `eurodns_dns_upsert_record`           |
| "What would change if I pointed www at 203.0.113.10?" | `eurodns_dns_diff_zone`               |
| "Is example.lu available?"                            | `eurodns_domain_check_availability`   |
| "Which of my domains have DNSSEC enabled?"            | `eurodns_domain_search`               |
| "When does this SSL certificate expire?"              | `eurodns_ssl_list_subscriptions`      |
| "What is my prepaid balance?"                         | `eurodns_account_get_prepaid_balance` |
| "What did I change last week?"                        | `eurodns_audit_query`                 |
| "What was refused, and why?"                          | `eurodns_audit_query`                 |

## Documentation

| Page                                     | What it covers                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| [Tools](docs/tools.md)                   | All 82 tools, how they are named, and the three DNS workflow tools      |
| [Guardrails](docs/guardrails.md)         | Risk classes, what a deployment can forbid, confirmation before a call  |
| [Configuration](docs/configuration.md)   | Every environment variable, with its default                            |
| [HTTP transport](docs/http-transport.md) | Serving several clients, static tokens, OAuth 2.1 and scopes            |
| [Secrets](docs/secrets.md)               | Keeping the API key out of a client config, and 1Password Connect       |
| [Audit log](docs/audit-log.md)           | What is recorded, the hash chain, asking the server what happened       |
| [Entra ID](docs/entra-id.md)             | Step-by-step OAuth with Microsoft Entra ID, and its pitfalls            |
| [Deploying](deploy/README.md)            | Containers, Fly.io, Render, Railway, and shipping the log to a SIEM     |
| [Protocol](docs/protocol.md)             | Which MCP revisions are spoken, and how both are served at one endpoint |
| [Development](docs/development.md)       | Building, testing, the generated tool surface, and how releases work    |

## Deployment

```bash
cp .env.example .env    # credentials, plus a token: openssl rand -hex 32
docker compose up -d
curl localhost:3000/healthz
```

Published images live at `ghcr.io/jigsawfr/eurodns-mcp`, built for `linux/amd64` and
`linux/arm64` with a build provenance attestation.

Two things decide where this runs, and neither is the usual latency-or-price argument:

- **The EuroDNS API filters by source IP**, so the host has to give you a stable — ideally
  dedicated — egress address. An IP shared with other tenants keeps the mechanism and loses
  the protection.
- **The history query tool reads a file**, so the host needs a persistent disk. That rules
  out platforms with an ephemeral filesystem.

On both counts Fly.io comes out ahead, at a couple of dollars a month for a dedicated IPv4
against roughly $100 elsewhere. [`deploy/`](deploy/README.md) has the per-platform detail,
ready-made `fly.toml` and `render.yaml`, and the comparison in full.

One setting catches everyone once: inside a container the server listens on `0.0.0.0`, and
it **refuses to start on a non-loopback address without authentication**. Set
`EURODNS_MCP_AUTH` to `token` or `oauth`.

### Which of those two

The choice is not about how secure you want to be — both are — but about whether callers need
separate identities, and it has a cost you should see coming.

**`token`** is one shared secret in a header. It works in a minute, needs nothing but the
server, and is the right answer for a deployment one person uses. What you give up is
attribution: the audit log records a label, so it can tell you a destructive call happened but
not who made it.

**`oauth`** gives each person their own credential, lets the five scopes decide who may do
what, and puts a real identity in the audit log. The scopes decide what a caller may do; your
identity provider decides who gets a token at all, and most default to everyone in the
directory — so that setting is part of the configuration, not an afterthought. Its entry price is a hostname on a domain
your identity provider will accept — with Microsoft Entra ID that means a domain **verified in
your tenant**, because the server's public URL has to double as the Application ID URI. A
platform hostname like `*.fly.dev` cannot be verified, so the domain is not optional there.
[Entra ID](docs/entra-id.md) works the whole thing through, including the errors it produces
when the three names involved fall out of step, and how to go one step further and give each
person a _different_ set of scopes rather than the same one.

Starting on `token` and moving to `oauth` later costs nothing but a restart: no data
migration, no change to how tools behave.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) has the workflow, and
[docs/development.md](docs/development.md) the commands. Pull request titles are checked
against [Conventional Commits](https://www.conventionalcommits.org), because that is what the
changelog is generated from.

## License

[MIT](LICENSE).

"EuroDNS" is a trademark of EuroDNS S.A. and is not covered by that licence.
