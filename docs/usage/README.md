# Factory usage

This directory explains how to run a self-hosted service that implements ready GitHub issues with coding agents, for operators who install it on a host and maintainers of the repositories it serves.

A repository it serves carries only two files, `.factory/config.json` and
`.factory/Dockerfile`; Repo Canon's `factory` profile installs them.

- [Host installation and configuration](host.md): starting the process, the
  host configuration schema, providers and models, the token command's
  contract, redaction, the state directory, and the status file.
- [Repository factory configuration](factory-configuration.md): repository
  labels, model label prefix, prompt template, pauses, and protection.
- [Sandbox image contract](sandbox-image.md): repository toolchain requirements,
  the factory's agent layer, pinned tools, and image reuse.
