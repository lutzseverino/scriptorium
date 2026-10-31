# Read the contract decision from the validator's posted result

The factory no longer interprets implementation contracts. It reads the
decision that the repository's issue-contract validator posts on the issue, a
state line with a format version, the approval status, the Agent Brief
revision and the readiness label event it approves, and parses no Markdown.
The factory configuration names that result's marker and its trusted author,
so the factory knows no Repo Canon convention. Before a run, the factory checks
the result against platform facts: its author is the trusted account, it
approves the current readiness label event, the Agent Brief it names has not
been edited since, and no comment or edit on the issue is newer than it. A
missing or stale result holds the issue with a visible reason until the
validator posts again. The factory still checks that the label's actor holds a
role its host configuration accepts, and still compares link and edit times
for parent readiness, as
[ADR 0006](0006-reach-the-hosting-platform-through-postern.md) decides.

The factory had recognized Agent Brief headings and computed the validator's
revision fingerprint itself, and by 2026-10-31 the two interpretations
disagreed on authorized roles, ready label names, body edits, removed
category labels and deleted Briefs. The owner chose, in Repo Canon's grill of
2026-10-31, one interpreter, recorded in
[Repo Canon ADR 0029](https://github.com/lutzseverino/repo-canon/blob/main/docs/adr/0029-make-the-validators-posted-result-the-only-contract-decision.md).
Two alternatives were rejected: copying a shared module from a Repo Canon
release, because
[Repo Canon ADR 0014](https://github.com/lutzseverino/repo-canon/blob/v0.15.0/docs/adr/0014-name-every-factory-convention-in-configuration.md)
removed the factory's import of Repo Canon's issue-contract runtime so that it
works outside a Repo Canon adopter; and keeping a second interpretation tested
against fixtures, because it drifts.

## Consequences

- `src/contract.ts` and the Brief parser dependency go; moving an identical copy
  elsewhere would not satisfy this decision.
- An issue runs only when both the validator and the host configuration accept
  the label's actor, so a host can narrow who starts runs but never widen it.
  A refusal for a role names the role in its hold.
- A result format version the factory does not know is a visible hold, never a
  silent run.
- ADR 0006's statement that readiness stays in the factory's own code now means
  authorization, timing and execution; contract recognition is the validator's.
