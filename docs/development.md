# Development

```bash
npm install
npm run gen      # regenerate src/generated from spec/openapi.json
npm run build
npm test
npx @modelcontextprotocol/inspector node dist/index.js
```

The tool surface is generated from `spec/openapi.json`; CI regenerates it and fails if the
committed output has drifted. Edit the generator or the curated names and descriptions in
`src/tools/`, never `src/generated/`.

Tests run against a real MCP client over an in-memory transport, with the HTTP layer driven
through the real Express app. No test touches the network.

[CONTRIBUTING.md](../CONTRIBUTING.md) covers the conventions that are load bearing rather than
decorative — what CI enforces and why, and the one rule that will bite you first. Everyone
taking part is expected to follow the [code of conduct](../CODE_OF_CONDUCT.md).

### Releasing

Releases are cut by [release-please](https://github.com/googleapis/release-please) from
[Conventional Commit](https://www.conventionalcommits.org) subjects. It keeps a release pull
request open, accumulating `CHANGELOG.md`; merging it tags the version, publishes a GitHub
Release, and that Release triggers the image build.

Only the **subject line** follows the convention — commit bodies stay prose. `feat:` bumps
the minor, `fix:` the patch, and a `!` or `BREAKING CHANGE:` bumps the minor too while the
project is pre-1.0.

Squash merges are the most predictable setup, since the pull request title then becomes the
commit subject — which is why CI checks that title. The failure mode this guards against is
quiet: a non-conforming subject contributes nothing and no release appears.

The version stays in `0.x` until the server has been exercised against the real EuroDNS API.

---

[← Documentation](README.md) · [Tools](tools.md) · [Guardrails](guardrails.md) · [HTTP transport](http-transport.md) · [Audit log](audit-log.md) · [Secrets](secrets.md) · [Configuration](configuration.md) · [Protocol](protocol.md) · [Development](development.md)
