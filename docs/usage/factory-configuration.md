# Repository factory configuration

Each repository names its conventions in `.factory/config.json`. The factory
reads it from the repository's default branch on every pass, alongside
`.factory/Dockerfile`. Labels, the contract result, the model-label prefix,
the skills and their arguments have no defaults. Optional comment templates default to the factory's own wording; see
[the ownership decision](../adr/0005-default-the-factorys-own-comment-wording.md).

Version 3 maps up to three [run kinds](#run-kinds) to skills; version 2 runs
one implement skill. Each version is validated against its own contract,
described below, and every other version is refused.

## Compatibility window

Scriptorium reads the current factory configuration version N and the previous
version N−1. Initially N is 3 and N−1 is 2. One host can serve repositories on
both versions, so upgrading the host and adopting a new Repo Canon configuration
need no synchronized switch. Upgrade the host before adopting a configuration
it does not yet support; older hosts need not accept newer configurations.

Version 2 keeps its single implement invocation, configured labels (including
`needsInput`), model-label prefix, contract-result identity and optional settings.
It acquires no triage or review run, state label requirement or repository model
policy from the host upgrade. Version 3 uses the run kinds and optional model
policy described below. Neither version accepts unknown or malformed fields;
versions outside the two-version window are refused rather than converted.

## Version 3

The fields in this example are required; `runKinds.triage`,
`runKinds.review`, `triageResult`, `comments` and every label but `ready`,
`running`, `paused` and `failed` are optional. Unknown fields at any level and
malformed values are invalid.

```json
{
  "version": 3,
  "labels": {
    "ready": "state:ready",
    "running": "factory:running",
    "paused": "factory:paused",
    "failed": "factory:failed"
  },
  "contractResult": {
    "marker": "repo-canon:issue-contract-state",
    "author": "github-actions[bot]"
  },
  "modelLabelPrefix": "model:",
  "runKinds": {
    "implement": { "skill": "implement", "arguments": "#{issue}" }
  }
}
```

Implement alone is the minimum, and behaves as a version 2 repository's one
run does, with the state labels below in place of `needsInput`. Repo Canon's
factory profile ships every run kind and label role:

```json
{
  "version": 3,
  "labels": {
    "triage": "state:triage",
    "reporter": "state:reporter",
    "grill": "state:grill",
    "owner": "state:owner",
    "ready": "state:ready",
    "ownerReview": "gate:owner-review",
    "majorRelease": "gate:major-release",
    "running": "factory:running",
    "paused": "factory:paused",
    "failed": "factory:failed",
    "skip": "factory:skip",
    "hold": "factory:hold",
    "releaseHold": "factory:release-hold",
    "priorityHigh": "priority:high",
    "priorityNormal": "priority:normal",
    "priorityLow": "priority:low"
  },
  "modelLabelPrefix": "model:",
  "runKinds": {
    "triage": { "skill": "triage", "arguments": "#{issue}" },
    "implement": { "skill": "implement", "arguments": "#{issue}" },
    "review": {
      "skill": "review",
      "arguments": "#{pullRequest}",
      "differentProvider": true
    }
  },
  "contractResult": {
    "marker": "repo-canon:issue-contract-state",
    "author": "github-actions[bot]"
  },
  "triageResult": {
    "marker": "scriptorium:run",
    "author": "lz-scriptorium[bot]"
  }
}
```

| Field                               | Value                                                                                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                           | Numeric `3`.                                                                                                                                                                |
| `labels.<role>`                     | The label name of each [label role](#label-roles), a non-empty trimmed string, distinct from every other ignoring case. `labels.triage` is required with `runKinds.triage`. |
| `contractResult`                    | As in version 2; see [contract result](#contract-result).                                                                                                                   |
| `triageResult.marker`               | The marker of the line naming the factory triage run in its result, `<!-- <marker> {"run":"…"} -->`. See [triage readiness](#triage-readiness).                             |
| `triageResult.author`               | The account the factory's triage run posts its result and applies readiness as.                                                                                             |
| `modelLabelPrefix`                  | As in version 2.                                                                                                                                                            |
| `runKinds.<kind>.skill`             | The kind's skill name as a non-empty trimmed string, without the provider's invocation prefix.                                                                              |
| `runKinds.<kind>.arguments`         | A string of skill arguments. Every `{issue}` expands to the issue number and every `{pullRequest}` to the PR number the run works on; triage has no PR and refuses it.      |
| `runKinds.review.differentProvider` | Optional boolean: whether review asks for a provider other than its implement attempt's; see [provider diversity](host.md#provider-diversity).                              |
| `comments`                          | As in version 2; see [comment templates](#comment-templates).                                                                                                               |

Model values are not configuration here: the host's defaults and the
repository's optional [model policy](host.md#repository-model-policy) choose
them.

An implement launch with no PR, such as a fresh attempt, cannot use
`{pullRequest}`: it waits with the diagnostic
`runKinds.implement.arguments names {pullRequest}, and this launch has no pull request`
in status and logs. A hand-back, a resumption with a PR and a merge relaunch
supply it.

### Run kinds

[ADR 0008](../adr/0008-split-work-into-run-kinds-handed-off-by-the-host.md)
records the split. Each kind is optional except implement:

- **Triage** researches one issue and ends with its Agent Brief and readiness,
  or a stop. Without triage, readiness comes only from a person.
- **Implement** takes a ready issue to a draft pull request. Without review,
  its skill also delivers and merges it, as version 2's run does.
- **Review** reviews that PR as an agent that wrote none of it, fixes small
  findings or hands the work back, and merges it. With review on, only review
  merges: a merge relaunch runs review.

Each kind runs its configured skill under the factory's unattended execution
guidance; a triage run and a review run log beside implement's, as
`issue-<n>-triage-attempt-1.log` and `issue-<n>-review-attempt-1.log`. Only
an implement attempt retries.

### Handoffs

The host hands work between the kinds through the issue's labels and its pull
request, and every launch passes the same pickup gates, holds and model
checks:

- **Triage** claims an issue opened by a person whose current repository role
  the host authorizes, or carrying `labels.triage` applied by such a person.
  The host's `neverAuthorize` accounts never qualify. Roles come from Postern,
  as for readiness. A bot's label, including the validator's fallback, grants
  no trust; a trusted author remains an independent trigger. Other state labels
  keep an opening from overriding an existing handoff or stop.
- **Reporter replies**: on `labels.reporter`, a new comment by the issue's
  author re-triggers triage after a trusted reporter-state application or a
  previously trusted factory run. Other commenters and edits of old comments
  do not. Openings, label applications and replies are consumed durably at
  launch, so settlement and restarts do not repeat them. A later trusted label
  or author reply can trigger another run.
- **Factory findings** may cite their filing run with the exact line the host
  supplies in that run's prompt, for example:

  ```html
  <!-- scriptorium:filing-run {"run":"<host-issued run ID>"} -->
  ```

  The host accepts exactly one such line. It verifies the run against its own
  durable launch provenance, checks that the run was trusted and predates the
  issue, and matches the issue author to the filing credential's account.
  A forged, unknown or untrusted citation grants no trust. Unreadable identity
  and provenance reads never authorize a finding. A person may still apply
  the trusted triage label. Preserve the repository's `runs/provenance/` records
  along with its run records when moving host state.

- **Implement** starts on accepted readiness, `labels.ready`, as in version 2.
- **Review** starts on the PR an implement run ends with, keeping the claim
  without an awaiting-merge notice. It also claims an open draft PR whose
  author has an authorized current role, is not excluded, and which no factory
  run owns. An untrusted draft starts nothing. Independent drafts use the PR
  number as their work item; review resolves linked issue contracts, or uses
  the PR body as its Spec source when there is no linked issue. The PR's head
  is consumed durably, and its explicit target survives interruptions and
  changes out of draft. These triggers pass through the same model, capacity,
  usage and repository-hold admission gates as existing runs.
- **A hand-back** starts implement on the same PR when a review ends with its
  PR still a draft, at most twice; a review that would hand back a third time
  fails the issue.
- **A stop**: a run that ends with the issue in the triage, reporter, grill or
  owner state releases its claim and leaves the issue there. Returning the
  issue to `labels.ready` resumes the same work and PR on a current base, with
  the same guidance version 2 gives a needs-input resume. A review that
  stopped with its PR marked ready resumes as review.
- **A gate**: with a gate label on the issue or its PR, review stops at
  ready-to-merge and moves the issue to the owner state. Once no gate label
  remains on either, the factory claims the issue again and restarts review to
  merge, without waiting for the ready state. An unreadable gate read keeps it
  waiting.

Version 3 has no needs-input label: the state labels name who must act.

### Label roles

Every label the factory reads or writes is a role, declared once in
`src/label-roles.ts` with the versions that name it, whether only the factory
writes it, what it excludes and how the factory's transitions change it.

| Role                                            | Versions | Writer                                       | Meaning                                                               |
| ----------------------------------------------- | -------- | -------------------------------------------- | --------------------------------------------------------------------- |
| `triage`, `reporter`, `grill`, `owner`          | 3        | People and runs                              | Stops: the issue waits on triage, its reporter, a grill or the owner. |
| `ready`                                         | 2, 3     | People, or the factory's triage run          | Accepted readiness; the issue-contract validator decides its changes. |
| `ownerReview`, `majorRelease`                   | 3        | The owner                                    | Gates that stop review at ready-to-merge.                             |
| `running` (`0052cc`)                            | 2, 3     | The factory                                  | A run holds the issue.                                                |
| `failed` (`b60205`)                             | 2, 3     | The factory                                  | The run failed for good; remove it to run again.                      |
| `paused` (`c5def5`)                             | 2, 3     | The factory                                  | The factory paused the run and resumes it by itself.                  |
| `needsInput` (`fbca04`)                         | 2        | Agents; the factory provisions and clears it | Version 2's stop.                                                     |
| `skip`, `hold`, `releaseHold`                   | 2, 3     | The repository                               | Delivery outside the factory and the repository's holds, as below.    |
| `priorityHigh`, `priorityNormal`, `priorityLow` | 3        | People and runs                              | Pickup order: high, normal (also no label), then low.                 |

The factory creates or updates only the labels it writes, with the colours
above, on every pass. Priority uses the configured label names; an omitted
priority role names no label. Within a priority, pickup keeps its order by issue
creation time, repository name and issue number. Priority never overrides a
gate, hold or readiness requirement.

### Triage readiness

The factory accepts readiness only from a person, except, with
`runKinds.triage` on, readiness the factory's own triage run applied. That readiness counts when its latest
application is by `triageResult.author`, and the validator's current result
approves it with, as its contract source, a comment by that account that names
the triage run on exactly one `triageResult.marker` line. A result by another
account, another marker, a line naming no run or two, or a result made stale
by a later change grants no readiness. The contract result's other checks
still apply.

### Migrating from version 2

Upgrade the host to Scriptorium v4.0.0 or later while keeping valid version 2
configurations unchanged. Then migrate each repository independently, while
version 2 remains in the host's compatibility window.

Set `version` to `3`, and move `skill` and `arguments` into
`runKinds.implement`. Replace `labels.needsInput` with the state labels the
repository uses for its stops, and add `labels.triage` and `runKinds.triage`
or `runKinds.review` to turn those kinds on. An open question labelled with
the old needs-input label is no longer a stop for the factory: move it to the
matching state first. Keep model choices in the host's defaults or opt into the
repository's version 3 model policy. Preserve the repository's label mappings,
model-label prefix, validator identity and comment templates as appropriate;
the host supplies none of those conventions during migration.

## Version 2

The fields in this example are required. `labels.skip`, `labels.releaseHold`, `labels.hold`, `comments` and its
individual entries are optional. Unknown fields at any level and malformed
values are invalid.

```json
{
  "version": 2,
  "labels": {
    "ready": "queued",
    "running": "working",
    "failed": "broken",
    "needsInput": "question",
    "paused": "waiting"
  },
  "contractResult": {
    "marker": "contract:result",
    "author": "validator[bot]"
  },
  "modelLabelPrefix": "agent:",
  "skill": "ship",
  "arguments": "#{issue}"
}
```

| Field                   | Value                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`               | Numeric `2`, the factory configuration schema version.                                                                                          |
| `labels.ready`          | The repository's ready label. The repository creates it; the factory never creates, adds or removes it.                                         |
| `labels.running`        | The label the factory adds when it claims an issue and removes when it releases, pauses or fails the claim.                                     |
| `labels.failed`         | The label the factory adds after a final failure. Remove it to allow another run.                                                               |
| `labels.needsInput`     | The label an agent adds when it needs an answer. After answering, remove it to allow a fresh first attempt.                                     |
| `labels.paused`         | The label the factory swaps in for the running label when it pauses a run: the factory paused the run and resumes it by itself; leave it alone. |
| `labels.skip`           | Optional repository-owned label that prevents pickup for a new run. The factory never creates, adds, removes or recolours it.                   |
| `labels.releaseHold`    | Optional repository-owned label on open release PRs that holds merges in this repository. The factory never creates or changes it.              |
| `labels.hold`           | Optional repository-owned label on open issues or PRs that pauses the factory in this repository. The factory never creates or changes it.      |
| `contractResult.marker` | The marker of the issue-contract validator's state line, `<!-- <marker> {…} -->`. See [contract result](#contract-result).                      |
| `contractResult.author` | The account the validator posts its result as. A marked comment by any other account is not a result.                                           |
| `modelLabelPrefix`      | The prefix of model labels. With this example, `agent:gpt-5.5@high` resolves against the host's configured provider registry.                   |
| `skill`                 | The skill name as a non-empty trimmed string, without the provider's invocation prefix.                                                         |
| `arguments`             | A string of skill arguments. Every `{issue}` expands to the issue number; other text and whitespace are preserved. An empty string is valid.    |
| `comments`              | Optional object with optional `pause`, `failure`, `close` and `awaitingMerge` comment templates. Each supplied entry is a non-empty string.     |

Version 1 configurations, the old `prompt` field, and version 2
configurations without `contractResult` are refused, each with the fields at
fault. Migrate by setting `version` to `2`, replacing `prompt` with `skill`
and `arguments`, removing `{skillPrefix}`, since the provider owns the
invocation syntax, and adding `contractResult`. Version 1 is outside the
compatibility window. For example, `"prompt": "{skillPrefix}ship #{issue}"` becomes
`"skill": "ship", "arguments": "#{issue}"`.

Label names and the model label prefix must be non-empty strings without
leading or trailing whitespace. All configured label names, including the
optional skip, release-hold and hold labels, must be distinct, ignoring case, so a state label can
never write readiness or the skip label. The factory creates
or updates the four state labels (running, failed, needs input and paused) with
its state descriptions and colors on every pass, leaving the ready, skip, release-hold
and hold labels to the repository.

When `labels.skip` is configured, a ready issue carrying that label is not
picked up for a new run, including a fresh attempt after the failed or needs
input label is removed. For example, `"skip": "manual-delivery"` produces the
skip reason ``labelled `manual-delivery`; delivered outside the factory`` in
status and logs. Removing the skip label returns the issue to the frontier on
the next pass under the usual rules. Adding it to an existing run does not
stop or change that run, its retry, or its resumption after a pause. Omitting
`labels.skip` leaves pickup unchanged.

When `labels.releaseHold` is set, every pass reads the numbers of open PRs
carrying that label through Postern's authenticated GraphQL transport. Closed
and merged PRs do not hold, and a labelled PR never holds itself. For example,
`"releaseHold": "factory:release-hold"` holds merge relaunches while another
open PR carries `factory:release-hold`; an unreadable hold also makes merge
relaunches wait for a successful read. Other repositories continue normally.
Omitting the key leaves behavior unchanged and keeps the configuration's version.

This holds merges only. Pickup, retries, interrupted and paused relaunches,
and needs-input resumes still proceed under their usual gates. Every run's
prompt names the label and directs the agent to check for another open labelled
PR before any merge. While held, it finishes implementation, validation and
review, leaves its PR open, and ends its run. The prompt alone cannot enforce
a release PR opened mid-run: installed babysit's merge check from
[Repo Canon #742](https://github.com/lutzseverino/repo-canon/issues/742) supplies
that guard and returns its release-hold exit without merging. That companion
change is required for the mid-run guard; this host change does not install it.

A run remembers a hold observed during its execution across passes and
restarts, even if the hold clears before settlement. An unreadable hold at
settlement conservatively marks its open run-owned PR release-held too. Once a
successful read finds no other labelled PR, that PR gets one merge relaunch,
even when current with the default branch, under every other merge-relaunch
eligibility and launch gate. A merge relaunch ended by a hold leaves its head
unconsumed. PRs awaiting merge before the hold acquire no release-held mark;
ordinary stale-base recovery still handles them. See
[merge relaunches](host.md#merge-relaunches) for ownership and handoff rules.

Each release-held issue, or issue whose merge relaunch waits for a hold, has
one release-hold comment. It names the other labelled PRs, updates in place as
the set changes, and is marked resolved when the last one closes or loses the
label. An unreadable set is reported as unreadable, without inventing PR
numbers. Comments remain single across passes and restarts.

The state labels say what a person must do. Running means the factory is
working on the issue. Failed means it is stopped until a person acts, whether
the agent's failure note or the factory's own report says why. Needs input
means a person answers the question. Paused means nobody acts: the factory
paused the run and resumes it by itself; see
[paused runs](host.md#paused-runs).

The host's default model applies when an issue has no model label. Multiple
model labels, an unknown provider or model, and an unsupported effort hold
that issue with a reason; see the [provider grammar](host.md#providers).

## Contract result

`contractResult` names where the repository's issue-contract validator posts
its decision, which the factory reads instead of interpreting implementation
contracts; see [readiness](host.md#readiness). Both fields are required, with
no default. A Repo Canon adopter uses its validator's values:

```json
"contractResult": {
  "marker": "repo-canon:issue-contract-state",
  "author": "github-actions[bot]"
}
```

The result is the latest comment by `author`, ignoring case, with a line
`<!-- <marker> {…} -->` whose JSON object is in format
`repo-canon/issue-contract-state/v1`. The factory reads `format`, `status`,
`label`, `reviewEventId` and `source`, and checks them against the issue's
platform facts. A result in another format, including an earlier line without
`format`, holds the issue with a hold comment until the validator and the
factory share a format.

## Factory hold

When `labels.hold` is set, a person can pause the factory in this repository:
while any open issue or PR carries the label, new pickups and merges stop, and
runs already started finish. Every pass reads the numbers of open issues and
PRs carrying it through Postern's authenticated GraphQL transport, as it reads
the release hold. Repo Canon's configuration sets `"hold": "factory:hold"`.

While the hold is set, the repository is paused as a
[repository pause](host.md#repository-pauses) pauses it, and other
repositories continue normally. The factory claims and launches nothing there:
no new claim, retry, interrupted or paused relaunch, needs-input resume or
merge relaunch starts. Runs whose sandboxes are already running finish, and
ended runs keep settling. A labelled PR never holds its own merge: a merge
relaunch whose target PR is the only open item carrying the label still
launches, including an interrupted or paused merge relaunch, so the change
that needs the pause can carry the label and merge, which ends the hold. An
unreadable hold holds the repository for that pass, and the hold ends only
once a successful read finds no labelled issue or PR. Removing the label, or
closing what carries it, resumes pickup and merging on the next pass. Omitting
the key leaves behavior unchanged and keeps the configuration's version.

Every run's prompt names the label and directs the agent to check for open
issues and PRs carrying it, other than its own PR, before any merge. While the
label is set, it finishes implementation, validation and review, leaves its PR
open, and ends its run without merging. The prompt alone cannot stop a merge
already under way: installed babysit's merge check from
[Repo Canon #789](https://github.com/lutzseverino/repo-canon/issues/789)
supplies the mid-run guard. That companion change is required for the mid-run
guard; this host change does not install it.

A run that observes the hold while it runs records it as it records a
release hold: it remembers the labelled items across passes and restarts, even
if the hold clears before settlement, and an unreadable hold at settlement
marks its open run-owned PR held too. Once the hold ends, that PR
gets one merge relaunch, even when current with the default branch, under
every other merge-relaunch eligibility and launch gate.

Each held issue has one factory-hold comment stating the reason, under its own
hold key, distinct from the configuration pause's. It names the labelled
issues and PRs, or says the hold is unreadable, updates in place as the set
changes, and is marked resolved when the hold ends. The status file reports
the repository as `paused` with the hold's reason while it holds new pickups.

## Skill invocations and retries

For the example above, issue 4 starts with `/ship #4` on Claude Code or
`$ship #4` on Codex. The host substitutes `{issue}` in `arguments`, and each
provider adapter renders the skill invocation in its own syntax. The factory
appends its unattended execution guidance, including the release-hold and
factory-hold instructions when configured, after that invocation. A retry uses the current invocation
followed by the factory's fixed context block: the first attempt's failure and, when
readable, the end of its log (at most 200 lines and 16 KiB). The branch
`factory/issue-<n>`, retry context and `.factory/Dockerfile` path are fixed by
the factory.

## Comment templates

The factory writes four issue comments deterministically, without an agent,
prompt or provider usage. Add `comments` to the required configuration to
replace any of their wording. This optional example changes only the pause
comment and keeps the default failure, parent-close and awaiting-merge comments:

```json
{
  "version": 2,
  "labels": {
    "ready": "queued",
    "running": "working",
    "failed": "broken",
    "needsInput": "question",
    "paused": "waiting"
  },
  "modelLabelPrefix": "agent:",
  "skill": "ship",
  "arguments": "#{issue}",
  "comments": {
    "pause": "Waiting for {provider}: {cause}.{#reset} Resets {reset}.{/reset}{#threshold} Threshold: {threshold}%.{/threshold} The factory will remove `{label}` when it resumes."
  }
}
```

Omitting `comments`, supplying `"comments": {}`, or omitting an individual
entry uses the relevant default. Version remains `2`; there is no host
setting. Supplied entries must be non-empty JSON strings; whitespace and
newlines are preserved. Encode a newline as `\n` in JSON. No placeholder is
required, so a fixed comment is valid. No disclaimer is injected; put any
repository-required disclaimer in each template.

The language has exactly three forms, with case-sensitive, letter-only names
(`A`–`Z` and `a`–`z`):

- `{name}` inserts that fact. Missing or empty facts insert nothing.
- `{#name}…{/name}` renders the block when the fact exists. A scalar renders
  it once; a list renders it once per item, in order. Within a list section,
  `{name}` inserts the current item. Other facts remain available, and sections
  may nest. An empty list renders no block. A numeric zero is present.
- Every other brace is literal text, including `{ "a": 1 }`, `{}` and
  `{model_name}`. There is no escape syntax: `{{provider}}` renders a literal
  brace around the provider value, and a backslash does not escape a token.

A list inserted directly with `{name}` joins its items with newlines; use a
section to supply per-item formatting. Inserted values are text, never parsed
as more template syntax. These are the only names for each comment:

| Comment         | Names                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `pause`         | `provider`, `model`, `effort`, `attempt`, `cause`, `reset`, `threshold`, `label`                     |
| `failure`       | `failure`, `provider`, `model`, `effort`, `attempt`, `log`, `unpushable`, `unpushableCount`, `label` |
| `close`         | `tickets`                                                                                            |
| `awaitingMerge` | `provider`, `model`, `effort`, `attempt`, `log`, `label`                                             |

`label` is the configured paused, failed or running label for `pause`,
`failure` or `awaitingMerge`, respectively. `cause` and
`failure` remain factory-written English phrases. `threshold` is the numeric
pause threshold only for a pause at that threshold; it is empty for an actual
usage-limit pause. `reset` and `log` are empty when absent. A failed claim
without a run has no provider, model, effort, attempt or log. Their sections
do not render. `unpushable` is the list of paths the factory cannot push, and
`unpushableCount` is their number, present only when at least one path exists.
`tickets` contains closed-ticket references such as `#4` or `owner/repo#4`.
For `awaitingMerge`, provider, model, effort, attempt and log describe the ended
run. A label-only orphan claim has none of those facts; their sections do not
render. The notice means the claim is retained without a live agent until the
owner resolves its open pull request. Removing a state label alone does not
resume an unsettled host run, and merging need not close the issue. See the
[run outcomes and recovery rules](host.md#run-outcomes).

Every supplied template is validated when configuration is read, before any
comment is needed. An unknown name in any of the three syntax forms, including
a name belonging to a different comment, or an unbalanced/mismatched section
invalidates configuration even inside a section that would render nothing.
Malformed `comments` objects, empty or non-string entries and unknown fields
also invalidate it. Invalid templates use the repository pause and recovery
behavior below; they do not fail an individual run or post an issue pause
comment. Existing pause-comment single delivery and label transitions remain
the same, including after restart. The retry context and agent-written comments
are separate interfaces.

### Default templates

These are the complete default strings in JSON form, with `\n` denoting each
newline. Defaults and overrides go through the same renderer.

Pause:

```json
"The factory paused this run: {provider} {cause}{#reset}, resets {reset}{/reset}.\n\n- Model: `{provider}/{model}@{effort}`, attempt {attempt}\n\nThe factory resumes the run by itself and removes `{label}` when it does; nobody needs to act."
```

Failure:

```json
"The factory run failed: {failure}.\n\n{#provider}- Model: `{provider}/{model}@{effort}`, attempt {attempt}\n{/provider}{#log}- Log: `{log}` on the factory host\n{/log}{#provider}\n{/provider}{#unpushable}- Unpushable: `{unpushable}`\n{/unpushable}{#unpushableCount}\nA person with permission to push these paths must deliver the change.\n\n{/unpushableCount}Remove `{label}` to let the factory pick this issue up again."
```

Awaiting merge:

```json
"The factory agent run has ended, but its pull request remains open.\n\n{#provider}- Model: `{provider}/{model}@{effort}`, attempt {attempt}\n{/provider}{#log}- Log: `{log}` on the factory host\n{/log}{#provider}\n{/provider}The factory retains this issue's claim without a live agent. The owner must resolve the pull request by merging or closing it; the factory will continue observing the outcome under its existing rules. Removing `{label}` alone does not resume the run, and merging the pull request does not always close the issue."
```

Parent close:

```json
"All sub-issues are closed. Closing this parent.\n{#tickets}\n- {tickets}{/tickets}"
```

## Repository pause and recovery

Missing, unreadable, non-JSON or invalid configuration pauses only that
repository. A missing Dockerfile also pauses it. The factory claims and
launches nothing there, keeps settling existing runs using the last valid
configuration, and continues serving the other repositories. Run records retain
configuration for interrupted runs recovered after a restart. A later valid
configuration resumes pickup on the next pass. Without a valid configuration
at startup, the factory cannot identify that repository's labels and makes
no issue writes there. Pause reasons appear in the process log and the
[host status file](host.md#status-file); a repository pause never adds the
paused label or posts on an issue.

Agents can edit `.factory/`, and the factory does not guard it. An operator
who wants it protected uses CODEOWNERS or branch protection.
