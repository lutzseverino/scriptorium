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

Sandcastle is pinned at 0.12.0. Its public types reference
`@standard-schema/spec` without declaring that dependency, as tracked in
[Sandcastle #864](https://github.com/mattpocock/sandcastle/issues/864).
The package pins it as a development dependency so `tsc --noEmit` checks the
dependency types as well as our own. Revisit that pin when upgrading Sandcastle.

## Documents

- [Release procedure](release.md): independent versioning, owner-only tag setup,
  the release pull request, and publication and verification.
