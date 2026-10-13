# Factory

The factory is a host-installed GitHub issue runner, with its own release
stream and version numbers. One process will serve the repositories listed in
the operator's host configuration. This package is the skeleton for that
runner; the live factory still runs from `.sandcastle/` until the remaining
[factory boundary work](https://github.com/lutzseverino/repo-canon/issues/334)
lands.

## Development

From `factory/`, install the pinned dependencies and run the package checks:

```sh
npm ci --include=dev
npm run typecheck
npm test
```

TypeScript executes through Node.js 24 type stripping, with no build step.
Sandcastle is a pinned runtime dependency; the smoke test constructs its
agent and sandbox configurations without launching a container or an agent.

Use the repository's [shared setup and validation](../docs/development/README.md)
and [contribution guidelines](../CONTRIBUTING.md) for delivery.

## Configuration

The operator owns the host configuration; each repository owns its factory
configuration and sandbox Dockerfile. Their schemas and the host runner are
later tickets in the boundary work, so this skeleton has no runnable host
command or configuration loader yet. The boundary decisions live in
[ADR 0013](../docs/adr/0013-install-the-factory-on-the-host-from-its-own-releases.md)
and [ADR 0014](../docs/adr/0014-name-every-factory-convention-in-configuration.md).

## Documentation

[Factory documentation](docs/README.md) covers package development, release,
and architecture decisions. Factory terms live in the package
[glossary](GLOSSARY.md), located by the repository's
[glossary map](../GLOSSARY-MAP.md).
