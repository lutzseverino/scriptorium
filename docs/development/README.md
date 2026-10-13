# Factory development

This directory explains how to develop and release the factory package.

## Setup and validation

Follow the repository's [shared setup](../../../docs/development/README.md)
and [contribution guidelines](../../../CONTRIBUTING.md). From `factory/`, run
`npm ci --include=dev`, `npm run typecheck`, and `npm test`. CI runs both package
checks on Node.js 24 beside the repository checks.

The package runs TypeScript through Node.js type stripping and emits no build
output. The typecheck uses strict TypeScript, Node module resolution, explicit
`.ts` imports, and erasable syntax only. Source modules belong in `src/` and
tests in `test/`.

The sandbox image contract tests build and run the factory layer on
`debian:bookworm-slim` without Node and on `node:24-bookworm` with its existing
UID and GID 1000. They run in the existing factory CI job, where Docker is
required; local runs skip them when Docker is unavailable. Run them alone
with `node --test test/sandbox-image-build.test.ts`. Run the tag tests with
`node --test test/sandbox-image.test.ts`. Image builds download the pinned
release binaries and need network access. Increment `AGENT_LAYER_VERSION`
for every edit to `src/agent-layer.Dockerfile`, including tool pins.

The host runner's tests in `test/host.test.ts` drive whole passes with a
stateful GitHub CLI fake, a fake Sandcastle behind the real provider registry,
and real Git clones of local bare remotes, so they need Git. The decision core's
tests in `test/factory.test.ts` drive it with snapshots, and the host
configuration's tests read the fixture files in
`test/fixtures/host-configuration/`. The token test that runs the GitHub CLI
against the sandbox's token file skips when `gh` is not installed.

Sandcastle is pinned at 0.12.0. Its public types reference
`@standard-schema/spec` without declaring that dependency, as tracked in
[Sandcastle #864](https://github.com/mattpocock/sandcastle/issues/864).
The package pins it as a development dependency so `tsc --noEmit` checks the
dependency types as well as our own. Revisit that pin when upgrading Sandcastle.

## Documents

- [Release procedure](release.md): independent versioning, owner-only tag setup,
  the release pull request, and publication and verification.
