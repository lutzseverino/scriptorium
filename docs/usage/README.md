# Factory usage

This directory explains how to run a self-hosted service that implements ready GitHub issues with coding agents, for operators who install it on a host and maintainers of the repositories it serves.

A repository it serves carries only two files: `.scriptorium/config.json` names
its labels, implementation skill and trusted contract result, and `.scriptorium/Dockerfile` builds its toolchain image.
[Repo Canon](https://github.com/lutzseverino/repo-canon), a set of shared
repository conventions, supplies these files through its `factory` profile.
Place them under `.scriptorium/` for Scriptorium v4.0.0; the rename takes effect
immediately, with no legacy-directory reading window.

- [Host installation and configuration](host.md): starting the process, the
  host configuration schema, the agent CLIs and models it runs, the token command's
  contract, redaction, the state directory, sandbox image retention, and the
  status file.
- [Repository factory configuration](factory-configuration.md): repository
  labels, model label prefix, implementation skill, trusted contract result, pauses, and protection.
- [Sandbox image contract](sandbox-image.md): repository toolchain requirements,
  the factory's agent layer, pinned tools, and image reuse.

- [Body-backed triage contracts](body-contracts.md): publication, exact evidence, legacy compatibility, staged activation and recovery.
