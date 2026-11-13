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

**Comment template**:
A factory configuration string the factory fills in to word one of its issue
comments; the factory's own wording when absent.
_Avoid_: Comment prompt, agent-written comment

**Run comment**:
The factory's one issue comment per pass through the pipeline, from triage or
readiness to merge or failure, edited in place with each run kind's phase and
result; a retry after failure starts a new one.
_Avoid_: Status comment, progress comment

**Run result**:
The file a run's agent leaves for the host at exit, holding its outcome, the
labels it asks for and the text the host posts in the factory's frame.
_Avoid_: Agent comment, completion signal

**Run kind**:
One of the factory's kinds of run (triage, implement or review), each started
by its own trigger and running the skill a repository's configuration maps to
it; the factory owns the kinds and their handoffs, and the skills own what each
run does.
_Avoid_: Stage, phase, mode

**Stop**:
An issue's wait on an answer from whoever its state names (triage, its
reporter, a grill or the owner), which releases the factory's claim and keeps
the work and pull request until the issue is ready again.
_Avoid_: Needs input, question label

**Gate**:
An owner's label that stops a review at ready-to-merge until the owner removes
it, after which review resumes to merge.
_Avoid_: Approval hold, owner hold

**Hand-back**:
A review's return of its pull request, still a draft, to implement on the same
pull request with the review as its input, which an issue's reviews may make
at most twice.
_Avoid_: Rejection, retry

**Model policy**:
A repository's own preferences for each run kind's model, and what a launch
does while its choice is unavailable, chosen within the host's capabilities
and defaults.
_Avoid_: Model configuration, model catalog

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
Unlike a paused repository, which claims and launches nothing for a pass,
a paused run is one issue's run, marked on that issue.
_Avoid_: Limited run, held run, failed run

**Hosting platform**:
Where a served repository's issues, labels, roles and pull requests live, such
as GitHub, which the factory reaches through Postern, the hosting platform
package. Short form "platform".
_Avoid_: Forge

**Never-authorize account**:
An account the host configuration names for a hosting platform whose
readiness never counts, whatever its role there. Required on a platform that
doesn't mark bots.
_Avoid_: Bot list, denylist

**Provider**:
An agent CLI and the subscription behind it, on which the factory runs a
model, such as Claude Code or Codex.
_Avoid_: Vendor, worker

**Model guidance**:
The host owner's short statement of which work a model in the host's catalog
suits, from which every launcher chooses a model by fit: where several fit,
the narrower model when the host declares one, otherwise the cheaper one.
_Avoid_: Model profile, model card

**Narrower model**:
A model the host configuration declares suits a subset of the work another
model in its catalog suits, so a launch chosen for it may run that broader
model instead. Each such pair is declared on its own; the host declares no
ranking of its models.
_Avoid_: Weaker model, cheaper model, lower-ranked model

**Stand-in**:
A launch that runs a broader model in place of the narrower model chosen for
it. The broader model's provider must be able to launch now and either have
spare usage or, when the narrower model's provider cannot launch, have a fresh
usage reading below its drain threshold.
_Avoid_: Upgrade, fallback, substitution

**Spare usage**:
A provider's fresh usage reading that runs below its pace: its longest
reported usage window with a length and a reset is used less than the share of
that window already elapsed, and every shorter window it reports is below the
drain threshold. A window without a length or a reset gives no pace.
_Avoid_: Headroom, underused usage

**Sandbox image pair**:
The agent image a repository's runs start from and the toolchain image it is
built on, sharing one hash of the repository's `.scriptorium/Dockerfile` and the
agent layer version. A pair is current while a served repository's hash names
it, and obsolete otherwise.
_Avoid_: Sandbox image version, image set

**Factory builder**:
The factory's own Buildx builder, `factory-sandbox`, in which a host that
opts into it builds every sandbox image pair, so that builder's cache is the
only build cache the factory prunes. Other hosts build with the Docker
daemon's own builder and have no build cache pruned.
_Avoid_: Build cache, default builder

**Run outcome**:
How a factory run ended, read from its run result first and otherwise from
the hosting platform and the run's branch: done, awaiting merge, stopped, or
failed.
_Avoid_: Result, status
