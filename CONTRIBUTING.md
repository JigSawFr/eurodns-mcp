# Contributing

Thanks for taking the time. This is a small project with a few conventions that are load
bearing rather than decorative — this page is the short version of why each one exists.

## Getting set up

```bash
npm ci
npm run typecheck && npm run lint && npm run format:check && npm run coverage
```

Node 22 or newer; `.nvmrc` names 24, which is what the container runs.

## The one rule that will bite you

**Never edit `src/generated/` by hand.** Those files are written by `npm run gen` from
`spec/openapi.json`, and CI fails the build if regenerating produces a diff. If a tool needs
to change, change the generator in `scripts/gen-operations.ts` or the curated overrides in
`src/tools/overrides.ts` and `src/tools/naming.ts`, then regenerate.

The vendored OpenAPI document is refreshed deliberately, not casually: a weekly job compares
it against the published one and opens an issue when they diverge. Taking a vendor change
means regenerating and reading the `src/generated/` diff, because a renamed operation is a
renamed tool and that is a breaking change for anyone's prompts.

## Commit messages and pull request titles

Releases are cut by [release-please](https://github.com/googleapis/release-please), which
reads [Conventional Commits](https://www.conventionalcommits.org/). The failure mode is
silent: a non-conforming subject contributes nothing to the changelog and nobody notices.

Only the subject line is constrained. Bodies are prose — and worth writing: explain why, not
what, since the diff already says what.

```
fix(audit): restrict the log to its owner and bound its growth
feat!: raise the runtime floor to Node 22
docs: document shipping the audit log to a SIEM
```

A `!` or a `BREAKING CHANGE:` footer marks a breaking change. While the project is `0.x`
that produces a minor bump, not a major one.

**The pull request title is checked in CI**, because with a squash merge it becomes the
commit subject — which is the only thing release-please reads.

## What CI enforces

| Check                           | Why it is there                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `npm run gen` produces no diff  | the generated surface must match the document it came from                           |
| `typecheck` over both tsconfigs | the build config excludes tests, so they need the second one or they escape checking |
| `lint` with type information    | catches unawaited promises, which is the failure mode that does not announce itself  |
| `format:check`                  | Prettier, no discussion                                                              |
| `coverage` with floors          | measured, not aspirational; a floor exists to catch a real drop                      |
| the `docker` job                | the only place the container is exercised at all                                     |

That last one is worth knowing about: it builds the image, starts it read-only with no
capabilities, and asserts the things a unit test cannot — that the server refuses to listen
on a public address without authentication, that the audit hash chain survives across
requests, that the log is mode `600`, and that both protocol eras answer on one endpoint.

## Testing

Tests inject their dependencies rather than intercepting the network: `stubFetch` in
`tests/harness.ts` records exactly what the client sent, headers included. Prefer that to a
mock of the whole HTTP layer — several real bugs in this repository were found by asserting
on the outgoing request.

Where behaviour only appears in a running process, run one. The audit hash chain restarting
on every HTTP request passed every unit test; it was found by starting the server and
looking at its output.

## Security

Please do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md) — it
routes to a private advisory.
