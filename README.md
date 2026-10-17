<div align="center">
  <h1>Scriptorium</h1>
  <p>A self-hosted service that implements ready GitHub issues with coding agents in sandboxes, for maintainers who run it on their own machine.</p>
  <p>
    <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
    <img src="https://img.shields.io/badge/Node.js-24-5FA04E?logo=node.js&logoColor=white" alt="Node.js 24">
  </p>
</div>

Scriptorium is a factory: one process on a host serves every repository its
host configuration lists. It picks up issues a person marked ready and runs
each one's agent in a sandbox built from that repository's toolchain image. A
provider is an agent CLI and the subscription behind it, such as Claude Code or
Codex. Releases are this repository's `scriptorium-vX.Y.Z` tags.

## Installation

On a Linux host with Node.js 24, Git, the GitHub CLI and Docker, check out a
release tag and start the process with the host configuration's path:

```sh
git clone https://github.com/lutzseverino/scriptorium.git
cd scriptorium
git checkout <release tag>
npm ci --omit=dev
node src/main.ts /etc/factory/host.json
```

[Host installation and configuration](docs/usage/host.md) covers the service,
the credentials and updates.

## Features

- Serves many repositories from one process, with one oldest-first queue.
- Accepts readiness only from a person holding a role the host authorizes.
- Builds each sandbox from the repository's `.factory/Dockerfile` and its own agent layer.
- Caps each provider's concurrent sandboxes and holds launches at high usage.
- Pauses a run that hits its provider's usage limit and resumes it unattended.
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
