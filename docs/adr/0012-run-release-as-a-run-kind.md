# Run Release as a run kind with the repository's release skill

Release becomes one of the factory's run kinds, beside the triage, implement
and review kinds of
[ADR 0008](0008-split-work-into-run-kinds-handed-off-by-the-host.md). Like
them, it runs the skill a repository's configuration maps to it, such as Repo
Canon's `release` skill, so the factory and a person releasing by hand follow
one procedure. Once a repository's releases run as this kind, the
`factory:release-hold` label, which exists only because releases ran outside
the factory, is removed.

The owner agreed on 2026-11-13 ("Agreed to all", recorded in
[the specification](https://github.com/lutzseverino/repo-canon/issues/1061)),
choosing one design over a Repo Canon release skill and a factory release kind
decided separately; release was a recurring factory gap
([#186](https://github.com/lutzseverino/scriptorium/issues/186)).
