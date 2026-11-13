# Own the formats the factory reads, and import Repo Canon's contract module

Scriptorium owns, end to end, every format it reads or writes for itself: its
configuration, a repository's model policy, and the footer of its run results
with its configured disclosure. The repository model policy moves from
`.github/factory-model-policy.json` to `.scriptorium/model-policy.json`, its
owner's directory; for one configuration version Scriptorium reads either path,
and the transition lives in Scriptorium's reader, not in another project's
rules. Repo Canon reads none of these formats: its scripts use the labels Repo
Canon provisions, and its validator ignores the factory's frame. Where
Scriptorium needs Repo Canon's issue-contract protocol, it imports the
self-contained module Repo Canon installs in every adopting repository instead
of keeping its own copy pinned to a Repo Canon commit, so each format has one
owner and one implementation, and imports run in one direction only.

The owner agreed on 2026-11-13 ("Agreed to all"), after an audit found Repo
Canon parsing and restating Scriptorium's configuration and model policy, and
Scriptorium copying Repo Canon's contract protocol, under the owner's earlier
direction "Be strategic, long-term thinking, as always. And don't couple
projects." (2026-11-12). A copied format kept the coupling (two parsers, two
texts that drift, ordered merges and releases) without a seam a test could
cross.

## Considered options

- Publishing a Scriptorium reader package for Repo Canon to vendor: rejected,
  because Repo Canon's scripts need only label names Repo Canon defines, and
  Scriptorium already adopts Repo Canon, so vendoring both ways would make a
  cycle.
- Keeping the model policy under `.github/`: rejected, because a third
  configuration directory leads an agent nowhere; `.scriptorium/` is where the
  factory's values live.
