# Audit log

One JSON line per tool call, on stderr by default:

```json
{
  "ts": "2026-01-01T10:00:00.000Z",
  "correlationId": "…",
  "actor": { "mode": "oauth", "subject": "alice@example.com" },
  "tool": "eurodns_dns_upsert_record",
  "risk": "write",
  "target": "example.com",
  "verdict": "allowed",
  "upstreamStatus": 204,
  "durationMs": 412
}
```

The upstream API sees a single shared key for every caller, so this log is the only place an
action can be traced to a person.

- **Refusals are logged too**, with their reason — usually the most interesting line.
- State-changing calls write a `started` line **before** the upstream request, so a crash
  mid-write still leaves a trace of what was attempted.
- Arguments are reduced to scalars and long strings become a length marker. Request bodies
  and record values are never written: a TXT value is often a short-lived secret.

Set `EURODNS_AUDIT_DESTINATION` to `stderr` (default), `stdout`, `file` (with
`EURODNS_AUDIT_FILE`) or `none`. `stdout` is refused under stdio, where it carries the
JSON-RPC stream.

### Tamper-evidence

Every line carries `seq`, its ordinal, and `prev`, the SHA-256 of the line before it. Editing
or removing a line in the middle breaks the chain at the next one, and `eurodns_audit_query`
says so — `chain.intact` false, `chain.brokenAt` naming the sequence number — in its result
and in prose, so an agent summarising the history cannot present a tampered log as an
ordinary answer.

What it does not catch is the log being cut short at the end: a shorter valid chain is still
valid. Shipping the lines to a collector as they are written is the answer to that, and the
two measures complement each other rather than overlapping. On a stream the chain restarts at
each process start, marked `prev: null`, since the process cannot see what a previous run
wrote; with a file it resumes where it stopped. See
[deploy/README.md](../deploy/README.md#shipping-the-audit-log-to-a-siem).

### Asking the server what happened

With `EURODNS_AUDIT_QUERY` set, a `eurodns_audit_query` tool answers questions about past
actions — which tool ran, on what, for whom, and whether it was allowed, refused or failed.
Filter by time range, tool, target, verdict or risk class.

| Value           | Effect                                |
| --------------- | ------------------------------------- |
| `off` (default) | No query tool.                        |
| `own`           | A caller sees only their own actions. |
| `all`           | A caller sees every action.           |

Three things are deliberate here. It requires `EURODNS_AUDIT_DESTINATION=file` — stderr and
stdout are write-only, so there would be nothing to read back. If the log also has to leave
the host, `EURODNS_AUDIT_FORWARD_URL` posts each line to a collector **in addition to** the
file, so shipping it costs neither this tool nor the file's hash chain; see
[deploy/README.md](../deploy/README.md#when-the-server-ships-the-lines-itself). It needs its own
**`eurodns.audit`** scope rather than riding on `eurodns.read`, because reading who did what
is not reading DNS data. And in `own` mode an explicit `actor` filter is refused rather than
quietly ignored, so nobody mistakes a filtered result for the whole picture.

Queries read a bounded window from the end of the log. When older entries lie beyond it the
result says so, so you narrow the time range instead of concluding you have seen everything.

---

[← Documentation](README.md) · [Tools](tools.md) · [Guardrails](guardrails.md) · [HTTP transport](http-transport.md) · [Audit log](audit-log.md) · [Secrets](secrets.md) · [Configuration](configuration.md) · [Protocol](protocol.md) · [Entra ID](entra-id.md) · [Development](development.md)
