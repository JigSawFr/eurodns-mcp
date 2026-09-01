# Configuration

Everything is an environment variable. There is no configuration file, and nothing is read
from disk at startup except the audit log's own tail.

Two rules hold throughout:

- **Every value is validated at startup, and a bad one stops the process** with exit code
  `78` (`EX_CONFIG`) and a message naming the variable. A server that starts with a setting
  it did not understand is worse than one that refuses to start.
- **Any `EURODNS_*` variable may hold an `op://vault/item/field` reference** instead of a
  literal, resolved once at startup through 1Password Connect. See
  [Secrets](secrets.md).

## Credentials

### `EURODNS_APP_ID` · `EURODNS_API_KEY`

**Required, both.** The Application ID and API key created in the EuroDNS dashboard under
API access. Missing either stops the process:

```
Invalid configuration — appId: EURODNS_APP_ID is required; apiKey: EURODNS_API_KEY is required
```

```bash
EURODNS_APP_ID=your-application-id
EURODNS_API_KEY=your-api-key
```

Worth repeating because it costs people an afternoon: the API also filters by **source IP**.
Correct credentials from an unlisted address return `403`, which looks exactly like a bad
key. Allowlist the host's public egress IP in the same dashboard.

### `EURODNS_BASE_URL`

Default `https://rest-api.eurodns.com`. Only worth setting to point at a mock or a proxy.

```bash
EURODNS_BASE_URL=http://localhost:8080    # a recorded fixture server, in tests
```

## Upstream behaviour

### `EURODNS_TIMEOUT_MS`

Default `30000`. How long one upstream request may take before it is abandoned. Positive
integer.

### `EURODNS_MAX_RETRIES`

Default `2`. Retries on `5xx` and network errors only — a `4xx` is not retried, because it
will not become a `2xx` by being sent again. `0` disables retrying.

```bash
EURODNS_MAX_RETRIES=0     # fail fast; useful when debugging upstream errors
```

### `EURODNS_CHARACTER_LIMIT`

Default `25000`. Caps the characters one tool result may return, so a large zone or invoice
list cannot exhaust a model's context in a single call. Positive integer.

Results are rendered indented while they fit. Past the limit the indentation is dropped
before any data is — a whole compact answer beats a truncated readable one — and only a
payload still too large after that is cut, with a notice naming how much was omitted. A
result is never silently partial.

**Raise it for a programmatic caller.** The default is sized for a model reading the result,
where a very long list is a cost rather than an answer. A dashboard or a script parsing the
JSON has no such limit and truncation is pure loss for it; set this to whatever that caller
can actually handle. The trade is real either way — see
[`eurodns_domain_search`](tools.md) and its `size: -1`.

## Guardrails

These decide what the deployment permits **at all**, before any question of who is calling.
A disabled class is not merely refused — it is not advertised, so a model cannot try. See
[Guardrails](guardrails.md).

### `EURODNS_READ_ONLY`

Default off. When true, only `read` tools are advertised; everything that changes state
disappears.

```bash
EURODNS_READ_ONLY=true
```

> **The three switches below accept only `true`, `false`, `1`, `0`, or an empty value.**
> Anything else — `yes`, `on`, `TRUE` — is a startup error, not a silent false. Strictness
> is on purpose: a guardrail that quietly reads as off because of a spelling is the worst
> possible failure for a guardrail.

### `EURODNS_ALLOW_BILLING`

Default off, meaning billing tools are **hidden**. Set true to advertise operations that
create a charge or extend a paid term.

### `EURODNS_ALLOW_DESTRUCTIVE`

Default off, meaning irreversible tools are **hidden**. Set true to advertise operations that
destroy something outside DNS zone data.

> Both default to off, which is why a default deployment advertises **63** of the 82 tools.
> The startup line names each hidden class and the variable that reveals it.

### `EURODNS_CONFIRM`

Default `off`. Makes a matching operation ask the caller to confirm — naming the operation
and its target — before it runs.

| Value           | Effect                                             |
| --------------- | -------------------------------------------------- |
| `off` (default) | Nothing is asked.                                  |
| `destructive`   | Irreversible operations ask first.                 |
| `all`           | Irreversible **and** billing operations ask first. |

It guards against accidents, not against a hostile caller: the answer is asserted by the
client and never proven to come from a person. The switches above remain what decides
what is possible.

```bash
EURODNS_CONFIRM=destructive
```

One interaction to know about: a **2025-era client on the stateless HTTP transport** has no
session in which to carry the exchange, so a call that needs confirmation is refused there
rather than run unconfirmed. stdio and 2026-07-28 clients are unaffected. See
[Protocol](protocol.md).

## Audit log

What is recorded, by whom, and whether it can be read back. See [Audit log](audit-log.md).

### `EURODNS_AUDIT_DESTINATION`

Default `stderr`.

| Value              | Where lines go                                                                      |
| ------------------ | ----------------------------------------------------------------------------------- |
| `stderr` (default) | The standard error stream.                                                          |
| `stdout`           | Standard output. **Refused under stdio**, where stdout carries the JSON-RPC stream. |
| `file`             | The path in `EURODNS_AUDIT_FILE`. The only destination that can be read back.       |
| `none`             | Nowhere — but a collector still receives every line if one is configured.           |

### `EURODNS_AUDIT_FILE`

**Required when the destination is `file`**, ignored otherwise. Created mode `0600`.

```bash
EURODNS_AUDIT_DESTINATION=file
EURODNS_AUDIT_FILE=/data/audit.jsonl
```

### `EURODNS_AUDIT_MAX_BYTES`

Default `67108864` (64 MB). The size at which the log rotates to `audit.jsonl.1`, keeping
two generations — so budget **twice** this on the volume. The history query reads across
both; anything older is gone.

### `EURODNS_AUDIT_QUERY`

Default `off`. Registers the `eurodns_audit_query` tool, which answers questions about past
actions.

| Value           | Effect                                |
| --------------- | ------------------------------------- |
| `off` (default) | No query tool.                        |
| `own`           | A caller sees only their own actions. |
| `all`           | A caller sees every action.           |

**Requires `EURODNS_AUDIT_DESTINATION=file`** — stderr and stdout are write-only, so there
would be nothing to read back. Asking for it on another destination stops the process. The
tool is gated on its own `eurodns.audit` scope, not on `eurodns.read`.

## Shipping the log to a collector

Additive: these apply alongside whatever `EURODNS_AUDIT_DESTINATION` records locally, which
is what lets a deployment keep both the queryable file and an off-host copy.

### `EURODNS_AUDIT_FORWARD_URL`

Unset by default, which disables forwarding entirely. Each line is POSTed as
`application/x-ndjson`, byte-identical to what was written locally so the hash chain can be
re-verified downstream.

**Must be `https`**, except on a loopback address where a sidecar collector is the usual
arrangement. Anything else stops the process — an audit log names who changed what.

```bash
EURODNS_AUDIT_FORWARD_URL=https://collector.example/ingest
EURODNS_AUDIT_FORWARD_URL=http://127.0.0.1:9000/ingest   # accepted: loopback
EURODNS_AUDIT_FORWARD_URL=http://siem.example/ingest     # refused at startup
```

### `EURODNS_AUDIT_FORWARD_TOKEN`

Optional. Sent as `Authorization: Bearer …`. Setting it **without** the URL stops the
process, rather than letting a deployment believe it is shipping when it is not.

### `EURODNS_AUDIT_FORWARD_BATCH`

Default `100`. Lines per request. A batch that reaches this is sent immediately rather than
waiting out the interval.

### `EURODNS_AUDIT_FORWARD_INTERVAL_MS`

Default `5000`. How long a partial batch waits before it is sent anyway.

### `EURODNS_AUDIT_FORWARD_QUEUE`

Default `10000`. Lines held while the collector is unreachable. Beyond it the **oldest** are
dropped and counted — acceptable only because the local destination still has them. Watch
`eurodns_mcp_audit_forward_dropped_total` and `eurodns_mcp_audit_forward_failures_total`;
either being non-zero means the second copy has holes.

## HTTP transport

**Everything below is ignored under stdio**, where there is no listener. Validating it there
would only produce complaints about settings that do nothing. See
[HTTP transport](http-transport.md).

### `HOST` · `PORT`

Defaults `127.0.0.1` and `3000`. Inside a container, set `HOST=0.0.0.0`.

### `EURODNS_MCP_AUTH`

Default `none`.

| Value            | Meaning                                                   |
| ---------------- | --------------------------------------------------------- |
| `none` (default) | No authentication. **Only permitted on a loopback bind.** |
| `token`          | One shared bearer token, from `EURODNS_MCP_TOKEN`.        |
| `oauth`          | JWTs validated against an authorization server.           |

Binding to a non-loopback address with `none` stops the process:

```
Refusing to listen on 0.0.0.0 with EURODNS_MCP_AUTH=none. Bind to 127.0.0.1 for local
development, or set EURODNS_MCP_AUTH to "token" or "oauth".
```

This is the setting that catches everyone once, because a container binds `0.0.0.0` by
necessity.

### `EURODNS_MCP_TOKEN`

**Required when `EURODNS_MCP_AUTH=token`.** At least 32 characters, compared in constant
time.

```bash
EURODNS_MCP_AUTH=token
EURODNS_MCP_TOKEN="$(openssl rand -hex 32)"
```

### `EURODNS_MCP_TOKEN_LABEL`

Default `static-token`. The name recorded as the actor in every audit line made with the
shared token. Give each deployment its own, or the log cannot tell them apart.

```bash
EURODNS_MCP_TOKEN_LABEL=ci-pipeline
```

### `EURODNS_MCP_PUBLIC_URL`

The externally reachable URL of this server. Used to advertise protected-resource metadata,
and as the default `audience` when OAuth is on. No default.

```bash
EURODNS_MCP_PUBLIC_URL=https://eurodns-mcp.example.com
```

### `EURODNS_METRICS_TOKEN`

Unset by default, which **disables `/metrics` entirely**. Set it to at least 32 characters to
enable the Prometheus endpoint behind its own bearer token — deliberately not the MCP token,
so a monitoring system never holds a credential that can change DNS.

### `EURODNS_ALLOWED_ORIGINS`

Comma-separated. Empty by default, which rejects every browser request carrying an `Origin`
header — the defence against DNS rebinding. Non-browser clients send no `Origin` and are
unaffected.

```bash
EURODNS_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
```

### `EURODNS_MAX_BODY_BYTES`

Default `1048576` (1 MB). Request bodies above this are rejected before parsing.

### `EURODNS_LANDING_PAGE`

Default `on`. `GET /` then serves a short page saying what the address is, how to connect,
and where the project lives — for whoever opens the server's URL in a browser. Set it to
`off` and `/` returns the same `404` as any other unknown path.

```bash
EURODNS_LANDING_PAGE=off
```

The page names the endpoint, the protocol revision and the authentication mode, all of which
a `401` or the protected resource metadata already publish. It deliberately does **not** name
the version, the tool count, or which risk classes this deployment permits — the same
reasoning that keeps the version out of `/healthz`. Turn it off if you would rather the
address identified itself to no one at all.

### `EURODNS_RATE_LIMIT` · `EURODNS_RATE_LIMIT_WINDOW_MS`

Defaults `300` requests per `60000` ms, per client, on `/mcp` only. `/healthz` and
`/metrics` are deliberately outside it: putting a probe polled every few seconds behind a
limiter turns ordinary supervision into an outage.

`EURODNS_RATE_LIMIT=0` turns the limiter off. The limiter runs **before** authentication, so
a flood of unauthenticated requests is absorbed rather than merely rejected one by one.

### `EURODNS_TRUST_PROXY`

Default `0` — trust no forwarded client address. Set it to the **number of proxies** in front
of this server so the rate limiter sees the real client.

```bash
EURODNS_TRUST_PROXY=1     # one reverse proxy, e.g. a platform load balancer
```

Getting this wrong makes the limiter worse than absent: too high and any caller can spoof
`X-Forwarded-For` to get a fresh quota per request.

## OAuth

Only read when `EURODNS_MCP_AUTH=oauth`. For a worked example, see the
[Microsoft Entra ID guide](entra-id.md).

### `EURODNS_OAUTH_ISSUER`

**Required.** The authorization server's issuer URL. The server discovers its metadata from
this — trying RFC 8414 and OpenID Connect layouts in the order the specification lists — and
**refuses a document whose `issuer` does not match the value configured here**, which is what
stops a malicious metadata document from redirecting trust.

```bash
EURODNS_OAUTH_ISSUER=https://login.microsoftonline.com/<tenant-guid>/v2.0
```

### `EURODNS_OAUTH_AUDIENCE`

Required unless `EURODNS_MCP_PUBLIC_URL` is set, which it falls back to. A token issued for
another resource is rejected. Without it, any valid token from the same issuer would be
accepted here — including one minted for a different application entirely.

### `EURODNS_OAUTH_JWKS_URI`

Optional. Overrides the `jwks_uri` from discovery. Only needed when the authorization server
publishes no `jwks_uri`, in which case startup fails and names this variable.

### `EURODNS_OAUTH_SUBJECT_CLAIM`

Default `sub`. Which claim identifies the caller in the audit log. Worth changing when `sub`
is opaque — Entra ID's is a pairwise pseudonym, so `oid` is far more useful there.

```bash
EURODNS_OAUTH_SUBJECT_CLAIM=oid
```

### `EURODNS_OAUTH_SCOPE_CLAIM`

Unset by default, which tries `scope`, then `scp`, then `roles` — covering the common
spellings, including both of Entra ID's. Set it to pin one claim exactly.

### `EURODNS_OAUTH_ROLE_CLAIM`

Unset by default, which takes the token's scopes as the whole test. Set it to the claim that
names what the **person** was assigned, and a caller then needs both: the scope in the token
_and_ the matching assignment. The effective permissions are the intersection.

```bash
EURODNS_OAUTH_ROLE_CLAIM=roles
```

Why two claims answer two questions: under an authorization server that grants scopes
tenant-wide — Entra ID does — every token carries the same scopes, because the _client_
requested them and an administrator consented once for everybody. That says nothing about who
is holding it. An assignment does. A scope without an assignment is a client asking for
something its user may not have; an assignment without a scope is a permission the client
never asked for. Neither alone is the answer.

Three consequences worth knowing before you set it:

- **A token with no such claim at all grants nothing**, and the server writes one
  `token grants nothing` line to stderr saying so. That is the fail-closed direction, and the
  usual cause is a caller the identity provider left on default access.
- **The `403` step-up stops being a step-up.** The scope gate still names the missing scope
  in `WWW-Authenticate`, and a client will still go and ask for it — but consent is not what
  is missing, so it will come back with the same token. Under this mode a `403` means _ask an
  administrator_, not _ask again_.
- **It is reversible in one variable.** Unset it and the previous behaviour returns exactly,
  with the assignments left harmlessly in place.

[The Entra ID guide](entra-id.md) has the click-path for declaring and assigning the roles.

### `EURODNS_OAUTH_ROLE_PREFIX`

Unset by default, which takes a role value as a scope name exactly. Set it when the identity
provider forces the roles to be named differently from the scopes; it is stripped from each
value before the comparison, and a value that does not carry it is ignored rather than
trusted.

```bash
EURODNS_OAUTH_ROLE_PREFIX=role.
```

**Microsoft Entra ID forces this.** An application keeps its app roles and its delegated
scopes in one namespace, so a role cannot be named `eurodns.read` while a scope of that name
is exposed — Save answers _"It contains duplicate value."_ Name the roles
`role.eurodns.read` and so on, and set this to `role.`.

Setting it without `EURODNS_OAUTH_ROLE_CLAIM` is refused at startup: there would be no claim
to strip it from, and the deployment would read as though per-person permissions were on.

### `EURODNS_OAUTH_SCOPE_PREFIX`

Unset by default, which advertises scopes exactly as they are named — `eurodns.read` and the
rest. Set it when the authorization server requires a **qualified** scope name in the
authorization request.

```bash
EURODNS_OAUTH_SCOPE_PREFIX=https://mcp.example.com/mcp
```

A trailing slash is added if you leave it off, so the two forms are equivalent.

**Under Entra ID this is the server's own public URL**, not an `api://` identifier, and it
has to equal the Application ID URI exactly. That is not a stylistic preference — Entra
compares it against the `resource` parameter the client is required to send. See the
[Entra ID guide](entra-id.md) for why, and for the error it produces when they differ.

**It changes what the server says, never what it checks.** Two things carry the prefix: the
`scopes_supported` list in the protected resource metadata, and the `scope` a `403` names
when it asks a client to step up. The comparison against the token's own scopes keeps using
the bare name, because that is the form the token carries.

That asymmetry is not a quirk of this server — it is Entra ID's. It wants
`api://<app-id>/eurodns.read` in the authorization request and puts `eurodns.read` in the
token's `scp`. Advertising the bare name to it earns `AADSTS70011 — invalid scope`, and the
error arrives at the client with nothing pointing back here.

### `EURODNS_OAUTH_ALGORITHMS`

Comma-separated. Defaults to the asymmetric set `RS256, RS384, RS512, PS256, PS384, PS512,
ES256, ES384, ES512, EdDSA`. **Symmetric algorithms are absent on purpose**: accepting `HS*`
alongside a public JWKS is the classic key-confusion vulnerability. Setting the variable to
an empty value stops the process rather than silently accepting everything.

## 1Password Connect

Read only when some `EURODNS_*` variable holds an `op://` reference. See
[Secrets](secrets.md).

### `OP_CONNECT_HOST` · `OP_CONNECT_TOKEN`

The Connect server's URL and its token. If a reference is present and these are unset,
startup fails naming the variables that hold references — rather than starting with an
unresolved literal.

## Two complete examples

**Local, stdio, read-only** — the safest thing to hand a desktop client:

```bash
EURODNS_APP_ID=your-application-id
EURODNS_API_KEY=your-api-key
EURODNS_READ_ONLY=true
```

**Shared over HTTP, everything on, audited and shipped:**

```bash
HOST=0.0.0.0
PORT=3000

EURODNS_APP_ID=your-application-id
EURODNS_API_KEY=op://infra/eurodns/api-key      # resolved via 1Password Connect

EURODNS_MCP_AUTH=token
EURODNS_MCP_TOKEN=…                             # openssl rand -hex 32
EURODNS_MCP_TOKEN_LABEL=platform-team
EURODNS_MCP_PUBLIC_URL=https://eurodns-mcp.example.com

EURODNS_ALLOW_DESTRUCTIVE=true
EURODNS_ALLOW_BILLING=true
EURODNS_CONFIRM=destructive

EURODNS_AUDIT_DESTINATION=file
EURODNS_AUDIT_FILE=/data/audit.jsonl
EURODNS_AUDIT_QUERY=all
EURODNS_AUDIT_FORWARD_URL=https://collector.example/ingest
EURODNS_AUDIT_FORWARD_TOKEN=op://infra/collector/token

EURODNS_METRICS_TOKEN=…                         # openssl rand -hex 32
EURODNS_TRUST_PROXY=1
```

---

[← Documentation](README.md) · [Tools](tools.md) · [Guardrails](guardrails.md) · [HTTP transport](http-transport.md) · [Audit log](audit-log.md) · [Secrets](secrets.md) · [Configuration](configuration.md) · [Protocol](protocol.md) · [Entra ID](entra-id.md) · [Development](development.md)
