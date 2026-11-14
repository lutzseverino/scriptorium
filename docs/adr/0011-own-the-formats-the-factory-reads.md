# Own the formats the factory reads, and import Repo Canon's contract module

Scriptorium owns, end to end, its configuration, a repository's model policy,
and the footer of its run results with its configured disclosure. The run
result's lead line and status markers remain Repo Canon's, as
[Repo Canon ADR 0044](https://github.com/lutzseverino/repo-canon/blob/main/docs/adr/0044-lead-every-message-with-its-outcome.md)
decides. The repository model policy moves from
`.github/factory-model-policy.json` to `.scriptorium/model-policy.json`, its
owner's directory; for one configuration version Scriptorium reads either path,
and the transition lives in Scriptorium's reader, not in another project's
rules. Repo Canon reads none of Scriptorium's formats: its scripts use the
labels Repo Canon provisions, and its validator ignores the factory's frame.
Where Scriptorium needs Repo Canon's issue-contract protocol, it imports the
issue-contract module Repo Canon installs in this repository, which adopts
Repo Canon, instead of keeping its own copy pinned to a Repo Canon commit, so
each format has one owner and one implementation, and imports run in one
direction only. This reverses the alternative
[ADR 0007](0007-read-the-contract-decision-from-the-validators-posted-result.md)
rejected, a shared module from a Repo Canon release; reading the validator's
posted result instead of interpreting contracts stands.

The owner agreed on 2026-11-13 ("Agreed to all", recorded in
[the specification](https://github.com/lutzseverino/repo-canon/issues/1061)),
after an audit found Repo Canon parsing and restating Scriptorium's
configuration and model policy, and Scriptorium copying Repo Canon's contract
protocol, under the owner's earlier direction "Be strategic, long-term
thinking, as always. And don't couple projects." (2026-11-12). A copied format
kept the coupling (two parsers, two texts that drift, ordered merges and
releases) without a seam a test could cross.

## Considered options

- Publishing a Scriptorium reader package for Repo Canon to vendor: rejected,
  because Repo Canon's scripts need only label names Repo Canon defines, and
  Scriptorium already adopts Repo Canon, so vendoring both ways would make a
  cycle.
- Keeping the model policy under `.github/`: rejected, because `.scriptorium/`
  is where the factory's values live and where an agent looks for them.
