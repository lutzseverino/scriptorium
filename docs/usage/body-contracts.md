# Body-backed triage contracts

Scriptorium's bridge reads Repo Canon's public v1 and v2 contract decisions,
including v3 Seams exemption and v4 factory review wrappers under their base
format's rules.
Installing the bridge does not activate body publication. The repository's
trusted default-branch `.github/issue-contracts.json` and immutable cutoff
receipt select publication mode; no label, app author, timestamp or body marker
selects it. A verified absent file, or `{"mode":"prepared"}`, keeps legacy
publication. Unknown configuration, unavailable history or conflicting cutoff
facts hold publication and pickup with recovery diagnostics.

## Publication and admission

In prepared mode, successful triage retains its separate immutable brief
comment. A valid intake may have no validator result at all: verified prepared
mode permits publishing the first brief without one. Publication then waits for
the configured validator's supported notice naming that exact immutable
comment revision before requesting readiness. A notice for another source or
revision grants nothing. Admission separately requires approval of the exact
current readiness event and every existing authorization and scheduling gate.
A present unreadable or unsupported result holds before publication writes.

In body mode, the read-only agent supplies a complete Agent Brief,
including applicable Seams and notes, without a disclaimer or Original request.
The host preserves original intake bytes and author independently in Canon's
ledger, appends that original once at the body's end, after the brief's
[run-facts footer](host.md#run-results), and publishes the body.
A possible previously replaced intake without authenticated original history
holds publication; recover the trusted ledger instead of copying a report.

The host waits for the body's current validator notice, posts a separate
configured-author attestation of its exact issue/run/revision/edit identity,
records that proof in the ledger and requests automatic evaluation. Only a
current matching proof notice permits the requested readiness write. Admission
then waits for the validator's approval of that exact ready-label event and
verifies the referenced platform evidence. Body, attestation and selected
legacy source edits/deletions cannot be hidden by a report marker or an
edit-and-restore. A factory-authored intake requires authenticated writer
provenance for a different run; unknown or same-run provenance requires
independent person review, never inference from an app author or copied marker.

The mutable run report keeps its existing phase, result, action and continuation
behavior. It never becomes the selected brief, attestation, or evidence retry
target, even when `triageResult.marker` is `scriptorium:run`. Normal report
updates leave body and evidence bytes unchanged. Under v1, ordinary run/action/
hold updates retain their freshness exemptions. V2's exact observation includes
these comments: the issue-contract workflow automatically reevaluates comment
edits, so admission waits for that fresh decision without new proof, acceptance
or human action. Keep that workflow enabled and its runners available.

Publication checkpoints live in the host's existing run record. Restart
refetches mode, source, evidence and readiness identities. Known checkpoints
resume without duplicate originals, evidence or ready events. A concurrent edit
holds rather than overwriting it. If a body write succeeded but its exact edit
checkpoint was lost, the host verifies its recorded intent against the host
editor and exact predecessor in authenticated edit history. Missing history or
a concurrent human edit holds for recovery or fresh triage/review; identical
text alone cannot authenticate the missing write. Evidence intents similarly
retain their discussion and deletion identities before posting, so lost
responses recover unchanged comments and edited/deleted evidence holds.
A prepared result recovered after cutoff holds for fresh body triage and never
posts a new legacy contract. Stop/failed results retain their framed comment
and state behavior and never replace a contract body.

## Accepting a direct contract

A directly authored specification or implementation ticket carries its
contract in the issue body, so triage writes no brief for it. A triage run that
reviewed one and did not write it can accept the exact revision it reviewed: its
[run result](host.md#run-results) is done, asks for the ready state and its
companion labels, names that `sha256:` revision in `revision`, and carries the
review's notes as its body. The route is the same in prepared and body mode.

1. The host reads the validator's current notice. When it names another
   revision, a source other than the issue body, or a body edit older than the
   issue's last one, the body changed after the review: the run stops, as
   below, and posts nothing.
2. The host builds Repo Canon's factory review attestation with the function
   the repository's installed issue-contract module exposes, from the
   repository, the issue, the run, the revision and the notice's body source.
   It restates no Canon format. It posts the attestation once, as
   `triageResult.author`, inside the result's frame with its run marker, and
   never edits it.
3. It waits for a notice evaluated in a later second than the attestation.
   An earlier notice keeps it waiting.
4. When that notice names the attested revision and body source, with a review
   attestation of that comment and no refusal, the host applies the requested
   labels and then the ready state, in a later second than the notice first
   naming the attestation, and the run settles. Admission then needs the
   validator's v4 approval of that ready-label event, as
   [triage readiness](factory-configuration.md#triage-readiness) says.

When the notice evaluated after the attestation names another revision, or the
body changed before it, the host applies no readiness. The done result becomes
a stop that releases the claim and names the triage state (`labels.triage`),
which the issue keeps or regains, so triage reviews the new revision. A notice
for the attested revision whose status grants no review, that names no
attestation of the posted comment, or that refuses it holds visibly with the
notice linked; a later notice naming the attestation publishes the retained
result. A deleted or edited attestation holds without posting a second one.

The host reads only the published state line: its revision, source, status,
evaluation time and review attestation. Checkpoints save the accepted revision
and source before the attestation and the readiness request once it is written.
A restart recovers the posted attestation by its saved identity and an applied
ready event from the label's history, without a second attestation or readiness
event. When
the repository's installed module has no review attestation, the result is
refused as invalid with that reason, and nothing is posted.

## Rollout and recovery

Before rollout, satisfy the bridge binary's normal startup prerequisites:
canonical `.scriptorium/config.json` and `.scriptorium/Dockerfile`, valid
run/action templates when configured, and explicit `models.effort` in the host
configuration. Keep v2 implement-only or v3 run-kind configurations valid;
body mode changes neither credentials nor run kinds, capacity, priority,
parent/blocker gates or later current-head checks/review/merge requirements.

Use this order, under the adopting repository's normal authorization:

1. Install the bridge host while Canon remains in legacy/prepared mode.
2. Adopt a compatible prepared Canon release. Source installation alone
   activates no body behavior.
3. Freeze new and revised triage publication, including manual posters,
   in-flight results and retries. Drain completed legacy publication, or hold
   unfinished results for fresh body triage.
4. Capture Canon's trusted complete inventory of every open issue, including
   held and skipped work; record its explicit immutable cutoff and switch mode.
5. Automatically reevaluate inventoried issues and confirm current v2 results
   before lifting the freeze and allowing body publication/pickup.

The bridge uses the host's existing Issues-write and Contents-write authority
for bodies, immutable evidence, compare-and-swap ledger writes and evaluation
dispatch. Sandbox permissions remain fixed by run kind; triage stays read-only.
Retain and protect `repo-canon/issue-contracts` and its immutable receipt across
upgrades. Recover lost records from authenticated history; never reinitialize
an inventoried issue or infer eligibility from current text. After cutoff,
repair forward rather than restoring comment selection. Unchanged inventoried
legacy evidence remains eligible until its actual next contract revision.

An old host paired with an active v2 validator holds on the unsupported format:
keep publication frozen, install the bridge and reevaluate; do not bypass
readiness or roll back the recorded cutoff. A bridge with an old/prepared v1
validator retains legacy publication/pickup. A body-mode repository reporting
v1 must repair its compatible validator before continuing. A v3 Seams exemption
or v4 factory review result follows its v1 or v2 base's publication, readiness,
freshness and factory-proof rules. Repo Canon's installed
reader validates the wrapper; a historical exemption never authorizes
readiness, and a review attestation backs only the factory's readiness on a
direct contract. Unknown formats continue to hold.

If a self-hosted delivery lane cannot operate in an intermediate state, keep
its publication hold and arrange an authorized manual source/release delivery
path before entering that state. Source delivery for
[#148](https://github.com/lutzseverino/scriptorium/issues/148) does not deploy or
activate anything. [Repo Canon #920](https://github.com/lutzseverino/repo-canon/issues/920)
owns release, adoption, host and actual pickup evidence. Follow Canon's
[public protocol](https://github.com/lutzseverino/repo-canon/blob/94484bebc2b40b45759fa1d031bc289151520138/docs/development/issue-contract-v2.md)
for inventory/cutoff operations.

## Retained unpublished results

After a separately authorized upgrade to a fixed compatible host, preserve the
existing run records and let normal passes resume settlement. Startup also
reloads unsettled results. A result with only a prepared-mode checkpoint resumes
publication in that mode; one with no publication checkpoint first verifies the
current trusted mode and then publishes. Both retain the original run identity,
result and claim. Interrupted evidence or readiness writes recover their saved
identities without posting another brief or applying another readiness event.
A retained stop publishes its original question and requested state through the
ordinary result-comment route, without converting it into a brief or requiring
contract-publication proof.

A pending publication or issue-specific protocol hold keeps its own result and
claim for retry. Its run comment shows the wait or failure and recovery action;
other completed outcomes can settle and independently eligible issues can reach
admission under the existing capacity, usage, blocker and authorization gates.
Repository-wide platform read failures, including mode access, authentication,
rate limits and issue-list reads, still pause the repository. Repair shared
access before expecting settlement or pickup to resume.

Distinguish these recovery actions:

- While no notice evaluated after the published brief has arrived, restore
  automatic issue-contract evaluation and its runners; normal passes retry the
  retained result. That covers no notice, a notice evaluated before the brief
  or in the brief comment's second, and a notice with `evaluatedAt: null`.
  Publication is not validator approval or implementation admission.
- A notice evaluated after the brief decides by its `source` first, then by
  its `status`. Only the published state line's `status`, `source`, `revision`
  and evaluation time are read, against the brief comment.
  - When it selects another source, such as the issue body of a direct ticket,
    publication stops whatever its status. The stop releases the claim and its
    running label, requests no readiness and names the triage state
    (`labels.triage`, such as `state:triage`) in its action comment; the issue
    waits on whoever must answer.
  - When it selects no source, such as `no-contract` or `needs-attention`, the
    result holds visibly and keeps its claim. Its run comment and hold reason
    name the notice's status and link the notice.
  - When it selects the brief but grants no review, such as `needs-attention`,
    the result holds the same way.
  - For a `needs-attention` hold, make the repair that the linked notice lists
    and retry the retained result; the factory neither copies nor parses the
    repair text. A later notice selecting the brief publishes the retained
    result, so a label repair resumes the run without fresh triage or a
    restart.
- For an unknown, unsupported or conflicting validator result, restore the
  compatible configured validator and evaluate the actual source. For missing,
  edited, deleted or authentication-conflicting evidence, recover authenticated
  history or obtain fresh independent triage/review of the current revision;
  never reconstruct proof from a mutable report.
- If the publication mode or cutoff changed while a result was retained, keep
  publication frozen and obtain fresh triage in the current mode. A prepared
  checkpoint never falls back to legacy publication after body-mode cutoff.

No hand-editing or deleting run records, fabricated notices, copied result
comments, manual readiness changes or forced replacement workers are needed to
retry a retained result. Source delivery and this recovery procedure do not
install a release or prove live publication and pickup: release, authorized host
upgrade and live acceptance are separate work.
