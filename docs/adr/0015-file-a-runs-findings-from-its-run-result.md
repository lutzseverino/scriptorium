# File a run's findings from its run result

An implement or review run records its out-of-scope findings in its run
result, and the host files them. The run checks for an existing issue first,
so each finding is either a new issue for a named repository or an existing
issue with a recurrence comment. The host creates each new issue with the
filing-run citation, posts each recurrence comment, and edits nothing, using
its own credential for the target repository; it files only where it can
obtain one. Its run-result comment on the issue lists every finding filed,
linked or left unfiled, naming the unfiled finding's target repository.
Until the host files findings, a run whose finding write is refused lists the
finding as unfiled and continues its delivery instead of stopping; that
interim is removed once host filing lands.

The sandbox credentials of implement and review runs can only read issues, so
eleven of 43 factory stops counted on 2026-11-14 were a refused finding write
turned into an owner stop
([#203](https://github.com/lutzseverino/scriptorium/issues/203)). The owner
agreed on 2026-11-15 ("Agreed to all").

## Considered options

- Wider sandbox credentials with issue write: rejected, because it reverses the
  fixed per-kind credential scopes and the host's sole posting of run results
  (2026-11-03/04), lets an agent label its own issue, and still cannot reach
  another repository.
- Runs only report findings for someone to file later: rejected, because
  findings would no longer reach triage on their own.

## Consequences

- The run result gains a findings list, a format Scriptorium owns
  ([ADR 0011](0011-own-the-formats-the-factory-reads.md)).
- The factory still posts no system comment on pull requests.
