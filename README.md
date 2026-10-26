<div align="center">
  <h1>Scriptorium</h1>
  <p>A self-hosted service that implements ready GitHub issues with coding agents in sandboxes, for maintainers who run it on their own machine.</p>
  <p>
    <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
    <img src="https://img.shields.io/badge/Node.js-24%20%7C%2026-5FA04E?logo=node.js&logoColor=white" alt="Node.js 24 or 26">
  </p>
</div>

Scriptorium is a factory: one process on a host serves every repository its
host configuration lists. It picks up issues a person marked ready and runs
each one's agent in a sandbox, a container built from the repository's own
toolchain image with the factory's agent layer of Git, the GitHub CLI and the
agent CLIs on top. A provider is an agent CLI and the subscription behind it,
such as Claude Code or Codex. Releases are published here as
`scriptorium-vX.Y.Z` tags. The stream began in Repo Canon, the shared repository
conventions this repository follows, where Scriptorium lived until
`scriptorium-v1.0.5`.

## Installation

On a Linux host with Node.js 24 or 26, pnpm 11, Git, the GitHub CLI and Docker, check
out the latest release and start the process with the host configuration's path:

```sh
git clone https://github.com/lutzseverino/scriptorium.git
cd scriptorium
git checkout "$(gh release view --repo lutzseverino/scriptorium --json tagName --jq .tagName)"
pnpm install --prod --frozen-lockfile
node src/main.ts /etc/factory/host.json
```

`scriptorium-v1.0.5` and earlier install from
[Repo Canon's releases](https://github.com/lutzseverino/repo-canon/releases)
instead, from the checkout's `factory/` directory.

[Host installation and configuration](docs/usage/host.md) covers the host
configuration, the token command, the state directory and restarts; the host
keeps its own service definition and credential files.

## Features

- Serves many repositories from one process, with one oldest-first queue.
- Accepts readiness only from a person holding a role the host authorizes.
- Builds each toolchain image from the repository's `.factory/Dockerfile`.
- Removes its own obsolete images after it builds, and its old build cache when a host opts in.
- Caps each provider's concurrent sandboxes and stops its new claims at high usage.
- Pauses a provider's runs near or at its usage limit and resumes them unattended.
- Holds a drained provider's new claims until its owner resumes it, when the host asks.
- Retries a failed first attempt once, on the host's retry model.
- Restarts without spending a run's retry.

## Usage

In a repository the host serves, a maintainer marks an issue ready and picks
its model:

```sh
gh issue edit 42 --add-label ready-for-agent --add-label model:claude-opus-5-5
```

On its next pass the factory labels the issue `factory:running`, runs the
agent on branch `factory/issue-42`, and keeps the claim while the agent's pull
request is open.

## Configuration

The operator owns the [host configuration](docs/usage/host.md#host-configuration).
Each repository owns its [factory configuration](docs/usage/factory-configuration.md),
`.factory/config.json`, and its toolchain image, `.factory/Dockerfile`, under
the [sandbox image contract](docs/usage/sandbox-image.md).

## Documentation

[Documentation](docs/README.md)

## Contributing

[Contribution guidelines](CONTRIBUTING.md)

## License

[MIT License](LICENSE)
