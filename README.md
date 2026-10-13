# Factory

The factory is a host-installed GitHub issue runner, with its own release
stream and version numbers. One process serves every repository listed in the
operator's host configuration, with one oldest-first queue and host-wide
provider caps. The live factory still runs from `.sandcastle/` until the
remaining
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

The operator owns the host configuration; each repository owns its sandbox
Dockerfile, `.factory/Dockerfile`. Start the process with
`node src/main.ts <host configuration>`;
[host installation and configuration](docs/usage/host.md) documents the host
configuration schema, the state directory and the status file. The package's
image builder supplies the factory agent layer over each repository's
toolchain image; the
[sandbox image contract](docs/usage/sandbox-image.md) describes its Dockerfile
requirements and pinned tools. The boundary decisions live in
[ADR 0013](../docs/adr/0013-install-the-factory-on-the-host-from-its-own-releases.md)
and [ADR 0014](../docs/adr/0014-name-every-factory-convention-in-configuration.md).

## Providers

The provider registry in `src/providers.ts` holds one adapter per provider the
host configuration names: Claude Code and Codex. Each adapter launches its
agent through Sandcastle, lists its reasoning efforts, routes bare model slugs
by its vendor prefix (`claude-*` or `gpt-*`), supplies the prompt's
`{skillPrefix}` (`/` or `$`), and reads its usage. Its one credential is a host
file, read again at every launch and usage read: the Claude Code token file
from `claude setup-token`, or the Codex login (`auth.json`) the host keeps
renewing. No provider credential comes from an environment variable.

A model is `<slug>` or `<provider>/<slug>`, optionally followed by
`@<effort>`; a model label is the same under the repository's model label
prefix. A model on a provider the host does not configure, an effort the
provider does not list, or a bare slug no configured provider routes is refused
with the reason.

## Documentation

[Factory documentation](docs/README.md) covers package development, release,
and architecture decisions. Factory terms live in the package
[glossary](GLOSSARY.md), located by the repository's
[glossary map](../GLOSSARY-MAP.md).
