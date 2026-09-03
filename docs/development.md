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
decorative — what CI enforces and why, and the one rule that will bite you first.
[AGENTS.md](../AGENTS.md) states the same rules for a coding agent, and adds the map of the
tree. Everyone taking part is expected to follow the
[code of conduct](../CODE_OF_CONDUCT.md).

### Releasing

Releases are cut by [release-please](https://github.com/googleapis/release-please) from
[Conventional Commit](https://www.conventionalcommits.org) subjects. It keeps a release pull
request open, accumulating `CHANGELOG.md`; merging it tags the version, publishes a GitHub
Release, and then **calls** the image and npm workflows.

Calls them, rather than letting them listen for `release: published`. That trigger is the
obvious choice and cannot work: release-please creates the Release with the default
`GITHUB_TOKEN`, and GitHub starts no workflow run from an event that token raised. The v0.2.0
release shipped with no image for exactly that reason.

The npm publish authenticates over OIDC — there is no `NPM_TOKEN` anywhere — and npm attaches
a provenance attestation on its own, which is why the job needs `id-token: write` and nothing
else. Provenance requires this repository to stay public.

The MCP registry publish runs **after** npm rather than beside it: its entry names an npm
package version, so announcing one npm has not accepted would point every client at something
they cannot install. It authenticates the same tokenless way, reads `server.json` as committed,
and pins the publisher CLI by version with its checksum verified — the upstream instructions
fetch `releases/latest`, which does not belong in a repository that pins every action by commit.

**The trusted publisher on npmjs.com must name `release-please.yml`.** npm validates the
workflow that entered the run, and `release-npm.yml` is reached through `workflow_call`, so the
OIDC claim npm checks carries the caller's name. Registering `release-npm.yml` instead fails
with `E404 Not Found` on the PUT — npm masks the authorization failure as a missing package,
which reads like the package was never published. It cost one release to learn. `server.json` carries the version
twice for the MCP registry, and release-please keeps both in step through `extra-files`;
`tests/manifest.test.ts` fails if they ever drift, because the registry's own answer when they
disagree is "validation failed" without naming the field.

Only the **subject line** follows the convention — commit bodies stay prose. `feat:` bumps
the minor, `fix:` the patch, and a `!` or `BREAKING CHANGE:` bumps the minor too while the
project is pre-1.0.

Squash merges are the most predictable setup, since the pull request title then becomes the
commit subject — which is why CI checks that title. The failure mode this guards against is
quiet: a non-conforming subject contributes nothing and no release appears.

The version stays in `0.x` until the server has been exercised against the real EuroDNS API.

---

[← Documentation](README.md) · [Tools](tools.md) · [Guardrails](guardrails.md) · [HTTP transport](http-transport.md) · [Audit log](audit-log.md) · [Secrets](secrets.md) · [Configuration](configuration.md) · [Protocol](protocol.md) · [Entra ID](entra-id.md) · [Development](development.md)
