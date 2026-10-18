# Factory development

This directory explains how to develop and release the factory package.

## Setup and validation

Use stable Node.js 24 or 26 with npm, Git, and Docker for the sandbox image
tests. Node.js 24 remains the default toolchain.
Follow the [contribution guidelines](../../CONTRIBUTING.md) for delivery.
Install GitHub CLI and authenticate it with your existing GitHub login before
running package tests: the upstream digest comparison uses authenticated
`gh api` requests for public release metadata. Missing CLI or authentication
fails that check; only an unavailable local network may skip it. From the
repository root, run `npm ci --include=dev`, `npm run typecheck`, and
`npm test`. Run `git diff --check` over the change before opening a pull
request. Run these commands with each supported major before requesting review.
CI's `Test (Node.js 24)` and `Test (Node.js 26)` jobs, in
`.github/workflows/ci.yml`, run the same install, typecheck and tests for every
pull request and push to `main`. The required `Test` check passes only when
both jobs succeed; the required `PR metadata` check keeps its Node.js 24 default.

The package runs TypeScript through Node.js type stripping on both majors and
emits no build output. The typecheck uses strict TypeScript, Node module
resolution, explicit `.ts` imports, type-only imports, and erasable syntax only.
Keep `@types/node` on the lowest supported major, 24, as the API baseline.
Source modules belong in `src/` and tests in `test/`.

[Node.js 26's TypeScript documentation](https://github.com/nodejs/node/blob/v26.12.0/doc/api/typescript.md)
keeps execution limited to erasable syntax and ignores `tsconfig.json`
transformations. It removes `--experimental-transform-types`; the
[module API](https://github.com/nodejs/node/blob/v26.12.0/doc/api/module.md#modulestriptypescripttypescode-options)
also removes the `stripTypeScriptTypes` transform and source-map options. Do
not add enums, runtime namespaces, parameter properties, import aliases, a
transformation flag, or a build step.

The sandbox image contract tests build and run the factory layer on
`debian:bookworm-slim` without Node and on both `node:24-bookworm` and
`node:26-bookworm` with their existing UID and GID 1000, and remove sandbox
containers by the layer's label. They run in both CI runtime jobs, where Docker
is required; local runs skip them when Docker is unavailable. Run them alone
with `node --test test/sandbox-image-build.test.ts`. Run the tag tests with
`node --test test/sandbox-image.test.ts`. Image builds download the pinned
release binaries and need network access. Increment `AGENT_LAYER_VERSION`
for every edit to `src/agent-layer.Dockerfile`, including tool pins.

The fast `test/agent-layer.test.ts` guard executes the install commands with
spies, without Docker or network access, for both architectures. It rejects
missing or malformed pins and extraction or installation before verification.
`test/agent-layer-upstream.test.ts` compares all ten pins against upstream
metadata using `gh api` and Claude Code's manifest. CI passes its read-only
GitHub token to the test step; only local runs may skip when the
network is unavailable. The image suite also alters Git's amd64 digest and
asserts that its checksum fails and no image is tagged.

### Bump an agent-layer tool

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

### Host and adapter tests

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
paused runs: their label writes, single comment, recovery and resume,
including runs stopped at the pause threshold and their kill and exit races.
Each
provider adapter's tests read raw logs shaped like Sandcastle's file display
for its usage-limit errors. `test/usage.test.ts` drives the host's usage
reads on a fake clock, covering `Retry-After`, reading freshness, usage holds
and the usage record, and `test/pause.test.ts` covers the pause deadline.
`test/owner.test.ts` drives owner holds, reserve raises and queued resume
requests on a fake clock over a state directory, including a request left
behind by a stopped process, and `test/resume.test.ts` covers the `resume`
command's arguments and refusals; the host tests run that command as its own
process against a running host.
The GitHub CLI fake serves each issue's timeline from one fixture shape (label
events with their actors, body and title edits, comments and sub-issue links)
and each account's repository role, so the host tests drive the adapter's
readiness reads. `test/boundary.test.ts` checks that the package imports
nothing from outside itself and that its issue query reads no body.
The token tests drive the cache with a fake token command and clock; the one
that runs the GitHub CLI against the sandbox's token file skips when `gh` is
not installed. The run log's tests rely on file watching, which the published
log follows while an agent runs.

Sandcastle is a pinned runtime dependency, at 0.12.0; the smoke test in
`test/sandcastle.test.ts` constructs its agent and sandbox configurations
without launching a container or an agent. Its public types reference
`@standard-schema/spec` without declaring that dependency, as tracked in
[Sandcastle #864](https://github.com/mattpocock/sandcastle/issues/864).
The package pins it as a development dependency so `tsc --noEmit` checks the
dependency types as well as our own. Revisit that pin when upgrading Sandcastle.

## Documents

- [Release procedure](release.md): independent versioning, owner-only tag setup,
  the release pull request, and publication and verification.
