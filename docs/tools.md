# Tools

The 79 operations of the OpenAPI document are served by **59 generated tools** — 40 that are
one operation each, and 19 that stand in for a pair (a listing and its lookup, a create and
its replace, an on and its off) — plus four hand-written tools: three DNS workflow tools and
`eurodns_portfolio_refresh`. That is 63 tools with every risk class enabled, and **44** on a
default deployment, which hides billing and irreversible operations. The history query and the
compatibility pair are opt-in extras on top.

| Area              | Default | All | Covers                                                       |
| ----------------- | ------: | --: | ------------------------------------------------------------ |
| `dns`             |      14 |  14 | Zones, records, zone profiles, snapshots, DNSSEC signing     |
| `ssl`             |       6 |  12 | Subscriptions, certificates, validation, reissue, revoke     |
| `premium_dns`     |       1 |   7 | Premium DNS subscriptions and their lifecycle                |
| `contact`         |       4 |   5 | Reusable contact profiles, default states, validation emails |
| `email`           |       4 |   5 | Mailbox subscriptions, aliases, catch-all, passwords         |
| `domain`          |       4 |   4 | Domain lookup, search, availability, DNSSEC at the registry  |
| `https_redirect`  |       1 |   4 | HTTPS redirect subscriptions                                 |
| `nameserver`      |       2 |   3 | Reusable nameserver profiles                                 |
| `subscription`    |       1 |   2 | Cross-product search, auto-renewal settings                  |
| `account`         |       1 |   1 | Prepaid balance                                              |
| `invoice`         |       1 |   1 | Invoice lookup and search                                    |
| `invoice_profile` |       1 |   1 | Customer invoice profiles                                    |
| `microsoft`       |       1 |   1 | Microsoft subscriptions                                      |
| `order`           |       1 |   1 | Orders and per-line delivery status                          |
| `portfolio`       |       1 |   1 | Refreshing the cached domain list behind completion          |
| `tld`             |       1 |   1 | TLD terms and requirements                                   |

Every tool name is prefixed with `eurodns_` so it cannot collide with another server's, and
carries `readOnlyHint`, `destructiveHint` and `idempotentHint` annotations derived from what
the operation actually does. The one exception is deliberate and opt-in: `EURODNS_COMPAT_TOOLS`
adds an unprefixed `search`/`fetch` pair for clients that require those exact names — see
[Protocol](protocol.md).

Every tool and every argument carries a hand-written description: what the tool does and
returns, when to prefer it over its neighbours by their exact names, and what each argument
means and where its value comes from. The vendor's document says what an endpoint is called,
not what it is for, and left 110 of its 127 parameters undescribed; `tests/descriptions.test.ts`
holds the whole surface to that standard, so a tool that restates its title or an `id` that
does not say which object it names fails the build.

## One tool for a pair of operations

The document exposes its collections as pairs — `GET /invoices` and `GET /invoices/{id}`,
`POST /contact-profiles` and `PUT /contact-profiles/{id}`, `/sign` and `/unsign` — and a tool
per endpoint made the model choose between twins that differ only in whether it holds an id.
Each pair is now one tool whose arguments carry that choice, under three conventions:

- **`…_get_<object>`** returns one item when `id` is given and lists or searches them, with the
  listing's own filters and pagination, when it is omitted. The id argument is always `id`,
  whatever the API calls it.
- **`…_save_<object>`** creates when `id` is omitted and **replaces** when it is given. A
  replace must send every field, changed or not: the API clears anything left out, which is
  why the description tells you to read the object first.
- **`…_set_<thing>`** flips one setting: `enabled` true or false for DNSSEC and the catch-all,
  `action` `add` or `remove` for a mailbox alias.

Both halves of a pair always share a risk class, so hiding a class, gating a scope and asking
for confirmation still apply to a whole tool, and the audit line names the tool that was
called rather than the operation it resolved to.

Names that changed, and what replaces them:

| Before                                                                    | Now                                                                                |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `eurodns_dns_list_zone_snapshots`                                         | `eurodns_dns_get_zone_snapshot` without `id`                                       |
| `eurodns_dns_list_zone_profiles`                                          | `eurodns_dns_get_zone_profile` without `id`                                        |
| `eurodns_dns_create_zone_profile`                                         | `eurodns_dns_save_zone_profile` without `id`                                       |
| `eurodns_dns_sign_zone` / `eurodns_dns_unsign_zone`                       | `eurodns_dns_set_dnssec` with `enabled` true / false                               |
| `eurodns_domain_sign` / `eurodns_domain_unsign`                           | `eurodns_domain_set_dnssec` with `enabled` true / false                            |
| `eurodns_dns_delete_record_by_id`                                         | `eurodns_dns_delete_record` with `recordId`                                        |
| `eurodns_tld_list`                                                        | `eurodns_tld_get` without `id`                                                     |
| `eurodns_invoice_list`                                                    | `eurodns_invoice_get` without `id`                                                 |
| `eurodns_invoice_profile_list`                                            | `eurodns_invoice_profile_get` without `id` (`cipId` is now `id`)                   |
| `eurodns_order_list`                                                      | `eurodns_order_get` without `id`                                                   |
| `eurodns_contact_list_profiles`                                           | `eurodns_contact_get_profile` without `id`                                         |
| `eurodns_contact_create_profile` / `eurodns_contact_update_profile`       | `eurodns_contact_save_profile` without / with `id`                                 |
| `eurodns_nameserver_list_profiles`                                        | `eurodns_nameserver_get_profile` without `id`                                      |
| `eurodns_nameserver_create_profile` / `eurodns_nameserver_update_profile` | `eurodns_nameserver_save_profile` without / with `id`                              |
| `eurodns_email_list_subscriptions`                                        | `eurodns_email_get_subscription` without `id`                                      |
| `eurodns_email_create_alias` / `eurodns_email_delete_alias`               | `eurodns_email_set_alias` with `action` add / remove                               |
| `eurodns_email_create_catchall` / `eurodns_email_delete_catchall`         | `eurodns_email_set_catchall` with `enabled` true / false                           |
| `eurodns_premium_dns_list_subscriptions`                                  | `eurodns_premium_dns_get_subscription` without `id` (`subscriptionId` is now `id`) |
| `eurodns_ssl_list_subscriptions`                                          | `eurodns_ssl_get_subscription` without `id` (`subscriptionId` is now `id`)         |
| `eurodns_microsoft_list_subscriptions`                                    | `eurodns_microsoft_get_subscription` without `id`                                  |
| `eurodns_subscription_list`                                               | `eurodns_subscription_search`                                                      |

## What the model is told before it starts

The handshake carries an `instructions` block, which is the one piece of text every client
injects into the model's context. This page explains the same traps to you at length; a model
reaching for a tool has never read it, and used to discover them by making them against a live
account.

It is derived from the configuration rather than fixed, so it names the character limit **this**
deployment enforces and the risk classes it hides — a hidden tool is absent rather than refused,
and the block says which variable would bring it back. A server started without credentials
(see [Configuration](configuration.md#credentials)) says that too, so the model reads the first
refusal as a fact about the deployment rather than a fault to retry. It runs to about 450 tokens, paid once
per session, and deliberately covers only what costs data to get wrong: the zone save that
replaces everything, `rdata`, the TTL list, the pseudo record types, the shape of a listing
call, and the fact that a `403` is an allowlist problem. Everything else lives in the tool
descriptions, which are only paid for when a tool is used.

## Pagination

Every tool over a list endpoint takes four ordinary arguments — `page`, `size`, `sortField`
and `sortOrder` — instead of the `pagination-*` headers the API expects. The server maps them
back onto the headers.

`size` must be between **1 and 500**. There is no value meaning "everything": pulling a whole
portfolio means walking pages.

That is worth stating plainly because the vendor's own OpenAPI document says otherwise. Three
endpoints — `POST /domains/search`, `GET /zone-profiles` and `GET /tlds` — describe
`pagination-size` as _"If pagination-size = -1, results are returned in one page"_. The API
rejects `-1` on all three:

```
HTTP 400: [-1] is not a valid pagination-size header value.
```

while the same call with an explicit size answers `200`. This server therefore does not offer
`-1`, and refuses it at the schema rather than letting it become a 400 nobody expected. If a
future API version honours it, that is the moment to put it back — not before.

The other constraint is what comes back. A full inventory is easily hundreds of kilobytes, and
[`EURODNS_CHARACTER_LIMIT`](configuration.md) caps what one result may return — 25 000
characters by default, which a large portfolio will exceed. Past that cap the server drops
the indentation first and truncates only if that is still not enough, always with a notice
saying how much was omitted. So a large `size` is right for a caller that raised the limit to
match, and wrong for one that did not: it will get the same truncation, having paid for the
whole page upstream. Prefer a filtered query to a wide one.

## Prompts, and what the server says it allows

Two MCP primitives sit beside the tools. Neither costs anything until it is used.

**Prompts** are workflows a person asks for by name — in most clients, a slash command. Each is
several tool calls in a fixed order with a judgement at the end, which is the shape that is
tedious to re-derive and easy to get subtly wrong.

| Prompt                   | Arguments               | What it does                                                                                                              |
| ------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `eurodns_zone_review`    | `domainName`            | Reads a zone and reports missing mail authentication, dangling CNAMEs, nameserver drift and TTL extremes. Writes nothing. |
| `eurodns_expiry_review`  | `withinDays` (opt., 90) | Everything expiring in the window, with its renewal method, and separately the entries that will not renew themselves.    |
| `eurodns_acme_challenge` | `domainName`, `token`   | Diff first, then publish the `_acme-challenge` TXT at TTL 600, then read it back.                                         |
| `eurodns_change_review`  | `since`                 | Reads the audit log, groups by actor, and puts refusals and a broken hash chain first.                                    |

The last two are **conditional**, on the same tests that decide whether the tools they drive
exist: `eurodns_acme_challenge` is absent under `EURODNS_READ_ONLY`, and `eurodns_change_review`
is absent unless the audit log is a file that can be queried. A prompt telling a model to call a
tool that is not there is worse than no prompt.

A name typed into `domainName` — in a prompt or in the resource template below — **completes
from the account's own domains**. MCP completes prompt arguments and resource-template
variables, never tool arguments, so those two are its whole reach. The list is cached for
[`EURODNS_PORTFOLIO_TTL_MS`](configuration.md) (ten minutes by default) and concurrent
lookups share one upstream call, because completion is typed into and a full portfolio search
per keystroke would cost more than the feature is worth. `eurodns_portfolio_refresh` re-reads
it on demand, for the one moment the TTL is wrong: just after registering a domain.

**Two resources.** `eurodns://domain/{domainName}` is the portfolio, addressable and
browsable: it lists every domain as something a client can open, and reading one returns its
registry record. `eurodns://deployment` answers the question a hidden tool cannot: _why is it
not here?_ It returns the guardrails in force, the risk classes hidden from the tool list with
the variable that would restore each, whether the process holds credentials at all
(`credentials.configured`, a boolean), the character limit and timeout, the authentication mode,
and whether history can be queried. It carries no credential and no address — not the
application id, the API key, the token, or the upstream URL — and a test asserts that absence
rather than the shape, so a field added later cannot quietly leak one.

## The DNS workflow tools

`PUT /dns-zones/{domain}` replaces the **entire** zone document: a caller that sends a
partial zone silently deletes everything it left out. Three tools exist so that never
happens by accident.

| Tool                        | What it does                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `eurodns_dns_diff_zone`     | Reports what a proposed record set would change. Writes nothing.                                             |
| `eurodns_dns_upsert_record` | Reads the zone, applies one change, validates it with the API, and saves only if validation passes.          |
| `eurodns_dns_delete_record` | Resolves a record's id from its type and host, then deletes it. Refuses to guess when several records match. |

The raw generated tools (`eurodns_dns_save_zone`, `eurodns_dns_add_records`) remain available
for callers that know exactly what they are doing, and `eurodns_dns_delete_record` takes a
raw `recordId` in place of the type-and-host lookup for a caller that has just read the zone.

Three details worth knowing, all of which this server enforces for you:

- The record value field is **`rdata`**, not `data`. Sending `data` fails with an opaque
  "unexpected technical error".
- TTL accepts only twelve values: 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400,
  172800, 432000, 604800.
- `MAIL` and `URL` are **not** record types. They are pseudo types for the zone's mail and
  URL forwards, which carry different fields. The record tools refuse them and say so.

---

[← Documentation](README.md) · [Tools](tools.md) · [Guardrails](guardrails.md) · [HTTP transport](http-transport.md) · [Audit log](audit-log.md) · [Secrets](secrets.md) · [Configuration](configuration.md) · [Protocol](protocol.md) · [Entra ID](entra-id.md) · [Development](development.md)
