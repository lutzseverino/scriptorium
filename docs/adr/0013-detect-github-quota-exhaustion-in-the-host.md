# Detect GitHub quota exhaustion in the host

Status: amends [ADR 0003](0003-hold-each-provider-and-never-override-the-pause-threshold.md),
whose paused runs and holds named only a provider's usage.

The host, not the run, decides that the hosting platform's request quota stopped
a run. When a run ends without finishing, or one of the host's own platform
reads is refused as rate-limited, the host reads each served repository's quota
with that repository's own credential, a read the quota does not count. Every
repository whose quota reads exhausted gets a quota hold, which claims and
launches nothing there until the reset the platform stated, else the reset the
quota read reports, else 15 minutes later. A run that ended while its
repository was held becomes a paused run with the cause "GitHub rate limit":
it keeps its repository's configured paused label and the existing fixed
paused comment, and relaunches as the same attempt on the same model, spending
no retry. An attempt relaunches this way at most three times; its next such
ending is an ordinary failure, never an owner stop. A permission refusal still
stops for the owner.

Ten of 43 factory stops counted on 2026-11-14 were runs that hit the shared
installation's rate limit and stopped for the owner
([#185](https://github.com/lutzseverino/scriptorium/issues/185)). The owner
agreed on 2026-11-14 and 2026-11-15 ("Agreed to all"), with the goal "Yes
let's fix this up with priority so the factory can resume normally"
(2026-11-14), and the owner's standing direction of 2026-10-11 to lead with
fixes code can check, never a prompt change or a time-based delay.

## Considered options

- The run reports `outcome: "paused"` with a `retryAt`: rejected, because it
  adds a second way into a paused run beside the host's own detection, adds
  public names to the run result, and works only once a prompt teaches the
  agent to recognise a rate-limit refusal.
- The run sleeps until the reset: rejected, because it is a prompt change and a
  time-based delay, holds a sandbox's capacity, and can outlast the run's time
  limit.
- A hold on the whole GitHub App installation: rejected, because the host has
  no notion of an installation, only of repositories and their credentials.
  Repositories sharing a quota read it exhausted together, so a per-repository
  hold covers exactly them.

## Consequences

- The host's own rate-limited reads
  ([#171](https://github.com/lutzseverino/scriptorium/issues/171)) start the
  same quota hold rather than a second retry mechanism.
- The run result gains no field.
