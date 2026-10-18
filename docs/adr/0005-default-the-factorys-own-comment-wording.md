# Default the factory's own comment wording

The factory supplies its own wording for its pause, failure and parent-close
issue comments, with optional comment templates in repository configuration to
replace it. The owner settled this in
[the comment-template decisions](https://github.com/lutzseverino/scriptorium/issues/14#issuecomment-6245646584),
with the failure count clarified in
[issue #24](https://github.com/lutzseverino/scriptorium/issues/24#issuecomment-6247502807).
A default for the factory's own report is knowledge of its own behavior;
defaulting a repository's labels, model-label prefix or prompt would instead
assume another product's conventions. Those remain required configuration.
This refines the ownership boundary in
[Repo Canon ADR 0014](https://github.com/lutzseverino/repo-canon/blob/v0.15.0/docs/adr/0014-name-every-factory-convention-in-configuration.md)
without changing its rule that the factory knows no Repo Canon convention.

Comments use deterministic substitution and sections rather than agents: a
usage-limit report must remain writable when the provider has no usage left.
Defaults and overrides use the same renderer, so repositories can change tone,
language or add their own disclaimer without changing the factory's facts or
delivery policy. No disclaimer is enforced, and the parent-close default drops
its former Repo Canon disclaimer. Repo Canon can omit comment configuration
and use the defaults; neither its configuration nor the schema version needs
to change. Host subscription and readiness policy stay in host configuration.
