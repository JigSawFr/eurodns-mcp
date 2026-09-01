# Deploying

The container serves the **HTTP transport**. For a local client that spawns the process
itself, use stdio instead — see the main README; none of this applies.

## Before anything else: the source IP

The EuroDNS API filters by source IP. **Whatever you deploy to, its public egress IP has to
be allowlisted in the EuroDNS dashboard before a single call will work.** A container that
starts cleanly and then fails every upstream call with `403` is almost always this.

That constraint is what makes the hosting choice unusual: it is not about latency or
developer experience, it is about which platforms give you a **dedicated** outbound IP at a
sane price. Allowlisting an IP shared with other customers keeps the mechanism but removes
the protection.

| Platform   | Dedicated egress IP                     | Cost                     | Persistent disk |
| ---------- | --------------------------------------- | ------------------------ | --------------- |
| **Fly.io** | yes, `allocate-egress`                  | $3.60 / month            | yes (volumes)   |
| Railway    | not guaranteed — may be shared          | included on Pro          | yes             |
| Render     | yes, 3 exclusive IPv4                   | $100 / month per set     | yes             |
| Vercel     | shared pool; dedicated needs Enterprise | $100 / month per project | **no**          |

Vercel is left out on purpose. Without a persistent filesystem the audit log cannot be a
file, so `EURODNS_AUDIT_QUERY` cannot be enabled and the history tool does not register.

## The one setting every deployment needs

Inside a container the server listens on `0.0.0.0`, and it **refuses to start on a
non-loopback address without authentication**. Set `EURODNS_MCP_AUTH` to `token` or `oauth`.
Starting without it exits `78` with a message naming the variable — by design, but easier to
read here than in a crash loop.

## Docker Compose

```bash
cp .env.example .env    # fill in EURODNS_APP_ID, EURODNS_API_KEY, EURODNS_MCP_TOKEN
docker compose up -d
curl localhost:3000/healthz
```

The compose file publishes on `127.0.0.1` only. Put a reverse proxy in front of it before
exposing it, or switch to a platform below.

A **named volume** carries the audit log and inherits the right ownership from the image. A
**bind mount** does not: `chown 1000:1000` the host directory first, or the first
state-changing call fails to write its log line.

The compose file runs the container with a **read-only root filesystem, no capabilities and
`no-new-privileges`**. The process writes only to `/data`, binds its port as an
unprivileged user and never elevates, so none of that is a constraint in practice — it just
removes the options an attacker would otherwise have after a compromise. On a platform that
does not expose these settings, the image is still non-root; you lose the sealed filesystem,
not the user separation.

The audit log is created mode `0600` and rotates to `audit.jsonl.1` at
`EURODNS_AUDIT_MAX_BYTES` (64 MB by default), keeping two generations. Sizing a volume means
budgeting for twice that. The history query reads across both, so rotation does not create a
gap in what the server can answer — but everything before the older generation is gone. If
that history has to be kept, ship the lines to a collector as well.

## Fly.io

```bash
fly launch --no-deploy -c deploy/fly.toml   # or move the file to the root and drop -c

# The volume is optional: `initial_size` in the config creates it on the first deploy, under
# the name `data`. Create it by hand only to choose a different size — `fly volumes create`
# ignores `initial_size`, so an existing volume always wins.
fly volumes create data --size 1

# The whole point: a static *outbound* address to allowlist at EuroDNS. See below — this is
# not the same command as the one that gives the app an inbound address.
fly ips allocate-egress -r ams
fly ips list                       # the egress IPv4 is the one EuroDNS needs

fly secrets set EURODNS_APP_ID=… EURODNS_API_KEY=… \
                EURODNS_MCP_AUTH=token EURODNS_MCP_TOKEN="$(openssl rand -hex 32)"
fly deploy
```

### Inbound and outbound are different addresses

`fly ips allocate-v4` gives the **app** an address the world connects _to_. It has no effect
whatsoever on the address the app connects _from_, which is the one EuroDNS filters on. Only
`fly ips allocate-egress` sets that. Getting this wrong costs a couple of dollars a month and
leaves every upstream call failing exactly as before.

An egress address is app-scoped and survives deploys and machine replacement, at $3.60/month
for the IPv4 (IPv6 comes with it). Four things about it:

- **It is per region.** A Machine can only use an egress address allocated in _its own_
  region, so a second region needs a second address. Keep `primary_region` and the allocation
  in step.
- **Existing Machines pick it up after a delay.** Restart after allocating, or the running
  Machine keeps its old route and you will conclude, wrongly, that the allocation failed.
- **Verify from inside**, because that is the only measurement that counts. The image ships
  no `curl`, but Node has `fetch`:

  ```bash
  fly ssh console -a <app>
  node -e "fetch('https://api.ipify.org').then(r=>r.text()).then(console.log)"
  ```

- One address covers 64 Machines and 1024 concurrent connections per destination IP. Neither
  binds a single-machine deployment.

### A custom domain

Needed if you want OAuth against Entra ID, which requires the server to answer on a hostname
you can verify in your tenant — see [Entra ID](../docs/entra-id.md). Otherwise optional.

```bash
fly certs add mcp.example.com -a <app>
fly certs show mcp.example.com -a <app>   # prints the DNS records to create
```

Point the name at the app with a **CNAME** to `<app>.fly.dev` rather than `A`/`AAAA` records.
It follows any address change Fly makes, and it avoids this trap: releasing the shared IPv4
while an `A` record still points at it leaves the name resolving to an address that no longer
serves your app. The symptom is a TLS handshake cut off mid-negotiation, which reads exactly
like a missing certificate and sends you looking in the wrong place for an hour. If the
certificate is issued and the name still fails, resolve it and compare against `<app>.fly.dev`
before suspecting anything else.

### Two log lines that are not failures

`App … has excess capacity, autostopping machine` is level **info**, not an error. It is
`auto_stop_machines` doing what the config asks; the next request starts the Machine again, at
the cost of a second or two. `min_machines_running = 1` removes the cold start and keeps the
Machine billed around the clock.

It also explains a graph that looks alarming: repeated stop/start cycles create a new series
each time, so their sum makes **`mem_total`** climb in steps. A memory leak would raise
`mem_used`, which stays flat. Read which series is moving before believing the shape.

`[PU01] client problem: no host specified in headers or uri` comes from Fly's proxy with
`instance: null` — the request never reached the app. It is a connection with no `Host` header
or SNI, which on a public IPv4 is constant background noise from scanners.

### The Fly.io GitHub integration will rewrite this config

Connecting the repository makes Fly open a pull request titled _New files from Fly.io Launch_
that regenerates `deploy/fly.toml`. It deletes every comment in the file, and it has already
dropped `initial_size` once. Treat it as a proposal to read, not a patch to merge: take the
keys it adds, keep the prose. Its non-conventional title fails the `pr-title` check, which is
the signal to look rather than to override.

**This deployment is single-instance.** A Fly volume attaches to one machine, and the audit
log is a file on it. Scaling out means shipping the log to a collector instead — which also
means giving up the history query tool, since it can only read a file.

## Render

Point a Blueprint at `deploy/render.yaml`, then set `EURODNS_APP_ID`, `EURODNS_API_KEY` and
`EURODNS_MCP_TOKEN` in the dashboard — they are declared `sync: false` so they never live in
the repository.

For the source IP, create a **dedicated IP set** on a Pro workspace and scope it to this
service. The shared regional ranges are not a real option here.

## Railway

No configuration file: Railway builds the `Dockerfile` as-is. Set the variables in the
dashboard, add a volume mounted at `/data`, and enable a **static outbound IP** on the Pro
plan.

One caveat worth weighing: Railway's own documentation does not guarantee the assigned IPv4
is dedicated to you. For an allowlist-based control, that is the guarantee that matters.

## Shipping the audit log to a SIEM

The log is JSON lines, one object per event, already in the shape an ingestion pipeline
wants. There is no formatting to do — only a transport to pick.

| Approach                                                            | Configuration                      | When it is the right one                                                |
| ------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| The platform's log drain                                            | `EURODNS_AUDIT_DESTINATION=stdout` | Fly, Render and Railway all forward raw stdout to an external collector |
| A file, tailed by a collector (Vector, Fluent Bit, Filebeat, Alloy) | `EURODNS_AUDIT_DESTINATION=file`   | Kubernetes, a VM, anywhere a sidecar is possible                        |
| The server posts to the collector itself                            | `EURODNS_AUDIT_FORWARD_URL`        | No log drain to hand, or the history tool has to keep working           |

Try the first two before the third: they cost no configuration in this server at all, and
`stdout` exists precisely because it is the channel every container platform knows how to
relay. Under stdio it is refused, because there stdout carries the JSON-RPC stream — use a
file.

### When the server ships the lines itself

The reason to reach for this is narrow but real: **`EURODNS_AUDIT_QUERY` requires the `file`
destination**, because the history tool can only read a file. So `stdout` plus a log drain
means giving up `eurodns_audit_query`. Forwarding is additive rather than a destination of
its own, so the file and the collector both get every line and nothing is given up.

```bash
EURODNS_AUDIT_DESTINATION=file
EURODNS_AUDIT_FILE=/data/audit.jsonl
EURODNS_AUDIT_QUERY=all

EURODNS_AUDIT_FORWARD_URL=https://collector.example/ingest
EURODNS_AUDIT_FORWARD_TOKEN=…        # optional; sent as `Authorization: Bearer …`
```

The request body is `application/x-ndjson`: the lines **exactly as written locally**, one per
line, with their `seq` and `prev` intact — so the collector can re-verify the same hash chain
rather than having to trust what it was sent.

| Variable                            | Default | What it does                                                                 |
| ----------------------------------- | ------- | ---------------------------------------------------------------------------- |
| `EURODNS_AUDIT_FORWARD_URL`         | —       | Where to post. Must be `https`, except on a loopback address                 |
| `EURODNS_AUDIT_FORWARD_TOKEN`       | —       | Bearer credential. May be an `op://` reference like any `EURODNS_*` variable |
| `EURODNS_AUDIT_FORWARD_BATCH`       | 100     | Lines per request; a full batch is sent without waiting                      |
| `EURODNS_AUDIT_FORWARD_INTERVAL_MS` | 5000    | How long a partial batch waits                                               |
| `EURODNS_AUDIT_FORWARD_QUEUE`       | 10000   | Lines held while the collector is unreachable                                |

Queuing never blocks a tool call and never fails one. When the queue fills, the **oldest**
lines are dropped — acceptable only because the local destination still holds them. Both
outcomes are counted, and a collector that has quietly stopped receiving is otherwise
indistinguishable from one with nothing to report:

```
eurodns_mcp_audit_forward_failures_total   # lines a collector never accepted, after retries
eurodns_mcp_audit_forward_dropped_total    # lines dropped from a full queue
```

Alert on either being non-zero.

On `SIGTERM` and `SIGINT` the server stops listening, drains whatever the forwarder still
holds under a five-second deadline, then exits. This matters on a platform that stops idle
machines: without it the tail of the log would be lost on every stop.

**Do not poll the server for this.** `eurodns_audit_query` answers a question in
conversation; it is not an ingestion API, and it reads only a bounded window from the end of
the log.

Fields worth mapping in a SIEM:

| Field                          | Meaning                                                           |
| ------------------------------ | ----------------------------------------------------------------- |
| `ts`                           | ISO 8601, UTC                                                     |
| `actor.mode` / `actor.subject` | How the caller was identified, and who they are                   |
| `tool`, `risk`                 | What was called, and what class of operation it is                |
| `target`                       | Domain or subscription the call acted on                          |
| `verdict`                      | `allowed`, `denied` (a guardrail or scope refused it) or `failed` |
| `upstreamStatus`               | HTTP status from the EuroDNS API                                  |
| `correlationId`                | Pairs the `started` and `completed` lines of one call             |
| `seq`, `prev`                  | Position in the hash chain, and the hash of the previous line     |

`verdict: denied` is the row worth alerting on: it means something asked for an operation the
deployment forbids, or one a caller was asked to confirm and did not.

### What the hash chain does and does not prove

Every line carries the SHA-256 of the line before it. Editing or deleting a line in the
middle of the log breaks the chain at the next line, and `eurodns_audit_query` reports it —
`chain.intact` false, with `chain.brokenAt` naming the sequence number.

It does **not** detect the log being cut short at the end: a shorter valid chain is still a
valid chain. Nor does it stop anyone from rewriting the whole log from scratch if they hold
the file. Both are why shipping lines off the host as they are written complements the chain
rather than replacing it — once a copy is in the SIEM, the two can be compared.

On a stream destination the chain restarts at each process start, marked by `prev: null`,
because the process cannot see what a previous run wrote. A verifier reads that as a restart,
not as tampering. With a file it resumes from the last line, so restarts leave no gap.

## Supervision

Setting `EURODNS_METRICS_TOKEN` — 32 characters or more — adds `GET /metrics` in the
Prometheus text format, requiring that token as a bearer. Leaving it unset means the endpoint
does not exist at all.

It is a **separate secret from the MCP token on purpose**: the poller is a monitoring system,
and it should not hold a credential that can also change DNS. Under OAuth the MCP credential
is a short-lived JWT no monitoring system could carry anyway.

```
eurodns_mcp_build_info{version="…"}                              1
eurodns_mcp_start_time_seconds                                   …
eurodns_mcp_tools_registered                                     …
eurodns_mcp_tool_calls_total{tool,risk,verdict}                  …
eurodns_mcp_upstream_responses_total{status}                     …
eurodns_mcp_tool_duration_seconds_{sum,count}{risk}              …
eurodns_mcp_audit_log_bytes                                      …
```

No label carries a domain, a subscription id or an actor identity. Those belong in the audit
log, which is access-controlled; a metrics endpoint is polled by machines that have no
business learning which domains a deployment manages.

**Zabbix, Centreon, Checkmk and PRTG** all consume HTTP natively. In Zabbix, an HTTP agent
master item on `/metrics` with dependent items using Prometheus preprocessing needs no
gateway at all.

**If the monitoring system only speaks SNMP**, bridge on the host rather than in the
application — an `extend` directive in `snmpd.conf` pointing at a script that reads
`/metrics`:

```
extend eurodns-mcp /usr/local/bin/eurodns-mcp-metric
```

An SNMP agent inside the server would be the wrong place for three reasons: UDP 161 is below
1024 and needs `CAP_NET_BIND_SERVICE`, exactly the capability the container drops; SNMPv2c
community strings travel in clear and SNMPv3 adds a third secret store; and exposing
application metrics properly means publishing and maintaining a MIB.

## Rate limiting

`/mcp` is limited to `EURODNS_RATE_LIMIT` requests per `EURODNS_RATE_LIMIT_WINDOW_MS`
(300 per minute by default), and a caller past the limit gets a JSON-RPC error rather than a
bare HTML `429`. `/healthz` and `/metrics` are **not** limited: both are polled continuously
by machines doing their job.

Two things decide whether it works as intended.

**Set `EURODNS_TRUST_PROXY` if anything sits in front of the server.** Behind a reverse
proxy `req.ip` is the proxy's address, so the limiter becomes one shared counter for every
caller — worse than no limiter, because it looks like protection while throttling everyone
together. Set it to the number of proxies you actually control, never higher: trusting a hop
you do not own lets a caller forge the address the limit is keyed on.

**The store is in memory, so the count is per process.** That matches the rest of this
deployment — the audit log is a file on one volume — but scaling out multiplies the effective
limit by the number of instances rather than sharing it.

## Confirmation before irreversible and billable calls

`EURODNS_CONFIRM` (`off`, `destructive`, `all`) makes a matching operation ask the caller to
confirm, naming the operation and its target, before it runs. It is off by default: it changes
what a tool call does, and a deployment that never asked for it should not start refusing
calls after an upgrade.

**It is a guard against accidents, not an authorisation check.** The answer is asserted by the
client software and is never proven to have come from a person — a buggy or hostile client can
answer yes on its own. That is why `EURODNS_ALLOW_DESTRUCTIVE` and `EURODNS_ALLOW_BILLING`
still run first and still decide what is possible at all. Confirmation narrows what happens by
mistake; it does not widen what is permitted.

One deployment shape cannot use it. A **2025-era client on the HTTP transport** has no session
for the exchange to travel over — serving there is per-request and stateless by construction —
so those calls are refused rather than run unconfirmed. A client speaking the 2026-07-28
revision carries the exchange in the request itself and works; so does stdio, which has a real
session. If your clients are older and you cannot confirm, leave the variable unset rather than
leaving calls failing.

A declined confirmation is recorded in the audit log as `verdict: denied`, which is the row
worth alerting on. The round that merely asks writes nothing — it is not an attempt.

## Verifying a deployment

```bash
# The friendliest check: a browser-readable page saying what this address is.
curl https://your-host/

curl https://your-host/healthz

curl -X POST https://your-host/mcp \
  -H "Authorization: Bearer $EURODNS_MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

A `403` from an EuroDNS call, rather than from the server itself, means the egress IP is not
allowlisted yet.
