# Guardrails

Every operation is classified by what it can cost you. Two gates apply, and both must pass.

**1. Deployment gates** — what this deployment permits at all:

| Variable                    | Default | Effect when unset                                                                                                   |
| --------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `EURODNS_READ_ONLY`         | `false` | —                                                                                                                   |
| `EURODNS_ALLOW_BILLING`     | `false` | The **11** operations that create a charge or extend a paid term are hidden.                                        |
| `EURODNS_ALLOW_DESTRUCTIVE` | `false` | The **8** irreversible operations outside DNS (subscription deletions, SSL revocation and cancellation) are hidden. |

**A disabled class is not advertised at all**, the same way `EURODNS_READ_ONLY=true` hides
every state-changing tool. A surface that lists tools which can only ever answer "this is
disabled" misdescribes the deployment. The default therefore advertises **63** of the 82
tools; the startup line names which classes are hidden and the variable that would reveal
each one.

The switch is still what enforces: hiding decides what is advertised, and a tool reached by
any other path meets the same refusal.

DNS record deletion stays available by default: a zone can be restored from a snapshot,
whereas a revoked certificate or a deleted subscription cannot.

**3. Confirmation** — optional, and off by default:

| Variable          | Values                      | Effect                                          |
| ----------------- | --------------------------- | ----------------------------------------------- |
| `EURODNS_CONFIRM` | `off`, `destructive`, `all` | Ask the caller to confirm before the call runs. |

When set, a matching operation returns a confirmation request naming the operation and its
target instead of running. The SDK serves both protocol revisions from it, so the handler is
written once — but a **2025-era client on the HTTP transport cannot carry the exchange**,
because a stateless instance has no session for it to travel over. Those calls are refused
rather than run unconfirmed, and the refusal says so.

Treat this as a guard against accidents, not as authorisation. The answer is asserted by the
client, never proven to come from a person, which is why the deployment gates above still run
first and still decide what is possible at all.

**2. Scopes** — who, within that cap, may do it. Only in OAuth mode:

| Scope                 | Grants                                                 |
| --------------------- | ------------------------------------------------------ |
| `eurodns.read`        | The 36 read operations                                 |
| `eurodns.dns.write`   | DNS writes (zones, records, profiles)                  |
| `eurodns.destructive` | Deletions outside DNS, SSL revocation and cancellation |
| `eurodns.billing`     | The 11 operations that cost money                      |
| `eurodns.audit`       | Reading the action history                             |

Keeping both gates means enabling OAuth never silently widens what the server can do, and an
operator can shut off a whole class without touching the identity provider.

---

[← Documentation](README.md) · [Tools](tools.md) · [Guardrails](guardrails.md) · [HTTP transport](http-transport.md) · [Audit log](audit-log.md) · [Secrets](secrets.md) · [Configuration](configuration.md) · [Protocol](protocol.md) · [Entra ID](entra-id.md) · [Development](development.md)
