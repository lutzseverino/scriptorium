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
readiness to merge or failure, edited in place with each phase's state and,
by default, the lead line of its run result, which it links rather than copies;
a retry after failure starts a new one.
_Avoid_: Status comment, progress comment

**Lead line**:
The first visible line of a factory comment or of a run result's text: its
state or outcome behind a status marker, and who must act when a person must.
_Avoid_: Headline, summary, disclaimer line

**Action comment**:
The factory's fresh one-line issue comment, posted only when a person must act,
mentioning that person and linking the run comment.
_Avoid_: Notification comment, ping

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
An issue's wait in a state that releases the factory's claim and keeps the
work and pull request. Most stops wait on an answer from whoever the state
names (triage, its reporter, a grill or the owner), which a person gives by
applying the issue's next state or closing the issue. A carried stop asks
nobody: another record or ticket carries the request's fate, and removing its
state starts nothing.
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
A run paused by its provider's usage limit or pause threshold, or by its
repository's quota hold (cause: GitHub rate limit), awaiting automatic relaunch
as the same attempt instead of ending with a run outcome. Unlike a paused
repository, a paused run belongs to one issue and is marked on that issue.
_Avoid_: Limited run, held run, failed run

**Quota hold**:
The factory's automatic hold on claims and launches in one served repository
whose hosting-platform quota is exhausted, lasting until the reset.
Repositories sharing a quota are held together, unlike a usage hold's scope of
one provider.
_Avoid_: Rate-limit pause, installation hold

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
the hosting platform and the run's branch: done, awaiting checks, awaiting
merge, stopped, or failed.
_Avoid_: Result, status

**Awaiting checks**:
The run outcome of an implement run that finished with its pull request head
pushed while that head's required checks are still pending: the factory keeps
the claim, continues to review once they pass, and hands the pull request back
to implement if they fail.
_Avoid_: Check wait, pending handoff

**Run clone**:
A run's own Git directory and working tree, cloned for that run alone, in which
its sandbox works. No other run's clone or the repository's shared clone is
visible to it, and it lasts as long as the run's attempt.
_Avoid_: Shared clone, worktree

**Credential health**:
One aggregate judgment of the credentials the factory runs on, recorded each
pass: unhealthy when a held provider login is past its expiry or its renewal
due time, its last renewal failed, or the GitHub App installation lacks a
permission a run kind declares; unknown when any of those facts cannot be
established; healthy otherwise. It is built from facts only, never a
credential.
_Avoid_: Credential status, token health
