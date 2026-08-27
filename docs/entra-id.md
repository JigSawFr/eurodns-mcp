# OAuth with Microsoft Entra ID

A worked example of `EURODNS_MCP_AUTH=oauth`, end to end. Nothing here is Entra-specific in
the server — it validates any compliant authorization server — but Entra has enough sharp
edges to deserve its own page.

**What you get for the trouble:** callers stop sharing one token. Each person authenticates
as themselves, the five scopes decide who may do what, and the audit log records a real
identity instead of a shared label.

**The server holds no OAuth secret.** It only validates tokens. The client secret created
below lives in the client, never here.

---

## What you will create

Two app registrations, because Entra separates the API from the thing calling it:

1. a **resource** app — this server, which exposes the scopes;
2. a **client** app — the harness, which requests them.

You will also need your **tenant ID** (a GUID) — Entra admin centre → Overview.

---

## Step 1 — The resource app

**Entra admin centre → App registrations → New registration.**

- Name: `eurodns-mcp`
- Supported account types: **single tenant**
- Redirect URI: leave empty. This app never receives one.

Note the **Application (client) ID** it gives you. Call it `<RESOURCE_ID>`; you need it
twice below.

### 1a. Expose the API

**Manage → Expose an API → Add a scope.**

Accept the default Application ID URI, `api://<RESOURCE_ID>`, then add these five scopes.
Each must be **Admins and users** or **Admins only** — that is your call, and it is a real
one: `eurodns.destructive` should probably require an admin.

| Scope name            | What it authorises                        |
| --------------------- | ----------------------------------------- |
| `eurodns.read`        | Reading anything                          |
| `eurodns.dns.write`   | Changing DNS zone data                    |
| `eurodns.destructive` | Irreversible operations outside zone data |
| `eurodns.billing`     | Operations that spend money               |
| `eurodns.audit`       | Reading the audit log                     |

The names must match exactly — the server compares them literally.

### 1b. Ask for v2 tokens

**Manage → Manifest.** Set:

```json
"requestedAccessTokenVersion": 2
```

> **Do not skip this.** It is the single most common way this configuration fails. With v1
> tokens Entra issues an issuer of `https://sts.windows.net/<tenant>/` and an audience of
> `api://<RESOURCE_ID>` — so **both** the issuer check and the audience check below fail, and
> the error will not point you here.

---

## Step 2 — The client app

A second registration, for the harness that calls the server.

**App registrations → New registration.**

- Name: `eurodns-mcp-client`
- Redirect URIs, platform **Web** — add **both**, because the desktop and web builds differ:
  - `https://claude.ai/api/mcp/auth_callback`
  - `https://claude.com/api/mcp/auth_callback`

Then:

- **Certificates & secrets → New client secret.** Copy it now; Entra shows it once. It goes
  into the harness, never into this server.
- **API permissions → Add a permission → My APIs → `eurodns-mcp`** → select the scopes this
  client should have → **Grant admin consent**.

Optionally, back in the resource app, **Expose an API → Add a client application** and
pre-authorise this client ID. That suppresses the per-user consent prompt.

---

## Step 3 — Configure the server

```bash
EURODNS_MCP_AUTH=oauth
EURODNS_MCP_PUBLIC_URL=https://eurodns-mcp.example.com
EURODNS_OAUTH_ISSUER=https://login.microsoftonline.com/<TENANT_GUID>/v2.0
EURODNS_OAUTH_AUDIENCE=<RESOURCE_ID>
EURODNS_OAUTH_SUBJECT_CLAIM=oid
```

Four things about those five lines:

**The issuer must carry the tenant GUID.** Not `common`, not your domain name. The server
fetches the issuer's metadata and **refuses a document whose `issuer` does not match what you
configured** — which is what stops a hostile metadata document from redirecting trust.
`/common/` returns the literal placeholder `https://login.microsoftonline.com/{tenantid}/v2.0`
and will never match. A domain name resolves, but Entra answers with the GUID form anyway.

**The audience is the bare GUID**, not `api://<RESOURCE_ID>`. A v2 access token carries the
resource's client ID in `aud`. (This is the other half of why step 1b matters: a v1 token
carries the `api://` form and would be rejected here.)

**`oid`, not the default `sub`.** Entra's `sub` is a _pairwise pseudonymous identifier_ —
different for the same person in a different application, and meaningless to a human reading
the audit log. `oid` is the stable object ID of the user in your tenant.

**Nothing else is needed.** `EURODNS_OAUTH_JWKS_URI` is discovered. `EURODNS_OAUTH_ALGORITHMS`
defaults to the asymmetric set, and Entra signs `RS256`. `EURODNS_OAUTH_SCOPE_CLAIM` already
tries `scp` (delegated) and `roles` (app-only), which is both of Entra's spellings.

---

## Step 4 — Prove it before involving a harness

Do this first. It separates a server problem from a client problem, and takes minutes.

Grant an **app role** to a client so you can use client credentials, or use any flow that
gets you a token, then:

```bash
TOKEN=…   # never commit this; export it in your shell

curl -s https://eurodns-mcp.example.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A tool list back means issuer, audience and signature all check out.

You can inspect what you were issued without any secret — the payload is base64, not
encrypted:

```bash
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool
```

Check three fields:

| Claim            | Should be                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `iss`            | `https://login.microsoftonline.com/<TENANT_GUID>/v2.0` — **`sts.windows.net` means step 1b was skipped** |
| `aud`            | the bare `<RESOURCE_ID>` GUID                                                                            |
| `scp` or `roles` | the bare scope names, e.g. `eurodns.read eurodns.dns.write`                                              |

That last one is worth seeing for yourself: the client _requests_
`api://<RESOURCE_ID>/eurodns.read`, but the token carries the **bare** name — which is what
the server compares against.

---

## What is likely to go wrong

| Symptom                                             | Cause                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Startup: _"declares issuer … which does not match"_ | `common`, or a domain name, in `EURODNS_OAUTH_ISSUER`. Use the GUID.                |
| `401`, token looks fine                             | `iss` is `sts.windows.net` → step 1b. Or `aud` is `api://…` → same cause.           |
| `401` right after a working one                     | The token expired. Entra's default is about an hour.                                |
| `403`, _"requires the eurodns.x scope"_             | The scope was not requested, or admin consent was not granted. Check `scp`.         |
| `403` on every call, tokens fine                    | Not OAuth at all — the **EuroDNS API** filters by source IP. Allowlist the host.    |
| `406` from `curl`                                   | Missing `Accept: application/json, text/event-stream`. See [Protocol](protocol.md). |

---

## The part that may not work, and it is not the server

**Entra does not support Dynamic Client Registration.** Verified directly — its metadata
document publishes no `registration_endpoint`:

```bash
curl -s https://login.microsoftonline.com/<TENANT_GUID>/v2.0/.well-known/openid-configuration \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print("registration_endpoint" in d)'
# False
```

That alone is survivable: Claude Desktop's connector has Client ID and Client Secret fields
under Advanced settings, which is what step 2 produced.

The real risk is **RFC 8707 resource indicators**. MCP requires the client to send
`resource=<server URL>` to `/authorize` and `/token`. Entra validates that parameter against
the registered Application ID URI and expects scopes in `api://<id>/<scope>` form. Where the
two disagree the flow fails in a distinctive way: authorization succeeds, and then the client
never exchanges the code.

Entra also does not advertise `code_challenge_methods_supported`, although it does implement
PKCE with S256. A client that checks that field before starting will refuse.

Neither is something this server can fix, and the published workaround — an OAuth proxy that
rewrites the parameters between client and Entra — is a project of its own. **So do step 4
first.** If the token validates and the connector still will not complete, you have learned
the server is correct and the gap is in the client-to-Entra handshake, and you can fall back
to `EURODNS_MCP_AUTH=token` with the stdio bridge in [Protocol](protocol.md) while keeping
this configuration for the day the handshake catches up.

---

[← Documentation](README.md) · [Tools](tools.md) · [Guardrails](guardrails.md) · [HTTP transport](http-transport.md) · [Audit log](audit-log.md) · [Secrets](secrets.md) · [Configuration](configuration.md) · [Protocol](protocol.md) · [Entra ID](entra-id.md) · [Development](development.md)
