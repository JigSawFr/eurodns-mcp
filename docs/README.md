# Documentation

Everything the [main README](../README.md) links out to, in the order you are likely to need
it.

## Using it

| Page                              | What it covers                                                             |
| --------------------------------- | -------------------------------------------------------------------------- |
| [Tools](tools.md)                 | The 82 tools, how they are named, and the three DNS workflow tools         |
| [Guardrails](guardrails.md)       | Risk classes, what a deployment can forbid, and confirmation before a call |
| [Configuration](configuration.md) | Every environment variable, with its default                               |

## Running it

| Page                                | What it covers                                                      |
| ----------------------------------- | ------------------------------------------------------------------- |
| [HTTP transport](http-transport.md) | Serving several clients, static tokens, OAuth 2.1 and scopes        |
| [Secrets](secrets.md)               | Keeping the API key out of a client config, and 1Password Connect   |
| [Audit log](audit-log.md)           | What is recorded, the hash chain, asking the server what happened   |
| [Deploying](../deploy/README.md)    | Containers, Fly.io, Render, Railway, and shipping the log to a SIEM |

## Working on it

| Page                          | What it covers                                                          |
| ----------------------------- | ----------------------------------------------------------------------- |
| [Protocol](protocol.md)       | Which MCP revisions are spoken, and how both are served at one endpoint |
| [Development](development.md) | Building, testing, the generated tool surface, and how releases work    |

---

[← Back to the project README](../README.md)
