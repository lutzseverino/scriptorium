# Sandbox image contract

Each repository supplies `.factory/Dockerfile`. It builds the repository's
toolchain image from a Debian or Ubuntu base, with no build context:

```dockerfile
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
```

The image must provide `apt-get`, install its toolchain system-wide, and assume
no user or home directory except `agent` and `/home/agent`. `COPY` and `ADD`
cannot read repository files because Docker receives only the Dockerfile on
stdin. Remote downloads in the Dockerfile can install the toolchain. Existing
users and groups are allowed, including the `node` user in
`node:24-bookworm`; the factory replaces a user holding the host's UID and
reuses a group holding its GID. Toolchain installation must therefore not
depend on those accounts or their homes. A toolchain Dockerfile may end with
a non-root `USER`; the factory switches back to root for its layer.

## Factory agent layer

The package's `src/sandbox-image.ts` exports `buildSandboxImage({ dockerfile,
uid, gid })`. The host supplies the repository Dockerfile's contents and its
positive numeric UID and GID. Docker must be available on the host. The
builder first builds the toolchain image, then builds the factory's
`src/agent-layer.Dockerfile` from that local image. Neither build has a context.
The host runner builds each repository's image from its `.factory/Dockerfile`
on every pass.

As root, the layer installs the tools below from pinned release binaries,
plus their distribution-provided runtime dependencies. It requires no Node.js
in the toolchain image and supports Linux amd64 and arm64. Binaries and Git's
helpers are installed system-wide, ahead of the toolchain's executables in
`PATH`.

Before extracting or installing a download, the layer checks the exact
downloaded tarball or bare Claude Code binary against a hand-pinned SHA-256
for the selected architecture. A mismatch fails the build with `sha256sum`'s
mismatch output; the failed file never reaches an install location. The
checks use the base image's `sha256sum` and fetch no extra files or tools.

| Tool        | Pinned version                                  | Release binary source                                                                                         |
| ----------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Git         | 2.53.0, Dugite release v2.53.0-4, build 4098283 | [GitHub Desktop's native Git release](https://github.com/desktop/dugite-native/releases/tag/v2.53.0-4)        |
| GitHub CLI  | 2.102.0                                         | [GitHub CLI release](https://github.com/cli/cli/releases/tag/v2.102.0)                                        |
| Claude Code | 2.1.287                                         | [Claude Code native release manifest](https://downloads.claude.ai/claude-code-releases/2.1.287/manifest.json) |
| Codex       | 0.162.1, with `codex-code-mode-host`            | [Codex release](https://github.com/openai/codex/releases/tag/rust-v0.162.1)                                   |

Git's relocatable release keeps its helper executables under
`/opt/factory/git/libexec/git-core`, selected by `GIT_EXEC_PATH`. Claude Code's
auto-updater is disabled so its version stays with the factory release.

Codex runs tools through its code-mode host, `codex-code-mode-host`, which it
starts from the directory of its own executable. The models the factory runs on
Codex are code-mode-only, so without the host a Codex run has no tool it can
run. The layer installs the host beside `codex` from the same Codex release's
per-architecture asset, so the two always share a version.

The layer creates or updates `agent` with the host's UID and GID, prepares a
writable `/home/agent`, and sets `HOME=/home/agent`, `USER agent`,
`WORKDIR /home/agent`, and `ENTRYPOINT ["sleep", "infinity"]`. Sandcastle
mounts a run's worktree and starts its agent within this long-running container.

The layer also installs the provider policy, each provider's system policy,
owned by root and readable but not writable by `agent`:

- Codex requirements, `/etc/codex/requirements.toml`, whose `[features]` table
  pins `apps`, `enable_mcp_apps` and `codex_apps_mcp_2026_07_28` off, so
  Codex offers no ChatGPT apps or connectors.
- Claude Code managed settings, `/etc/claude-code/managed-settings.json`, which
  set `disableClaudeAiConnectors` to `true`, so Claude Code fetches no
  claude.ai connectors.

A run signs its agent in with the host's provider login. Without the provider
policy, that login could reach the account's GitHub connector, which acts as
the account's linked GitHub user, and give the agent a second GitHub identity
beside the [minted installation token](host.md#sandbox-github-access), with
none of the factory GitHub App's restrictions. System policy outranks the
agent's own configuration, launch options and provider defaults, and the agent
can write its own Codex and Claude Code homes but not this policy. The layer
owns `/etc/codex` and `/etc/claude-code`: it replaces whatever the toolchain
image put there.

## Image tags and compatibility

The image tag is `factory-sandbox:<sha256>`. `sandboxImageTag(dockerfile,
layerVersion)` hashes a JSON tuple of the exact repository Dockerfile bytes
and the factory's `AGENT_LAYER_VERSION`. Changing either changes the tag;
unchanged inputs reuse the locally built image. The toolchain image has the
same tag with a `-toolchain` suffix.

Every change to the agent layer, including a tool pin, increments
`AGENT_LAYER_VERSION` in `src/sandbox-image.ts`. A factory release that changes
the layer therefore rebuilds every repository's image, while other factory
changes reuse it. UID and GID do not affect the tag: the builder checks the
image's `factory.agent.identity` label and rebuilds that tag if the host's
identity changes. Images belong to that host's Docker daemon.

A breaking change to this contract requires a new factory major under the
[release procedure](../development/release.md#choose-the-version).
