# Release Scriptorium from its own repository

Scriptorium moved out of Repo Canon's `factory/` directory into this
repository, `lutzseverino/scriptorium`, with its package at the root, and is
released from here. [ADR 0001](0001-keep-the-package-outside-repo-canon-release-inputs.md)
kept the package in Repo Canon with its own release stream, and Repo Canon's
[ADR 0013](https://github.com/lutzseverino/repo-canon/blob/v0.14.0/docs/adr/0013-install-the-factory-on-the-host-from-its-own-releases.md)
deferred a separate repository until a trigger: an outside user, factory changes
still driving most Repo Canon releases, or changed vendor terms. None of those
triggers had occurred. The owner decided to move anyway, on 2026-10-17, as the
[separation issue](https://github.com/lutzseverino/repo-canon/issues/506)
records. The shared repository made Repo Canon harder to explain, split one
issue tracker and CI between two products, and would have started
factory-owned work, such as the hosting-platform seam, inside the standards
source. The history of `factory/` was exported to the root with
`git filter-repo --subdirectory-filter factory`. The cut was Repo Canon commit
`80355eb3cd0069070a070fafb28e517ac6f7ce28`, whose `factory/` tree the exported
tree matches exactly. The commit map is recorded on that issue. Three
alternatives were rejected. Keeping a `factory/` directory here would have
spared the host's updater a layout change, but only by deferring the same
migration. Restarting at 1.0.0 would have published versions that Repo Canon
already holds. Copying the files without history would have lost the record
the ADRs and commits explain.

## Consequences

- The `scriptorium-v1.*` stream continues here from `scriptorium-v1.0.6`.
  `scriptorium-v1.0.0` through `scriptorium-v1.0.5` and their releases stay in
  Repo Canon at their original objects, under its tag ruleset, and are never
  moved, deleted or republished here. This repository has its own owner-only
  `scriptorium-v*` tag ruleset.
- A host's updater lists this repository's releases and installs from the
  checkout's root. An updater that still lists Repo Canon's releases keeps its
  installed version and receives no later release.
- This repository adopts Repo Canon's standards like any other repository,
  with the `factory` profile, so a factory can serve it. Repo Canon keeps that
  profile, the repository conventions it installs, and the factory terms those
  conventions use; the boundary of
  [ADR 0014](https://github.com/lutzseverino/repo-canon/blob/v0.14.0/docs/adr/0014-name-every-factory-convention-in-configuration.md)
  and the optional profile of
  [ADR 0017](https://github.com/lutzseverino/repo-canon/blob/v0.14.0/docs/adr/0017-make-the-factory-an-optional-profile.md)
  stand.
- Factory issues are tracked here, and a change spanning both products takes
  one issue in each repository, linked.
- The earlier `.sandcastle/` implementation, which preceded `factory/`, stays
  in Repo Canon's history; it was not exported.
