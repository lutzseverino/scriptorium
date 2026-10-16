# Scriptorium

Scriptorium is the host-installed factory that runs GitHub issues, with its own
release stream (`scriptorium-vX.Y.Z` tags) and version numbers. One process serves
every repository listed in the operator's host configuration, with one oldest-first queue and host-wide
provider caps.

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
configuration, `.factory/config.json`, and sandbox Dockerfile, `.factory/Dockerfile`.
The [factory configuration schema](docs/usage/factory-configuration.md) names
the required labels, model label prefix and prompt template. Start the process with
`node src/main.ts <host configuration>`;
[host installation and configuration](docs/usage/host.md) documents the host
configuration schema, the token command's contract, redaction, the state
directory and the status file. The package's
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
`{skillPrefix}` (`/` or `$`), reads its usage, and recognizes its own
usage-limit error at the end of an ended run's raw log. Its one credential is a
host file, read again at every launch and usage read: the Claude Code token
file from `claude setup-token`, or the Codex login (`auth.json`) the host keeps
renewing. No provider credential comes from an environment variable.

Claude Code's documented setup token supports launches but should not be
expected to read its undocumented, best-effort usage endpoint. A 403 can be a
permission refusal; a 429 means throttling. Neither waiting nor a successful
launch establishes usage permission. The factory backs off refused reads and
reports an unavailable episode once, with updates for changed failures and
numeric recovery. A good cached reading still applies for 20 minutes from its
observation; after it expires, fresh launches proceed without the percentage
gate. Provider caps, run time limits and the provider's actual limit still
apply. A confirmed limit pauses its run until a usable low reading or its
fixed unknown-usage deadline: the first reliably parsed UTC reset relative to
the pause, capped at 24 hours, or a 24-hour fallback. A usable high reading
continues to hold it; capacity and repository holds can also delay launch.
That deadline is no spending quota or cap on repeated pauses. The host guide's
[usage reads](docs/usage/host.md#usage-reads) describes backoff, recovery and the
separate `lutzseverino/homelab` responsibility for credential provisioning and
renewal.

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
