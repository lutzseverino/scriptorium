# Wait on pending required checks in the handoff gate

Where an issue's pull requests go to review, an implement run ends done once
its pull request head is pushed, and the host's required-check gate
([#138](https://github.com/lutzseverino/scriptorium/issues/138)) decides the
rest. While that head's required checks are pending, the run is awaiting
checks: the factory keeps the claim and launches nothing, with no bound on
already-pending results. On a pass it starts
review with no further implement launch; on a failure it hands the pull
request back to implement through the existing merge-relaunch mechanism as the
same attempt, spending no retry. Same-attempt relaunches for failed required
checks have the bound in #138; the next failure is an ordinary failure.
When no required result has appeared after the silent-wait bound measured from
the push, the factory posts a hold naming the missing checks and keeps waiting,
rather than stopping for the owner. It keeps the claim, and the hold clears
itself once results appear. This bound is the same single host value as the
readiness-read wait's bound, not a second setting; the values stay in #138 and
[#232](https://github.com/lutzseverino/scriptorium/issues/232).

Three implement runs stopped for the owner on checks that were queued or not
yet created when their bounded wait ended, and every one of those checks later
passed on the same head
([#219](https://github.com/lutzseverino/scriptorium/issues/219)). The owner
agreed on 2026-11-15 ("Agreed to all"), choosing to amend the gate before it
is built instead of reversing it afterwards.

## Considered options

- A new run outcome for a pushed head waiting on checks, with a relaunch once
  they settle: rejected, because it adds public names to the run result and an
  agent launch per head even when the checks pass.
- A longer foreground wait in the run: rejected, because it is a time-based
  delay, still misses checks created after the run's time limit, and holds a
  sandbox meanwhile.

## Consequences

- Review runs still wait for checks inside their own run after a branch
  update.
- Where an implement run merges its own pull request, without review, it still
  waits for its checks itself.
