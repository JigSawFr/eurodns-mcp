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
| **Fly.io** | yes                                     | ~$2–4 / month            | yes (volumes)   |
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

## Fly.io

```bash
cp deploy/fly.toml fly.toml     # Fly builds from the working directory; see the file header
fly launch --no-deploy
fly volumes create eurodns_audit --size 1 --region cdg

# The whole point: a dedicated outbound IP to allowlist at EuroDNS.
fly ips allocate-v4 --shared=false
fly ips list                       # allowlist the address it prints

fly secrets set EURODNS_APP_ID=… EURODNS_API_KEY=… \
                EURODNS_MCP_AUTH=token EURODNS_MCP_TOKEN="$(openssl rand -hex 32)"
fly deploy
```

`min_machines_running = 0` lets the machine stop when idle and start on the next request.
Drop it to keep the server warm.

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

## Verifying a deployment

```bash
curl https://your-host/healthz

curl -X POST https://your-host/mcp \
  -H "Authorization: Bearer $EURODNS_MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

A `403` from an EuroDNS call, rather than from the server itself, means the egress IP is not
allowlisted yet.
