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

**The server does not decide who may use it.** It checks that a token is genuine, issued for
it, and carries the right scope — then trusts the identity provider on the question of who is
holding it. That is the correct division of labour, and it has one consequence worth reading
twice: **anyone your tenant issues a token to can reach this server.** Step 1c is where you
narrow that, and skipping it leaves your DNS reachable by every account in the tenant.

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

> **Admin consent is tenant-wide.** It does not grant the scopes to you, or to the people you
> have in mind: it grants them to **every user in the tenant**. On its own, this step makes
> the server reachable by anyone who can sign in. Step 1c is what narrows that, and it is not
> optional.

Optionally, back under _Expose an API → Add a client application_, pre-authorise `<APP_ID>`.
That suppresses the per-user consent prompt.

### 1c. Decide who may use it

**This is the step that decides who can reach your DNS.** Do it before anyone connects.

The server does not keep a list of permitted users, by design: it validates the issuer, the
audience, the signature and the scopes, and reads the subject only to write it into the audit
log. Deciding _who_ is the identity provider's job. So if Entra issues a token, this server
will honour it.

Entra's default is to issue one to any user in the tenant. To change that:

> **Enterprise applications** — not App registrations — **→ `eurodns-mcp` → Properties →
> Assignment required? → Yes → Save**

Then **Users and groups → Add user/group**, and assign the people or the group who should
have access. Everyone else now gets `AADSTS50105` instead of a token.

Two things about this switch:

- **It lives on the enterprise application**, the service principal, not on the app
  registration you have been editing. Same name, different blade — which is most of why it
  gets missed.
- **Tokens already issued stay valid** until they expire, about an hour by default. To cut
  someone off immediately, revoke their sessions from their user profile as well.

The consent type you chose for each scope — _Admins and users_ or _Admins only_ — governs who
may **consent**, not who may **access** once admin consent has been granted. It is not a
substitute for this step.

This step answers _who may use it_. Everyone it lets in still gets **the same five scopes**,
because admin consent grants them to the whole tenant. _What each of them may do_ is
[per-person permissions with app roles](#narrowing-further-per-person-permissions-with-app-roles),
below.

### 1d. Ask for v2 tokens

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
identifier URI. (This is the other half of why step 1d matters.)

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
tries `scp` and then `roles`, which is both of Entra's spellings.

If you want each person to have a _different_ set of permissions rather than the same one,
that is the next section — and it needs one more variable.

---

## Narrowing further: per-person permissions with app roles

Optional, and the only way to give two people different permissions on this server.

Everything up to here has been all-or-nothing: step 1c decides who gets in, and everyone who
does gets the same five scopes. That is not a limitation of this server — it is what a
delegated scope _is_ under Entra. Admin consent is tenant-wide, the client requests all five,
and the token says so for everybody.

**App roles are the per-person half.** They are assigned to named users or groups, and Entra
puts them in a `roles` claim — in a delegated token as readily as an application one, despite
how often they are described as application-only.

The server can then require **both**: the scope in the token _and_ the matching assignment.
The scope says what the client asked for; the role says what this person is entitled to. A
scope without an assignment is a client asking for something its user may not have, and an
assignment without a scope is a permission the client never requested. Only the intersection
is a permission.

### A. Declare the five roles

**App registrations → `eurodns-mcp` → Manage → App roles → Create app role.** Five times:

| Display name        | Allowed member types | Value                 |
| ------------------- | -------------------- | --------------------- |
| EuroDNS read        | **Users/Groups**     | `eurodns.read`        |
| EuroDNS DNS write   | **Users/Groups**     | `eurodns.dns.write`   |
| EuroDNS destructive | **Users/Groups**     | `eurodns.destructive` |
| EuroDNS billing     | **Users/Groups**     | `eurodns.billing`     |
| EuroDNS audit       | **Users/Groups**     | `eurodns.audit`       |

- **`Value` must be exactly the scope name.** It is what lands in the token, and the server
  compares it literally against the same five strings it compares `scp` against. A capital
  letter or a hyphen where a dot belongs, and the role grants nothing. Dots are accepted; the
  space character is not, and the portal refuses an invalid value as you type it.
- **Allowed member types: Users/Groups**, not _Applications_. _Applications_ declares an
  application permission for the client-credentials flow, which is a different thing entirely
  and will not appear in a signed-in user's token.
- _Do you want to enable this app role?_ → **Yes**.

`Display name` and `Description` are for the assignment screen and the consent prompt; write
them for whoever will be picking from the list, not for the server.

### B. Assign the people

**Enterprise applications** — the service principal again, not the app registration —
**→ `eurodns-mcp` → Users and groups → Add user/group.** Pick the user, then **Select a
role**, then Assign.

- **One role per assignment.** To give somebody two, repeat _Add user/group_ with the same
  user and the other role. Entra allows any number of assignments per person.
- **Assigning a group rather than a user requires an Entra ID P1 or P2 licence.** Check yours
  before designing the model around groups. **Nested groups are not supported** either — only
  direct membership grants the role.
- Anyone still on **Default Access** — assigned to the app in step 1c but to no role — gets a
  valid token with no `roles` claim, and therefore no tools at all. That is the intended
  direction of failure, and the server says so in its log rather than leaving you guessing.

A workable starting split: `eurodns.read` to everyone who needs the server,
`eurodns.dns.write` to whoever edits zones, and `eurodns.destructive`, `eurodns.billing` and
`eurodns.audit` to one or two named people.

### C. Turn it on

One line, added to the six in step 2:

```bash
EURODNS_OAUTH_ROLE_CLAIM=roles
```

Unset, nothing changes — the assignments sit there harmlessly and the token's scopes remain
the whole test. That is also how you back out.

### What this changes about failure

**A `403` stops being a step-up.** The scope gate still answers `insufficient_scope` and
still names the scope in `WWW-Authenticate`, because that is what the specification requires.
A client will still take that name back to Entra and ask for consent — and Entra will grant
it, because consent was never what was missing. The token comes back with the same `roles`
claim and the same `403` follows. Under this mode, a `403` means _ask an administrator for
the role_, not _ask again_.

**Everything refused, with a token that looks fine**, is the other new failure. The log names
it directly:

```json
{
  "level": "warn",
  "message": "token grants nothing",
  "reason": "no \"roles\" claim, so no permission survives the intersection",
  "expected": { "roleClaim": "roles" }
}
```

Three causes, in the order worth checking: the roles were declared but nobody was assigned;
the caller is on Default Access; or a `Value` does not match its scope character for
character.

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

| Claim   | Should be                                                                                            |
| ------- | ---------------------------------------------------------------------------------------------------- |
| `iss`   | `https://login.microsoftonline.com/<TENANT_GUID>/v2.0` — `sts.windows.net` means step 1d was skipped |
| `aud`   | the bare `<APP_ID>` GUID                                                                             |
| `ver`   | `2.0`                                                                                                |
| `scp`   | the **bare** scope names, e.g. `eurodns.read` — not the qualified form                               |
| `roles` | present only with app roles assigned; the same bare names, and the per-person half of the answer     |

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

| Code                                                     | Cause                                                                                                                                                                                         |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AADSTS9010010`                                          | `resource` does not match the scopes' prefix. Application ID URI, `EURODNS_MCP_PUBLIC_URL` and `EURODNS_OAUTH_SCOPE_PREFIX` are not all one string                                            |
| `AADSTS500011`                                           | No app in the tenant carries that Application ID URI — step 1a was not applied, or was applied to another app                                                                                 |
| `AADSTS700016`                                           | The `client_id` sent does not exist in the tenant. Usually the client fell back to a hosted identity; set your own Client ID                                                                  |
| `AADSTS70011`                                            | A bare scope name where Entra wants the qualified form — `EURODNS_OAUTH_SCOPE_PREFIX` unset or wrong                                                                                          |
| `AADSTS50011`                                            | Redirect URI not registered, or registered under the wrong platform                                                                                                                           |
| `AADSTS7000215`                                          | Wrong client secret                                                                                                                                                                           |
| `AADSTS65001`                                            | Admin consent not granted — or granted before the Application ID URI changed, which invalidates it                                                                                            |
| `AADSTS50105`                                            | The user is not assigned to the enterprise application. This is step 1c working as intended; assign them, or leave them out on purpose                                                        |
| `invalid_client` on the device code flow                 | Confidential client; that flow needs _Allow public client flows_                                                                                                                              |
| `401`, token looks fine                                  | v1 token: step 1d. Check `ver`, `iss` and `aud` together                                                                                                                                      |
| `401` right after a working one                          | The token expired. Entra's default is about an hour                                                                                                                                           |
| `403`, _"requires the eurodns.x scope"_                  | The scope was not requested, or consent was not granted for it. Check `scp`                                                                                                                   |
| `403` on every tool, with `EURODNS_OAUTH_ROLE_CLAIM` set | No `roles` claim in the token. Roles declared but nobody assigned, the caller on Default Access, or a role `Value` that does not match its scope exactly. The log says `token grants nothing` |
| `403` on every call, tokens fine                         | Not OAuth at all — the **EuroDNS API** filters by source IP. Allowlist the host's egress address                                                                                              |
| `406` from `curl`                                        | Missing `Accept: application/json, text/event-stream`. See [Protocol](protocol.md)                                                                                                            |

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
