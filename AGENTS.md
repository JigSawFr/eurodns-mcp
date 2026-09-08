# Working on this repository

A Model Context Protocol server for the EuroDNS User API, in TypeScript on Node. Most of the
tool surface is **generated** from an OpenAPI document, which is the single fact that changes
how you work here.

`CONTRIBUTING.md` covers the human workflow and `docs/development.md` the commands. This file
is the short list of things that are expensive to learn by getting them wrong.

## Commands

```bash
npm install
npm run gen         # regenerate src/generated/ from spec/openapi.json
npm run build       # runs gen, then tsc
npm run typecheck
npm run lint
npm run format:check
npm test
npm run coverage
npm run tdqs        # the registries' deterministic score of the tool surface, no model
```

Run `typecheck`, `lint`, `format:check` and `coverage` before proposing a change. They are what
CI runs, and they are fast enough that there is no reason to find out from CI instead.

## The rules that cost the most when ignored

**`npm run typecheck`, never a bare `tsc --noEmit`.** The script checks `tsconfig.json` _and_
`tsconfig.tests.json`. A bare `tsc --noEmit` covers `src/` only and will happily let you commit
test fixtures that no longer compile.

**Never edit `src/generated/`.** It is emitted by `scripts/gen-operations.ts` from
`spec/openapi.json`. Change the generator, or the curated layer in `src/tools/` — names in
`naming.ts`, tool text in `overrides.ts` and `composites.ts`, argument text in
`parameters.ts` — then run `npm run gen`. CI regenerates the
output and fails if what you committed has drifted.

**A description has a shape, and a test holds it.** What the tool does and returns; when to
use it and when not, naming the neighbour; what it does that the annotations cannot say; and
at least one argument named in the prose. `tests/descriptions.test.ts` says which rule a new
description breaks, and refuses a default-visible tool that cites a tool hidden by default.

**Coverage thresholds in `vitest.config.ts` are pinned to the exact current measurement.** Raise
them when a change raises coverage; never lower one to make a pull request pass. A threshold
that follows the code downwards measures nothing.

**Prove a guard, do not assert it.** A test that still passes when you delete the thing it
covers is worse than no test, because it reads as protection. After writing one, break the code
it guards and confirm that exactly that test goes red. This repository has shipped a vacuous
test before: it exercised a rejected input through a path that errored for an unrelated reason,
so the assertion held with the guard removed.

**Pull request titles follow [Conventional Commits](https://www.conventionalcommits.org).** CI
checks the title, merges are squashes, so the title becomes the commit subject that
release-please reads. `feat:` and `fix:` appear in the changelog; `chore:`, `ci:`, `test:`,
`build:` and `style:` are hidden.

**Keep the project generic.** It is open source and vendor-neutral. No organisation, employer,
customer or internal hostname belongs anywhere in the repository — code, comments, documentation
or commit messages.

**No secrets, ever.** Not in the tree, not in a commit message, not in a test fixture. Tests use
obvious placeholders (`test-app-id`, `test-api-key`). If you need to demonstrate a credential,
demonstrate its shape.

## How the code is arranged

| Path                  | What lives there                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tools/`          | Tool registration: the registry, the pair-folding composites, the curated names and descriptions, the hand-written DNS, portfolio and audit tools |
| `src/generated/`      | Emitted from the OpenAPI document — read it, never edit it                                                                                        |
| `src/auth/`           | Token verification, scopes, and the guardrail evaluation                                                                                          |
| `src/services/`       | The upstream HTTP client and result rendering                                                                                                     |
| `src/instructions.ts` | What the server tells a model about itself in the handshake                                                                                       |
| `scripts/`            | The generator, and `tdqs/` — the deterministic half of the registries' tool-definition score, run by `npm run tdqs` and a workflow                |
| `spec/openapi.json`   | The vendored upstream contract                                                                                                                    |
| `tests/`              | Vitest, driving a real MCP client over an in-memory transport                                                                                     |

Risk classification (`read`, `write`, `destructive`, `billing`) is defined once in
`src/constants.ts` and drives three separate things: the tool annotations, the runtime
guardrails, and the OAuth scopes. Change it there, not at a call site.

## Tests

Tests run a real MCP client against a real server over an in-memory transport, with the HTTP
layer driven through the actual Express app. Nothing touches the network: the upstream client
takes its `fetch` by injection, and `tests/harness.ts` provides a stub that records what was
sent. Assert on the recorded request when the point is what the server sends upstream.

## Comments

Explain _why_, at the density of the surrounding code — this codebase comments the non-obvious
decision and the trap, not the statement. A comment that restates the line below it is noise; a
comment naming the failure a line prevents is why the line survives the next refactor.
