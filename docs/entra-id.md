# OAuth with Microsoft Entra ID

A worked example of `EURODNS_MCP_AUTH=oauth`, end to end. Nothing here is Entra-specific in
the server — it validates any compliant authorization server — but Entra has enough sharp
edges to deserve its own page.

Everything below was run against a live tenant, and every error code in the table near the
bottom is one this configuration actually produced on the way to working.

**What you get for the trouble:** callers stop sharing one token. Each person authenticates
as themselves, the five scopes decide who may do what, and the audit log records a real
identity instead of a shared label.

**The server holds no OAuth secret.** It only validates tokens. The client secret created
below lives in the client, never here.

---

## Before you start: the one prerequisite that decides everything

**You need a hostname on a domain verified in your tenant, serving this server.**

Not a nice-to-have. Entra accepts an `https://` Application ID URI only on a verified custom
domain or your tenant's initial `*.onmicrosoft.com` domain — and, as the next section
explains, the Application ID URI has to be this server's public URL. A platform hostname such
as `*.fly.dev` can never be verified in your tenant, so it can never be that URI.

So the shape of the requirement is:

1. a domain you own, added and **verified** under Entra admin centre → **Custom domain names**;
2. a hostname under it pointing at this server, with a certificate;
3. that hostname used consistently as the Application ID URI, `EURODNS_MCP_PUBLIC_URL` and
   `EURODNS_OAUTH_SCOPE_PREFIX`.

[Deploying](../deploy/README.md) covers attaching a custom domain to the host.

**If that is more than you want**, `EURODNS_MCP_AUTH=token` is a legitimate answer rather than
a consolation prize: one shared secret, no tenant, no domain, working in a minute. You give
up per-person identity — the audit log records a label instead of a human — which is the
right trade for a server one person runs, and the wrong one for a team.

---

## Why the Application ID URI is the server's URL

This is the part that costs a day, so it comes before the steps.

MCP requires the client to send an RFC 8707 **resource indicator** — `resource=<the server's
canonical URL>` — to `/authorize` and `/token`. Entra's v2.0 endpoint does not really support
that parameter alongside v2 scopes: it compares `resource` against the Application ID URI
prefix of the scopes being requested, and refuses the request outright when they differ.

So all three of these must be **the same string**:

| Where                                | Value                         |
| ------------------------------------ | ----------------------------- |
| Entra: Application ID URI            | `https://mcp.example.com/mcp` |
| Server: `EURODNS_MCP_PUBLIC_URL`     | `https://mcp.example.com/mcp` |
| Server: `EURODNS_OAUTH_SCOPE_PREFIX` | `https://mcp.example.com/mcp` |

The default `api://<client-id>` that Entra offers cannot work here, because the client will
never send that as its resource. Keep the `/mcp` path in the URL rather than serving at the
root: at least one MCP client normalises a host-only resource by appending a trailing slash,
which breaks this comparison in a way that is very hard to see.

---

## What you will create

**One app registration.** Microsoft's documentation describes two — a resource app and a
client app — and that works, but a single registration can both expose the API and be the
client that calls it, which is one fewer thing to keep in step. Everything below assumes one.

You also need your **tenant ID** (a GUID) — Entra admin centre → Overview.

---

## Step 1 — The app registration

**Entra admin centre → App registrations → New registration.**

- Name: `eurodns-mcp`
- Supported account types: **single tenant**
- Redirect URIs, platform **Web** — add both, because client builds differ:
  - `https://claude.ai/api/mcp/auth_callback`
  - `https://claude.com/api/mcp/auth_callback`

Note the **Application (client) ID**. Call it `<APP_ID>`.

Then **Certificates & secrets → New client secret.** Copy it now; Entra shows it once. It
goes into the client, never into this server.

### 1a. Expose the API

**Manage → Expose an API → Application ID URI → Edit.** Replace the offered `api://<APP_ID>`
with this server's public URL:

```
https://mcp.example.com/mcp
```

No trailing slash — Entra rejects an identifier URI that ends in one.

Then **Add a scope**, five times:

| Scope name            | What it authorises                        |
| --------------------- | ----------------------------------------- |
| `eurodns.read`        | Reading anything                          |
| `eurodns.dns.write`   | Changing DNS zone data                    |
| `eurodns.destructive` | Irreversible operations outside zone data |
| `eurodns.billing`     | Operations that spend money               |
| `eurodns.audit`       | Reading the audit log                     |

The names must match exactly — the server compares them literally. Each is **Admins and
users** or **Admins only**; that is your call and a real one, and `eurodns.destructive`
should probably require an admin.

Their full form becomes `https://mcp.example.com/mcp/eurodns.read` and so on. Entra renames
them for you if you change the Application ID URI later — and **silently invalidates the
consent granted against the old names, so re-grant it every time.**

> **If the "My APIs" tab is empty** when you come to grant permissions, this step is why: an
> app appears there only once it has an Application ID URI _and_ at least one exposed scope.

### 1b. Grant the app permission to itself

**Manage → API permissions → Add a permission → My APIs → `eurodns-mcp`** → select the five
scopes → **Grant admin consent**.

Optionally, back under _Expose an API → Add a client application_, pre-authorise `<APP_ID>`.
That suppresses the per-user consent prompt.

### 1c. Ask for v2 tokens

**Manage → Manifest.** Set:

```json
"requestedAccessTokenVersion": 2
```

> **Do not skip this, and check it first when something is wrong.** It is the single most
> common way this configuration fails, and it fails most confusingly once the Application ID
> URI is an `https://` URL: a v1 token then carries that URL in `aud` instead of the bare
> GUID, and an issuer of `https://sts.windows.net/<tenant>/` instead of the v2.0 form. Both
> checks below fail at once, the client reports a plain `401`, and nothing points here.

---

## Step 2 — Configure the server

```bash
EURODNS_MCP_AUTH=oauth
EURODNS_MCP_PUBLIC_URL=https://mcp.example.com/mcp
EURODNS_OAUTH_ISSUER=https://login.microsoftonline.com/<TENANT_GUID>/v2.0
EURODNS_OAUTH_AUDIENCE=<APP_ID>
EURODNS_OAUTH_SUBJECT_CLAIM=oid
EURODNS_OAUTH_SCOPE_PREFIX=https://mcp.example.com/mcp
```

Five things about those six lines:

**The issuer must carry the tenant GUID.** Not `common`, not your domain name. The server
fetches the issuer's metadata and **refuses a document whose `issuer` does not match what you
configured** — which is what stops a hostile metadata document from redirecting trust.
`/common/` returns the literal placeholder `https://login.microsoftonline.com/{tenantid}/v2.0`
and will never match. A domain name resolves, but Entra answers with the GUID form anyway.

**The audience is the bare GUID**, and it stays the bare GUID even though the Application ID
URI is now a URL. A v2 access token carries the resource's client ID in `aud` whatever its
identifier URI. (This is the other half of why step 1c matters.)

**`oid`, not the default `sub`.** Entra's `sub` is a _pairwise pseudonymous identifier_ —
different for the same person in a different application, and meaningless to a human reading
the audit log. `oid` is the stable object ID of the user in your tenant.

**The scope prefix changes what the server says, never what it checks.** It qualifies two
outputs — the `scopes_supported` list in the protected resource metadata, and the `scope` a
`403` names when it asks a client to step up — because those are what a client hands back to
Entra. The comparison against the token's own scopes keeps using the **bare** name, because
that is what Entra puts in `scp`. The asymmetry looks like a bug and is not; a test pins it.

**Nothing else is needed.** `EURODNS_OAUTH_JWKS_URI` is discovered. `EURODNS_OAUTH_ALGORITHMS`
defaults to the asymmetric set, and Entra signs `RS256`. `EURODNS_OAUTH_SCOPE_CLAIM` already
tries `scp` (delegated) and `roles` (app-only), which is both of Entra's spellings.

---

## Step 3 — Check the cheap things before reaching for a token

In that order, because two of the three cost nothing.

**The manifest.** `requestedAccessTokenVersion` is `2`. One glance, and it is the likeliest
single cause of a `401` that looks like nothing is wrong.

**What the server advertises.** No credential needed — the metadata document is public:

```bash
curl -s https://mcp.example.com/.well-known/oauth-protected-resource/mcp \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["resource"]); print(*d["scopes_supported"], sep="\n")'
```

`resource` must equal your Application ID URI exactly, and **every** scope must start with it
followed by `/`. If those two hold, the half of this that lives here is solved.

**The server's own log.** A rejected token writes one line naming the claim that failed and
what was expected — never the token itself, and never a claim out of it:

```json
{
  "level": "error",
  "message": "token rejected",
  "reason": "unexpected \"aud\" claim value",
  "expected": { "issuer": "…/v2.0", "audience": "<APP_ID>" }
}
```

### Getting a token by hand, if you still need one

The device code flow is the least fiddly, with one catch that wastes an afternoon: **it is
for public clients only.** An app with a client secret answers `invalid_client`, and passing
the secret does not help. Turn on _Authentication → Allow public client flows_ for the
duration of the test, then turn it back off.

```bash
TENANT=…; APP=…
RESOURCE=https://mcp.example.com/mcp

curl -s -X POST "https://login.microsoftonline.com/$TENANT/oauth2/v2.0/devicecode" \
  -d client_id="$APP" -d scope="$RESOURCE/eurodns.read offline_access"
# open the URL it prints, enter the code, then poll:
curl -s -X POST "https://login.microsoftonline.com/$TENANT/oauth2/v2.0/token" \
  -d grant_type=urn:ietf:params:oauth:grant-type:device_code \
  -d client_id="$APP" -d device_code=…
```

The payload is base64, not encrypted, so you can read what you were issued without any
secret:

```bash
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool
```

| Claim            | Should be                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `iss`            | `https://login.microsoftonline.com/<TENANT_GUID>/v2.0` — `sts.windows.net` means step 1c was skipped |
| `aud`            | the bare `<APP_ID>` GUID                                                                             |
| `ver`            | `2.0`                                                                                                |
| `scp` or `roles` | the **bare** scope names, e.g. `eurodns.read` — not the qualified form                               |

That last row is worth seeing for yourself. The client _requests_
`https://mcp.example.com/mcp/eurodns.read`; the token carries `eurodns.read`. That is the
asymmetry step 2 describes, seen from the other end.

Then present it:

```bash
curl -s https://mcp.example.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A tool list back means issuer, audience and signature all check out.

---

## Step 4 — The client

Point the client at `https://mcp.example.com/mcp`. Entra publishes no `registration_endpoint`
(see below), so a client cannot register itself and will ask for credentials:

- **Client ID**: `<APP_ID>`
- **Client secret**: the one from step 1 — required, because a redirect URI registered under
  the **Web** platform makes this a confidential client, and Entra then demands client
  authentication at the token endpoint.

---

## Reading an error

Entra's messages are precise once you know where to look. A client usually shows only a trace
ID, so:

> Entra admin centre → **Monitoring & health → Sign-in logs** → filter on **Correlation ID**
> (try **Request ID** too; clients label them inconsistently) → the row's **Basic info** tab
> carries the `AADSTS` code and a plain-language failure reason.

**Check both tabs** — _User sign-ins_ and _Service principal sign-ins_. Which one a refusal
lands in depends on where in the exchange it happened, and looking in only one is how people
conclude, wrongly, that nothing was logged.

| Code                                     | Cause                                                                                                                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AADSTS9010010`                          | `resource` does not match the scopes' prefix. Application ID URI, `EURODNS_MCP_PUBLIC_URL` and `EURODNS_OAUTH_SCOPE_PREFIX` are not all one string |
| `AADSTS500011`                           | No app in the tenant carries that Application ID URI — step 1a was not applied, or was applied to another app                                      |
| `AADSTS700016`                           | The `client_id` sent does not exist in the tenant. Usually the client fell back to a hosted identity; set your own Client ID                       |
| `AADSTS70011`                            | A bare scope name where Entra wants the qualified form — `EURODNS_OAUTH_SCOPE_PREFIX` unset or wrong                                               |
| `AADSTS50011`                            | Redirect URI not registered, or registered under the wrong platform                                                                                |
| `AADSTS7000215`                          | Wrong client secret                                                                                                                                |
| `AADSTS65001`                            | Admin consent not granted — or granted before the Application ID URI changed, which invalidates it                                                 |
| `invalid_client` on the device code flow | Confidential client; that flow needs _Allow public client flows_                                                                                   |
| `401`, token looks fine                  | v1 token: step 1c. Check `ver`, `iss` and `aud` together                                                                                           |
| `401` right after a working one          | The token expired. Entra's default is about an hour                                                                                                |
| `403`, _"requires the eurodns.x scope"_  | The scope was not requested, or consent was not granted for it. Check `scp`                                                                        |
| `403` on every call, tokens fine         | Not OAuth at all — the **EuroDNS API** filters by source IP. Allowlist the host's egress address                                                   |
| `406` from `curl`                        | Missing `Accept: application/json, text/event-stream`. See [Protocol](protocol.md)                                                                 |

Startup failures are separate and say so on stderr — _"declares issuer … which does not
match"_ means `common`, or a domain name, in `EURODNS_OAUTH_ISSUER`. Use the GUID.

---

## What Entra does not do

**No Dynamic Client Registration.** Its metadata publishes no `registration_endpoint`:

```bash
curl -s https://login.microsoftonline.com/<TENANT_GUID>/v2.0/.well-known/openid-configuration \
  | python3 -c 'import sys,json; print("registration_endpoint" in json.load(sys.stdin))'
# False
```

Survivable, and step 4 is the answer: supply a Client ID and secret yourself.

**No `code_challenge_methods_supported`**, although Entra does implement PKCE with S256. A
client that checks that field before starting will refuse, and there is nothing to configure
away — that one is between the client and Entra.

**No real support for RFC 8707 resource indicators**, which is the root of everything on this
page. Entra treats `resource` as the legacy v1 parameter and validates it against the
Application ID URI rather than honouring it as an audience request. Aligning the two, as this
page does, works _with_ that behaviour rather than around it — nothing in this server rewrites
or hides a parameter to make it fit.

---

[← Documentation](README.md) · [Tools](tools.md) · [Guardrails](guardrails.md) · [HTTP transport](http-transport.md) · [Audit log](audit-log.md) · [Secrets](secrets.md) · [Configuration](configuration.md) · [Protocol](protocol.md) · [Entra ID](entra-id.md) · [Development](development.md)
