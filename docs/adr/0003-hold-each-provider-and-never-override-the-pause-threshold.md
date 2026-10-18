# Hold each provider, and never override the pause threshold

The factory's response to a provider's usage is scoped to that provider and has
two levels, both set in host configuration: at the drain threshold it claims no
new issue for the provider, and at the pause threshold it also kills that
provider's running sandboxes, so their runs become paused runs. The owner
settled this on 2026-10-17 in the
[usage threshold decisions](https://github.com/lutzseverino/scriptorium/issues/9),
after the factory had one fixed behaviour: a single threshold that held fresh
launches and let running runs spend what was left.

A subscription's allowance belongs to one provider, so a hold on Claude Code
leaves Codex's capacity in use. A factory-wide hold was rejected because one
exhausted subscription would idle the others, and issue labels such as
`soft-pause` and `hard-pause` were rejected because the hold spans every
repository and can start with no issue to label. The automatic usage hold and
the owner hold, which an owner-resume host sets at the drain threshold, are
therefore per-provider state in the state directory, distinct from a paused
repository and from a paused run's label. The owner hold ends only when the
owner resumes the provider; a low reading, a reset or the fallback deadline
ends only the usage hold.

The pause threshold is the owner's last reserve. Killing the sandbox is the
only way to stop a run, since the factory cannot talk to a running agent, and
the run keeps its worktree, branch and attempt, so killing it loses only the
agent's session. Nothing overrides that threshold: no owner resume, no
one-time raise of the drain threshold, which stops at the pause threshold, and
no graceful stop, which is not planned. An override would leave nothing that
reliably keeps the factory from spending the reserve.

## Consequences

- The thresholds are host policy, in host configuration, and follow
  [ADR 0014](https://github.com/lutzseverino/repo-canon/blob/v0.14.0/docs/adr/0014-name-every-factory-convention-in-configuration.md):
  the factory names no new issue label for a hold, and a paused run uses the
  repository's configured paused label and the existing fixed comment, with its
  cause naming the pause threshold.
- A usage hold outlives an unknown or stale reading and a restart, so an
  unreadable provider cannot silently reopen claims. Its deadline is fixed when
  it begins, from the provider's reported reset or 24 hours later at the latest,
  and is never a usage read's backoff.
- `usage.drainThreshold` replaces `usageThreshold`. Hosts install the factory
  from its own releases, as Repo Canon's
  [ADR 0013](https://github.com/lutzseverino/repo-canon/blob/v0.14.0/docs/adr/0013-install-the-factory-on-the-host-from-its-own-releases.md)
  records, so one factory release still reads the old field, with a warning,
  before it is refused.
- A pause threshold below the drain threshold is a configuration error;
  equal thresholds drain and pause together.
