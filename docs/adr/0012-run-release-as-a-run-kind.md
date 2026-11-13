# Run Release as a run kind with the repository's release skill

Release becomes one of the factory's run kinds. Like the other kinds, it runs
the skill a repository's configuration maps to it, Repo Canon's `release`
skill by default, so the factory and a person releasing by hand follow one
procedure. Once a repository's releases run as this kind, the
`factory:release-hold` label, which exists only because releases ran outside
the factory, is removed.

The owner agreed on 2026-11-13 ("Agreed to all"), choosing one design over a
Repo Canon release skill and a factory release kind decided separately; release
was a recurring factory gap.
