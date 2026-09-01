# Changelog

## [0.6.0](https://github.com/JigSawFr/eurodns-mcp/compare/v0.5.0...v0.6.0) (2026-09-01)


### Features

* **http:** serve a page at / describing the server ([#51](https://github.com/JigSawFr/eurodns-mcp/issues/51)) ([bd73e62](https://github.com/JigSawFr/eurodns-mcp/commit/bd73e628e8c9aa4088c52efe327e15c81bc36511))


### Bug fixes

* **deploy:** restore the volume size and the reasoning fly.toml lost ([#48](https://github.com/JigSawFr/eurodns-mcp/issues/48)) ([e545947](https://github.com/JigSawFr/eurodns-mcp/commit/e545947a8eaf06b6c0f3d8e7557073bf7f8ab3b3))


### Documentation

* rewrite the Entra ID and Fly.io guides around what deploying taught ([#50](https://github.com/JigSawFr/eurodns-mcp/issues/50)) ([75df7f3](https://github.com/JigSawFr/eurodns-mcp/commit/75df7f3295c871da86f6aebf6f2aa8edb95a8e05))

## [0.5.0](https://github.com/JigSawFr/eurodns-mcp/compare/v0.4.1...v0.5.0) (2026-08-31)


### Features

* **oauth:** let a deployment advertise qualified scope names ([#45](https://github.com/JigSawFr/eurodns-mcp/issues/45)) ([8536160](https://github.com/JigSawFr/eurodns-mcp/commit/8536160052091ab54d88e4684d0b421ea69cc5cb))

## [0.4.1](https://github.com/JigSawFr/eurodns-mcp/compare/v0.4.0...v0.4.1) (2026-08-27)


### Refactoring

* **dns:** write the upstream failure path once instead of three times ([#43](https://github.com/JigSawFr/eurodns-mcp/issues/43)) ([0445ae9](https://github.com/JigSawFr/eurodns-mcp/commit/0445ae9f3683ff495410accd88d95d42a3567092))

## [0.4.0](https://github.com/JigSawFr/eurodns-mcp/compare/v0.3.1...v0.4.0) (2026-08-27)


### Features

* **audit:** ship the audit log to a collector as it is written ([#38](https://github.com/JigSawFr/eurodns-mcp/issues/38)) ([061e5b6](https://github.com/JigSawFr/eurodns-mcp/commit/061e5b6682f0e3a233cb8cbefb84072fc8010bdd))


### Bug fixes

* **deploy:** match the Fly config to the app that is running ([#36](https://github.com/JigSawFr/eurodns-mcp/issues/36)) ([c0d7516](https://github.com/JigSawFr/eurodns-mcp/commit/c0d7516a7962a8a98888c47789e10f219b57f749))
* repair four defects found while reviewing the Fly config ([#37](https://github.com/JigSawFr/eurodns-mcp/issues/37)) ([bf1373b](https://github.com/JigSawFr/eurodns-mcp/commit/bf1373b2142f40b1ae7b8b31ab38792fb2fe4868))


### Documentation

* drop the vendor logo, document every variable, add an Entra ID guide ([#41](https://github.com/JigSawFr/eurodns-mcp/issues/41)) ([7072de9](https://github.com/JigSawFr/eurodns-mcp/commit/7072de9c05db62be2b0b745523393d66e2e53cc4))
* split the README into docs/ and give it a proper header ([#39](https://github.com/JigSawFr/eurodns-mcp/issues/39)) ([a7d2180](https://github.com/JigSawFr/eurodns-mcp/commit/a7d2180359aaca71c01e41100c8d59b290bb76b0))

## [0.3.1](https://github.com/JigSawFr/eurodns-mcp/compare/v0.3.0...v0.3.1) (2026-08-27)


### Bug fixes

* **deploy:** create the audit volume on first launch ([#33](https://github.com/JigSawFr/eurodns-mcp/issues/33)) ([56a31ec](https://github.com/JigSawFr/eurodns-mcp/commit/56a31ecc9a9c3872c57fe2dcc5a0caa00f368963))

## [0.3.0](https://github.com/JigSawFr/eurodns-mcp/compare/v0.2.1...v0.3.0) (2026-08-27)


### Features

* **guardrails:** confirm before irreversible calls, and hide what is disabled ([#30](https://github.com/JigSawFr/eurodns-mcp/issues/30)) ([aed38a8](https://github.com/JigSawFr/eurodns-mcp/commit/aed38a8bc009e6cd246750c10c40f2fcd9a39e3e))


### Bug fixes

* announce the package version instead of a literal that drifted ([#31](https://github.com/JigSawFr/eurodns-mcp/issues/31)) ([90dc00a](https://github.com/JigSawFr/eurodns-mcp/commit/90dc00aaa7c15ea576b595ec0bcaeb847efbcc7c))

## [0.2.1](https://github.com/JigSawFr/eurodns-mcp/compare/v0.2.0...v0.2.1) (2026-08-27)


### Bug fixes

* **ci:** publish the image by calling the workflow, not by listening for a release ([#26](https://github.com/JigSawFr/eurodns-mcp/issues/26)) ([d7bd0e8](https://github.com/JigSawFr/eurodns-mcp/commit/d7bd0e8ae1d85f308dcbcaedeb1f8224d0d4f39d))
* **ci:** skip the provenance attestation while the repository is private ([#28](https://github.com/JigSawFr/eurodns-mcp/issues/28)) ([9e9dc99](https://github.com/JigSawFr/eurodns-mcp/commit/9e9dc99cde229f09b89fe75b214714ebd7c0a79a))

## [0.2.0](https://github.com/JigSawFr/eurodns-mcp/compare/v0.1.0...v0.2.0) (2026-08-26)


### ⚠ BREAKING CHANGES

* the server now speaks MCP 2026-07-28. 2025-era clients are still served.
* Node 20 is no longer supported. The minimum is now Node 22.

### Features

* add deployment artifacts, semver releases and image publishing ([bc6bc18](https://github.com/JigSawFr/eurodns-mcp/commit/bc6bc189eed67d9a19007bf93645930fcdb4c400))
* **audit:** chain each log line to the one before it ([3ee3066](https://github.com/JigSawFr/eurodns-mcp/commit/3ee30667e13647307354e87024f5a84d47a4cb9b))
* **ci:** cut releases with release-please and publish images to ghcr ([75b8409](https://github.com/JigSawFr/eurodns-mcp/commit/75b840966379ce68a80937c11c6039ee649bdb43))
* **deploy:** add container and platform deployment artifacts ([4bda03b](https://github.com/JigSawFr/eurodns-mcp/commit/4bda03bcb9bcf62d527e1eb7755709efc3dc27de))
* **http:** expose Prometheus metrics behind their own token ([2eaaa0e](https://github.com/JigSawFr/eurodns-mcp/commit/2eaaa0e8f75db1f470b41b5bb3e970ea3c94b7b6))
* **http:** rate limit the MCP endpoint ([97424fc](https://github.com/JigSawFr/eurodns-mcp/commit/97424fc018adee845ddcf2629e49b8cb42f6b3b3))
* make the audit log tamper-evident and shippable, and expose metrics ([8c77785](https://github.com/JigSawFr/eurodns-mcp/commit/8c777857dcf71b5f247e9aa0007e76e1f60e4fef))
* raise the runtime floor to Node 22 and run the image on Node 24 ([ed9d16e](https://github.com/JigSawFr/eurodns-mcp/commit/ed9d16eb0ce8bdff855bb436b5abbb036d5392c4))
* speak the 2026-07-28 protocol revision, and still serve 2025 clients ([598300a](https://github.com/JigSawFr/eurodns-mcp/commit/598300a17a3f59d54849db5dfd8e0f292c8ba18e))


### Bug fixes

* accept zod 4 alongside zod 3 ([1e82e15](https://github.com/JigSawFr/eurodns-mcp/commit/1e82e159a7cee518dddf69db3c9b7056d53d107b))
* **audit:** restrict the log to its owner and bound its growth ([a89acaa](https://github.com/JigSawFr/eurodns-mcp/commit/a89acaa518d9e42b3c71e54299d52f37077b11c4))
* **auth:** fail closed when a request carries no verified identity ([25ea075](https://github.com/JigSawFr/eurodns-mcp/commit/25ea075eb9fd7f73498e8612146ed078d000877f))
* **auth:** state the accepted token signature algorithms ([787a980](https://github.com/JigSawFr/eurodns-mcp/commit/787a98066cdc150c9d8e2576521bdfb7350c9cb0))
* **ci:** give CodeQL the actions:read scope its upload needs ([1ed2bda](https://github.com/JigSawFr/eurodns-mcp/commit/1ed2bda8bd8c3aa55d312a699517787a7be6bb3a))
* **ci:** mask the test token so it stays out of public job logs ([b70ae15](https://github.com/JigSawFr/eurodns-mcp/commit/b70ae1543e4267a816f84483bf0ef100c0d2bd37))
* **ci:** read both response shapes, and assert the modern path ([b50eb2c](https://github.com/JigSawFr/eurodns-mcp/commit/b50eb2c619e98b8e941fbc41ae1c857106b9332a))
* **ci:** run CodeQL only where code scanning can accept its results ([6807bc9](https://github.com/JigSawFr/eurodns-mcp/commit/6807bc96d7284903d381013a5a9e2014d4cf3bf4))
* **ci:** stop the generated changelog from failing the format check ([#25](https://github.com/JigSawFr/eurodns-mcp/issues/25)) ([eeedd9e](https://github.com/JigSawFr/eurodns-mcp/commit/eeedd9ebd5a4b8c81055f12ef76f51048349d921))
* **docs:** stop promising an npm package that does not exist ([faa2d9b](https://github.com/JigSawFr/eurodns-mcp/commit/faa2d9b639a91ae48cdcde11296aa29d4b6f3214))
* harden authentication, the audit log and the build chain ([ab3155c](https://github.com/JigSawFr/eurodns-mcp/commit/ab3155cf55b699b672daefd935e6f455cadf5c01))
* **http:** reduce what an unauthenticated caller can reach ([75ffe8d](https://github.com/JigSawFr/eurodns-mcp/commit/75ffe8d1775e35df406e4b48c6f792b44099d475))


### Documentation

* add the governance a public repository needs ([ad5aa02](https://github.com/JigSawFr/eurodns-mcp/commit/ad5aa0287a8d482c2144605f977841ce808b7777))
* document shipping the audit log and polling the metrics ([e0dfeb2](https://github.com/JigSawFr/eurodns-mcp/commit/e0dfeb2b2f07d0fc626870690294483e299be4a5))
* document the new settings and the container hardening ([dfe24cb](https://github.com/JigSawFr/eurodns-mcp/commit/dfe24cb7eb27799c214ed80707f6041311174b22))
* require squash merges so the changelog lists a change once ([#24](https://github.com/JigSawFr/eurodns-mcp/issues/24)) ([4f63ddc](https://github.com/JigSawFr/eurodns-mcp/commit/4f63ddc57c6adcc3d8508785657c10f5adecb755))
