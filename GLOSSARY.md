# Factory

The factory runs GitHub tickets on a host across the repositories its operator
lists, and has its own release stream.

## Language

**Scriptorium**:
The product name under which this repository releases the factory, its
`@lutzseverino/scriptorium` package and its `scriptorium-vX.Y.Z` tags. Use
"factory" for the role.
_Avoid_: Scriptorium when referring to the generic factory role

**Factory release**:
A version of the factory, published from this repository under its own version
numbers, that a host installs.
_Avoid_: Repo Canon release, source publication

**Interrupted run**:
A run whose sandbox a factory restart stopped, which launches again as the same
attempt on its branch instead of ending with a run outcome.
_Avoid_: Cancelled run, drained run

**Drain threshold**:
The provider usage percentage, set in host configuration, at or above which
the factory claims no new issue for that provider in any repository, retries
included, while its running runs carry on. Other providers keep claiming.
_Avoid_: Usage threshold, soft pause

**Pause threshold**:
The provider usage percentage, set in host configuration and never below the
drain threshold, at or above which the factory also stops that provider's
running runs by killing their sandboxes, so each becomes a paused run. Nothing
overrides it.
_Avoid_: Hard pause, kill threshold

**Usage hold**:
The factory's automatic hold on one provider: once a reading reaches a
threshold, it keeps that reading in force while the provider's usage is
unknown, and ends on a usable reading below every threshold, at the reset the
provider reported, or at the latest 24 hours after it began.
_Avoid_: Provider pause, cached reading

**Owner hold**:
A hold on one provider that a host whose policy after the drain is
owner-resume sets at the drain threshold. It keeps that provider from claiming
new issues through low and unknown readings and restarts until the owner
resumes the provider, and never holds paused runs.
_Avoid_: Soft-pause label, factory pause

**Reserve raise**:
A one-time raise of one provider's drain threshold for new claims, up to its
pause threshold, which the owner requests when resuming the provider. It lasts
until a reading below the configured drain threshold or the provider's
reported reset, and never moves the pause threshold or releases a paused run.
_Avoid_: Override, threshold bypass

**Paused run**:
A run whose agent exited on its provider's usage limit, or whose sandbox the
factory stopped at its provider's pause threshold, which the factory labels
paused and relaunches by itself as the same attempt once the provider's usage
reads below every threshold, or once its deadline passes while the usage is
unknown and no usage hold applies, instead of ending with a run outcome.
Unlike a paused repository, which claims and launches nothing for a pass and
never touches its issues, a paused run is one issue's run, marked on that
issue.
_Avoid_: Limited run, held run, failed run

**Provider**:
An agent CLI and the subscription behind it, on which the factory runs a
model, such as Claude Code or Codex.
_Avoid_: Vendor, worker

**Run outcome**:
How a factory run ended, read from GitHub and the run's branch: done, awaiting
merge, needs input, or failed.
_Avoid_: Result, status
