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
  automatic bounded retention of sandbox image pairs, and, for hosts that opt
  in, build cache isolated in the factory's own builder so only that cache is
  pruned.
- [Default the factory's own comment wording](0005-default-the-factorys-own-comment-wording.md):
  optional deterministic comment templates default the factory's own reports
  while other products' conventions remain explicit configuration. Its
  per-comment pause, failure and awaiting-merge templates are superseded by
  ADR 0008.
- [Reach the hosting platform through Postern](0006-reach-the-hosting-platform-through-postern.md):
  the factory reads and writes issues, roles and pull requests through
  Postern's facts while keeping readiness and authorization, and the host
  configuration names each platform's accepted roles and accounts that never
  authorize.
- [Read the contract decision from the validator's posted result](0007-read-the-contract-decision-from-the-validators-posted-result.md):
  the factory checks the issue-contract validator's versioned result against
  platform facts and no longer interprets Agent Briefs itself.
- [Split work into run kinds handed off by the host](0008-split-work-into-run-kinds-handed-off-by-the-host.md):
  triage, implement and review run kinds, each optional, hand off through
  labels and artifacts, and the host posts every run's result.
- [Stand in a broader model at launch by provider pace](0009-stand-in-a-broader-model-at-launch-by-provider-pace.md):
  the host declares narrower-than pairs, and the factory runs the broader model
  at launch while its provider has spare usage or the narrower one's cannot
  launch.
- [Link run results and mention whoever must act](0010-link-run-results-and-mention-whoever-must-act.md):
  the default run comment shows each run result's lead line and link instead of a copy,
  the result's disclosure moves to a footer, and the action comment mentions
  the person who must act.
- [Own the formats the factory reads, and import Repo Canon's contract module](0011-own-the-formats-the-factory-reads.md):
  the configuration, model policy and run-result footer are Scriptorium's; the
  model policy moves to `.scriptorium/model-policy.json`; the contract
  protocol is imported from Repo Canon's installed module, not copied.
- [Run Release as a run kind with the repository's release skill](0012-run-release-as-a-run-kind.md):
  the factory and a person releasing by hand follow one skill; the release
  hold label goes once releases run as this kind.
