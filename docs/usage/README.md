# Factory usage

This directory explains how to run a self-hosted service that implements ready GitHub issues with coding agents, for operators who install it on a host and maintainers of the repositories it serves.

A repository it serves carries only two files: `.factory/config.json` names
its labels and prompt, and `.factory/Dockerfile` builds its toolchain image.
[Repo Canon](https://github.com/lutzseverino/repo-canon), a set of shared
repository conventions, installs both when a repository adopts it with its
`factory` profile.

- [Host installation and configuration](host.md): starting the process, the
  host configuration schema, the agent CLIs and models it runs, the token command's
  contract, redaction, the state directory, and the status file.
- [Repository factory configuration](factory-configuration.md): repository
  labels, model label prefix, prompt template, pauses, and protection.
- [Sandbox image contract](sandbox-image.md): repository toolchain requirements,
  the factory's agent layer, pinned tools, and image reuse.
