# Secrets

### Keeping the key out of the client config file

A client config such as `claude_desktop_config.json` stores the values in **clear text** in
your user profile. To avoid it, point the client at a wrapper that reads the key from your OS
keychain at launch:

```bash
#!/usr/bin/env bash
# eurodns-mcp-wrapper — chmod +x, then use it as "command" in the client config.
set -euo pipefail

# macOS
export EURODNS_APP_ID="$(security find-generic-password -s eurodns-app-id -w)"
export EURODNS_API_KEY="$(security find-generic-password -s eurodns-api-key -w)"

# Linux (libsecret):
#   export EURODNS_API_KEY="$(secret-tool lookup service eurodns key api)"
# Windows (PowerShell, with the SecretManagement module):
#   $env:EURODNS_API_KEY = Get-Secret -Name eurodns-api-key -AsPlainText

exec npx -y -p github:JigSawFr/eurodns-mcp eurodns-mcp
```

Store the secrets once with, for example,
`security add-generic-password -s eurodns-api-key -a "$USER" -w`.

### Reading secrets from 1Password Connect

If you already run a [1Password Connect](https://developer.1password.com/docs/connect) server,
any `EURODNS_*` variable may hold a secret reference instead of a value:

```bash
export OP_CONNECT_HOST="https://op-connect.internal:8080"
export OP_CONNECT_TOKEN="…"

export EURODNS_APP_ID="op://Infra/EuroDNS API/username"
export EURODNS_API_KEY="op://Infra/EuroDNS API/credential"
```

Both `op://vault/item/field` and `op://vault/item/section/field` work, and a segment that is
already a 1Password id is used as-is. This covers every secret the server reads, including
`EURODNS_MCP_TOKEN` and the OAuth settings.

This adds no dependency: the server calls the Connect REST API directly, and an environment
with no references never contacts 1Password at all. If a reference cannot be resolved the
server refuses to start, naming the reference and the step that failed — a server running
without its credentials would serve nothing and hide the cause.

References are resolved **once, at startup**. A value rotated in 1Password is picked up on
the next restart.

---

[← Documentation](README.md) · [Tools](tools.md) · [Guardrails](guardrails.md) · [HTTP transport](http-transport.md) · [Audit log](audit-log.md) · [Secrets](secrets.md) · [Configuration](configuration.md) · [Protocol](protocol.md) · [Development](development.md)
