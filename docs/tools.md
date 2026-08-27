# Tools

79 tools are generated from the OpenAPI document, plus three hand-written DNS workflow tools
and, when enabled, the history query.

| Area                 | Tools | Covers                                                      |
| -------------------- | ----: | ----------------------------------------------------------- |
| `dns`                |    16 | Zones, records, zone profiles, snapshots, DNSSEC signing    |
| `ssl`                |    13 | Subscriptions, certificates, validation, reissue, revoke    |
| `email`              |     8 | Mailbox subscriptions, aliases, catch-all, passwords        |
| `premium_dns`        |     8 | Premium DNS subscriptions and their lifecycle               |
| `contact`            |     6 | Reusable contact profiles and their default states          |
| `domain`             |     5 | Domain lookup, search, availability, DNSSEC at the registry |
| `nameserver`         |     5 | Reusable nameserver profiles                                |
| `https_redirect`     |     4 | HTTPS redirect subscriptions                                |
| `tld`                |     2 | TLD terms and requirements                                  |
| `invoice`            |     2 | Invoice lookup and search                                   |
| `invoice_profile`    |     2 | Customer invoice profiles                                   |
| `order`              |     2 | Orders and per-line delivery status                         |
| `subscription`       |     2 | Cross-product search, auto-renewal settings                 |
| `microsoft`          |     2 | Microsoft subscriptions                                     |
| `account`            |     1 | Prepaid balance                                             |
| `contact_validation` |     1 | Resending contact validation email                          |

Every tool name is prefixed with `eurodns_` so it cannot collide with another server's, and
carries `readOnlyHint`, `destructiveHint` and `idempotentHint` annotations derived from what
the operation actually does.

## The DNS workflow tools

`PUT /dns-zones/{domain}` replaces the **entire** zone document: a caller that sends a
partial zone silently deletes everything it left out. Three tools exist so that never
happens by accident.

| Tool                        | What it does                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `eurodns_dns_diff_zone`     | Reports what a proposed record set would change. Writes nothing.                                             |
| `eurodns_dns_upsert_record` | Reads the zone, applies one change, validates it with the API, and saves only if validation passes.          |
| `eurodns_dns_delete_record` | Resolves a record's id from its type and host, then deletes it. Refuses to guess when several records match. |

The raw generated tools (`eurodns_dns_save_zone`, `eurodns_dns_add_records`,
`eurodns_dns_delete_record_by_id`) remain available for callers that know exactly what they
are doing.

Three details worth knowing, all of which this server enforces for you:

- The record value field is **`rdata`**, not `data`. Sending `data` fails with an opaque
  "unexpected technical error".
- TTL accepts only twelve values: 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400,
  172800, 432000, 604800.
- `MAIL` and `URL` are **not** record types. They are pseudo types for the zone's mail and
  URL forwards, which carry different fields. The record tools refuse them and say so.

---

[← Documentation](README.md) · [Tools](tools.md) · [Guardrails](guardrails.md) · [HTTP transport](http-transport.md) · [Audit log](audit-log.md) · [Secrets](secrets.md) · [Configuration](configuration.md) · [Protocol](protocol.md) · [Entra ID](entra-id.md) · [Development](development.md)
