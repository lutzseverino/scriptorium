# Factory development

This directory explains how to develop and release the factory package.

## Setup and validation

Use stable Node.js 24 or 26 with pnpm 11.28.8, Git, and Docker for the sandbox image
tests. Node.js 24 remains the default toolchain.
Follow the [contribution guidelines](../../CONTRIBUTING.md) for delivery.
Install GitHub CLI and authenticate it with your existing GitHub login before
running package tests: the upstream digest comparison uses authenticated
`gh api` requests for public release metadata. Missing CLI or authentication
fails that check; only an unavailable local network may skip it. From the
repository root, run `pnpm install --frozen-lockfile` and `pnpm validate`. Run `git diff --check` over the change before opening a pull
request. Run these commands with each supported major before requesting review.
CI's `Test (Node.js 24)` and `Test (Node.js 26)` jobs, in
`.github/workflows/ci.yml`, run the same install and validation for every
pull request and push to `main`. The required `Test` check passes only when
both jobs succeed; the required `PR metadata` check keeps its Node.js 24 default.

The toolchain image sets `pnpm_config_store_dir` to
`/home/agent/.local/share/pnpm/store`, which the runtime agent user can write,
including when the checkout is mounted separately from home. Local development
keeps pnpm's platform defaults. If those defaults select a store inside the
checkout or an unwritable location, choose a writable directory outside the
checkout instead:

```sh
export pnpm_config_store_dir="$HOME/.local/share/pnpm/store"
pnpm store path
pnpm install --frozen-lockfile
```

Choose another external directory owned by your user if home is restricted.
For a single command, `--store-dir /absolute/writable/store` also selects the
store; use the same flag with `pnpm store path` to inspect that selection.
These are [pnpm 11 configuration mechanisms](https://pnpm.io/11.x/configuring);
`npm_config_store_dir` and non-authentication `.npmrc` settings are not read.
pnpm copies packages when the selected store and checkout are on different
filesystems. `.pnpm-store/` is ignored as a backstop for leftover or explicitly
local stores; no cache needs deleting or migrating.

The stack uses TypeScript 7, oxlint 1, Prettier 3 with its defaults, and
Node's test runner (`node --test`). `pnpm validate` runs the typecheck, lint,
format check and tests. Run `pnpm format` to format authored files. The lint
and format ignores exclude vendored code, Repository Standards state, installed
skills and the exact scripts Repo Canon installs.

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
is required; local runs skip them when Docker is unavailable. On all three
bases, they run `ps -axo pgid=,stat=` as `agent` and check usable process-group
and state output. The minimal Debian case verifies factory provision of `ps`;
the Node bases may already include it. Acceptance requires a passing
Docker-equipped CI or owner run; local skips are not acceptance.
On each base, the suite also starts the production Tini entrypoint without
Docker's `--init`, then creates three orphans in the same running container.
Each child stays alive until the test observes its adoption by PID 1; after
release, its `/proc` entry must disappear within a bounded wait. A control with
the previous `sleep infinity` entrypoint must fail the same reaping probe.
The suite then verifies agent identity, home, working directory, a writable
bind mount and command execution, and stops the container with TERM without
requiring KILL. No Node.js or Python is needed inside the minimal image for
this probe. Run the image suite alone
with `node --test test/sandbox-image-build.test.ts`. Run the tag tests, which
also drive both builders' commands against a fake Docker CLI, with
`node --test test/sandbox-image.test.ts`. Image builds download the pinned
release binaries and need network access. Increment `AGENT_LAYER_VERSION`
for every edit to `src/agent-layer.Dockerfile`, including tool pins.
The image suite builds with the daemon's own builder by default, including
from a base image only the local daemon has, which the factory's own Buildx
builder cannot find. It also builds in that factory builder, checks that only
its cache is pruned and only when selected, and runs image retention against
a real daemon over test-only tags. `test/image-retention.test.ts` first drives
retention against a fake Docker daemon that fails on a forced removal or any
host-wide prune, covering ownership, shared and current pairs, container
references, inventory failures and removal races.

`test/configuration-schema.test.ts` resolves the candidate release's schema and
same-tag configuration and sandbox-image docs against the local tree, using
Ajv to validate v2/v3 fixtures and invalid contracts. The host parser remains
authoritative for label uniqueness and comment-template semantics. After
publication, run `pnpm release:check <tag-pinned-schema-URL>` as the
[release procedure](release.md) directs to verify public resolution.

The fast `test/agent-layer.test.ts` guard executes the install commands with
spies, without Docker, network access, package installation or root access.
It executes the actual distribution-package RUN with `apt-get` and cleanup
spies and glob expansion disabled, asserting that the install requests `procps`.
It also asserts that the layer installs `tini` for PID 1 reaping.
For both architectures, it rejects
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

### Bump the factory builder's BuildKit

`buildkitImage` in `src/sandbox-image.ts` pins a `moby/buildkit` release tag
with its multi-platform image index digest, as
`docker buildx imagetools inspect moby/buildkit:<tag>` reports it, matching
the release on [BuildKit's releases](https://github.com/moby/buildkit/releases).
Run the image builds and the shared checks. A host that opted into the factory
builder keeps the builder its first build created, with that builder's
BuildKit, until the operator removes it with `docker buildx rm factory-sandbox`,
which also drops its cache; the next build creates it again from the new pin.

### Host and adapter tests

`test/prompt.test.ts` checks the pure `prompt(continuation, facts)` renderer.
The host supplies retry-tail text, credential limits and the shared repository
hold results; the prompt contains no hold or merge policy. Launch decisions,
host runs and snapshots carry one `Continuation`, and host restart tests cover
both that record and older records with flat launch fields. The optional result
path is supplied when the run-result mount is available.

The host runner's tests in `test/host.test.ts` drive whole passes, stop
signals and restarts with a stateful fake of each repository's Postern
connection, a fake Sandcastle behind the real provider registry, a fake
sandbox removal, and real Git clones of local bare remotes, so they need Git. The decision core's tests in
`test/factory.test.ts` drive it with snapshots, and `test/run-kinds.test.ts`
drives version 3's run kinds, handoffs, trusted triggers and model resolution
through the same entry point over placeholder providers and models.
`test/triggers.test.ts` checks machine finding citations against host launch
provenance; platform tests verify current author roles, reporter comment
identity and creation times, complete PR inventories and installation filing
identity. Host tests cover trigger consumption and finding verification across
restarts, plus independent draft PR review and explicit-target recovery. `test/run-ending.test.ts` drives the run-ending
module's observation and outcome table for ended runs and orphaned claims, and
`test/run-result.test.ts` the run-result interface, its containment and its
frame. `test/run-comment.test.ts` drives the one writer of the run, action and
close comments over a fake tracker: passes, final-write retries, actions told
once and continuations. `test/label-roles.test.ts`
checks that every label consumer derives its roles from `src/label-roles.ts`,
and `test/model-policy.test.ts` reads repository model policies. The host
configuration's tests read the fixture files in
`test/fixtures/host-configuration/`. Factory configuration validation reads
the fixtures in `test/fixtures/factory-configuration/`; run it alone with
`node --test test/factory-configuration.test.ts`. The host tests also cover
repository-specific labels and prompts, configuration edits on the default
branch, run settling while configuration or the Dockerfile is missing, and
paused runs: their label writes, run comment, recovery and resume,
including runs stopped at the pause threshold and their kill and exit races.
They also replay the public `events.jsonl` stream as an external consumer,
cover provider status with an empty frontier, and inject filesystem failures
at the event checkpoint, short append, append sync, policy write and checkpoint
completion. These fixtures verify stable identities after recovery and keep
owner releases separate from automatic usage releases and reserve grants.
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
The connection fake serves each issue's timeline from one fixture shape (label
events with their actors, body and title edits, comments and sub-issue links),
each account's repository role and the platform's capability flags, so the
host tests drive the platform module's readiness reads, including platforms
without bot marking, edit times or link times, and a remote no platform serves.
`test/platform.test.ts` drives that module through Postern's real GitHub
adapter over a fake `fetch`, without network access. Platform fixtures cover
approving, missing, untrusted, unknown-format, unreadable and non-approving
contract results, results made stale by comments, edits, deletions and label
changes, the factory's own hold comments and label writes, changed or deleted
contract sources, unreadable comments and parent readiness. The host fake
stands in for the validator: unless an issue opts out, its comment list ends
with a current result approving the latest ready-label event, so host tests
that opt out drive missing, stale and newer results across passes. GitHub
deletion facts not exposed by the neutral comment port use Postern's
authenticated `access.request` fallback. `src/contract-result.ts` reads the
`repo-canon/issue-contract-state/v1` format that
[Repo Canon v0.21.0 publishes](https://github.com/lutzseverino/repo-canon/blob/v0.21.0/docs/development/issue-contract-validation.md#published-result)
and the [public v2 protocol](https://github.com/lutzseverino/repo-canon/blob/94484bebc2b40b45759fa1d031bc289151520138/docs/development/issue-contract-v2.md);
v3 Seams exemption wrappers are validated through Repo Canon's installed
`issueContractResult` reader and `seamsResultFormat` constant, then read under
their v1 or v2 base's unchanged checks. Exemption history grants no readiness.
`test/contract-result-fixture.ts` copies literal public v1 and v3 state lines
and derives approvals from them. The literal v2 fixtures from Repo Canon commit `94484be` and the publication
fixtures exercise body/edit identity, preserved intake, evidence/notice/readiness
ordering, interrupted writes and report/evidence separation. A new result format
is a new version the factory accepts or refuses explicitly. The platform tests fail each state transition part
way. `test/boundary.test.ts` checks that the package declares only Node.js,
Sandcastle and Postern runtime dependencies and imports no other external
module except Repo Canon's installed result reader. It also verifies that the
platform projection and decision modules read no issue body. The factory
parses no contract Markdown. The validator's result is comment content, read through
Postern; readiness authorization stays in the factory and contract decisions
are the validator's. `src/run-comment.ts` alone reads the factory's own
comments back, by their marker lines.
The token tests drive the cache with a fake token command and clock, and pin
each run kind's permission set. The host tests' token command mints a narrowed
token for each permission set, and a fake platform refuses a sandbox's writes
its token's permissions do not grant; they launch triage, implement and review
together in one repository and refresh their tokens. The one
that runs the GitHub CLI against the sandbox's token file skips when `gh` is
not installed. The run log's tests rely on file watching, which the published
log follows while an agent runs.

Postern is a pinned runtime dependency, at an exact `1.x` version; bump it
within major 1 and run the platform, host and boundary tests.

Sandcastle is a pinned runtime dependency, at 0.12.0; the smoke test in
`test/sandcastle.test.ts` constructs its agent and sandbox configurations
without launching a container or an agent. Its public types reference
`@standard-schema/spec` without declaring that dependency, as tracked in
[Sandcastle #864](https://github.com/mattpocock/sandcastle/issues/864).
The package pins it as a development dependency so `tsc --noEmit` checks the
dependency types as well as our own. Revisit that pin when upgrading Sandcastle.

`test/sandcastle.test.ts` also drives the pinned dependency's actual worktree
creation and cleanup to check preservation of commits, the index, working tree
and untracked files through recovery. `test/claude-foreground.test.ts` runs
the pinned Claude CLI against a local scripted HTTP API with synthetic
credentials and a private home, without a live provider. It attempts explicit
backgrounding, then runs validation beyond the usual automatic background
window with success, failure and timeout outcomes, checks the Bash result
reaches the next turn, and exercises conflicting project settings. It skips
when the pinned CLI is absent. Run it alone with
`node --test test/claude-foreground.test.ts`. This verifies CLI/tool behavior;
it does not demonstrate a live model's delivery decisions or publish a PR.

## Documents

- [Release procedure](release.md): independent versioning, owner-only tag setup,
  the release pull request, and publication and verification.
