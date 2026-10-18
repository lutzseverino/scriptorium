# Factory architecture decisions

This directory records consequential decisions local to the factory.

- [Keep the package outside Repo Canon release inputs](0001-keep-the-package-outside-repo-canon-release-inputs.md):
  independent package and release ownership within the shared repository; its
  location is superseded by ADR 0002.
- [Release Scriptorium from its own repository](0002-release-scriptorium-from-its-own-repository.md):
  the package moved with its history to this repository's root, and its
  release stream continues here from `scriptorium-v1.0.6`.
- [Hold each provider, and never override the pause threshold](0003-hold-each-provider-and-never-override-the-pause-threshold.md):
  the drain and pause thresholds hold only the provider that reached them, and
  no owner action lifts the pause threshold.
- [Retain sandbox images the factory can prove it owns](0004-retain-sandbox-images-the-factory-can-prove-it-owns.md):
  automatic bounded retention of sandbox image pairs, and build cache isolated
  in the factory's own builder so only that cache is pruned.
- [Default the factory's own comment wording](0005-default-the-factorys-own-comment-wording.md):
  optional deterministic comment templates default the factory's own reports
  while other products' conventions remain explicit configuration.
