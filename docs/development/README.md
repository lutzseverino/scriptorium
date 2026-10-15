# Factory development

This directory explains how to develop and release the factory package.

## Setup and validation

Follow the repository's [shared setup](../../../docs/development/README.md)
and [contribution guidelines](../../../CONTRIBUTING.md). Install GitHub CLI
and authenticate it with your existing GitHub login before running package
tests: the upstream digest comparison uses authenticated `gh api` requests
for public release metadata. Missing CLI or authentication fails that check;
only an unavailable local network may skip it. From `factory/`, run
`npm ci --include=dev`, `npm run typecheck`, and `npm test`. CI runs both package
checks on Node.js 24 beside the repository checks.

The package runs TypeScript through Node.js type stripping and emits no build
output. The typecheck uses strict TypeScript, Node module resolution, explicit
`.ts` imports, and erasable syntax only. Source modules belong in `src/` and
tests in `test/`.

The sandbox image contract tests build and run the factory layer on
`debian:bookworm-slim` without Node and on `node:24-bookworm` with its existing
UID and GID 1000, and remove sandbox containers by the layer's label. They run
in the existing factory CI job, where Docker is required; local runs skip them
when Docker is unavailable. Run them alone
with `node --test test/sandbox-image-build.test.ts`. Run the tag tests with
`node --test test/sandbox-image.test.ts`. Image builds download the pinned
release binaries and need network access. Increment `AGENT_LAYER_VERSION`
for every edit to `src/agent-layer.Dockerfile`, including tool pins.

The fast `test/agent-layer.test.ts` guard executes the install commands with
spies, without Docker or network access, for both architectures. It rejects
missing or malformed pins and extraction or installation before verification.
`test/agent-layer-upstream.test.ts` compares all ten pins against upstream
metadata using `gh api` and Claude Code's manifest. CI passes its read-only
GitHub token to the factory test step; only local runs may skip when the
network is unavailable. The image suite also alters Git's amd64 digest and
asserts that its checksum fails and no image is tagged.

## Bump an agent-layer tool

Keep the tool's version and its amd64 and arm64 SHA-256 values together in
`src/agent-layer.Dockerfile`. For Git, the GitHub CLI, Codex and
`codex-code-mode-host`, take each tarball's digest from the matching GitHub
release asset's `digest` field. The GitHub CLI release's `checksums.txt` must
agree with both asset digests. Codex and its code-mode host share one version
and have separate digest pairs.

For Claude Code, first check that version's `manifest.json.sig` against
Anthropic's release-signing key at
`https://downloads.claude.ai/keys/claude-code.asc`, verifying fingerprint
`31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE`. Verify the detached
signature with GPG before trusting `manifest.json`, then take the `checksum`
for `linux-x64` and `linux-arm64`. These signature and checksum-file checks
happen during the bump; the image build downloads only the pinned tool assets.

Update both architectures' digests and increment `AGENT_LAYER_VERSION` in
`src/sandbox-image.ts`. Run the fast guard, upstream comparison, both image
builds, package typecheck and tests, and the shared checks above.

## Host and adapter tests

The host runner's tests in `test/host.test.ts` drive whole passes, stop
signals and restarts with a stateful GitHub CLI fake, a fake Sandcastle behind
the real provider registry, a fake sandbox removal, and real Git clones of
local bare remotes, so they need Git. The decision core's tests in
`test/factory.test.ts` drive it with snapshots, and the host
configuration's tests read the fixture files in
`test/fixtures/host-configuration/`. Factory configuration validation reads
the fixtures in `test/fixtures/factory-configuration/`; run it alone with
`node --test test/factory-configuration.test.ts`. The host tests also cover
repository-specific labels and prompts, configuration edits on the default
branch, run settling while configuration or the Dockerfile is missing, and
paused runs: their label writes, single comment, recovery and resume. Each
provider adapter's tests read raw logs shaped like Sandcastle's file display
for its usage-limit errors. `test/usage.test.ts` drives the host's usage
reads on a fake clock, covering `Retry-After`, reading freshness and the usage
record, and `test/pause.test.ts` covers the pause deadline.
The GitHub CLI fake serves each issue's timeline from one fixture shape (label
events with their actors, body and title edits, comments and sub-issue links)
and each account's repository role, so the host tests drive the adapter's
readiness reads. `test/boundary.test.ts` checks that the package imports
nothing from outside itself and that its issue query reads no body.
The token tests drive the cache with a fake token command and clock; the one
that runs the GitHub CLI against the sandbox's token file skips when `gh` is
not installed. The run log's tests rely on file watching, which the published
log follows while an agent runs.

Sandcastle is pinned at 0.12.0. Its public types reference
`@standard-schema/spec` without declaring that dependency, as tracked in
[Sandcastle #864](https://github.com/mattpocock/sandcastle/issues/864).
The package pins it as a development dependency so `tsc --noEmit` checks the
dependency types as well as our own. Revisit that pin when upgrading Sandcastle.

## Documents

- [Release procedure](release.md): independent versioning, owner-only tag setup,
  the release pull request, and publication and verification.
