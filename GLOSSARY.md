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

**Paused run**:
A run whose agent exited on its provider's usage limit, which the factory
labels paused and relaunches by itself as the same attempt once the provider's
usage reads below the threshold, instead of ending with a run outcome. Unlike a
paused repository, which claims and launches nothing for a pass and never
touches its issues, a paused run is one issue's run, marked on that issue.
_Avoid_: Limited run, held run, failed run

**Provider**:
An agent CLI and the subscription behind it, on which the factory runs a
model, such as Claude Code or Codex.
_Avoid_: Vendor, worker

**Run outcome**:
How a factory run ended, read from GitHub and the run's branch: done, awaiting
merge, needs input, or failed.
_Avoid_: Result, status
