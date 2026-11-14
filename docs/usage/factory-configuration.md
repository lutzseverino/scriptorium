# Repository factory configuration

Each repository names its conventions in `.scriptorium/config.json`. The factory
reads it from the repository's default branch on every pass, alongside
`.scriptorium/Dockerfile`. Labels, the contract result, the model-label prefix,
the skills and their arguments have no defaults. Optional comment templates default to the factory's own wording; see
[the ownership decision](../adr/0005-default-the-factorys-own-comment-wording.md)
and [ADR 0008](../adr/0008-split-work-into-run-kinds-handed-off-by-the-host.md),
which replaced its per-comment templates with the run and action comments.

Version 3 maps up to three [run kinds](#run-kinds) to skills; version 2 runs
one implement skill. Each version is validated against its own contract,
described below, and every other version is refused.

## Repository layout and schema

Scriptorium v4.0.0 immediately renames the repository input directory to
`.scriptorium/`. Move `config.json` and `Dockerfile` there before using this
host release. It reads only those canonical inputs; a legacy directory supplies
neither file, even when a canonical file is missing or invalid. Missing,
unreadable or invalid configuration, a missing Dockerfile or an image-build
failure pauses pickup with a diagnostic naming the canonical input. The
configured label names, `factory` and `factory-workflow` keep their names.

Both supported versions accept an optional `$schema` string for editor
validation and documentation discovery. Add this line at the start of either
configuration example below:

```json
"$schema": "https://raw.githubusercontent.com/lutzseverino/scriptorium/scriptorium-v4.1.2/schemas/factory-configuration.schema.json"
```

The public schema is pinned to the shipping release; its description links
that same tag's configuration and sandbox-image documentation. The host
accepts a non-empty trimmed string as metadata without fetching it or changing
the selected version's behavior. Every other field retains its version's
validation. The schema checks structure; the host additionally checks label
uniqueness ignoring case and balanced, known comment-template names.

The directory change applies to both configuration versions and is separate
from their compatibility window. Repo Canon's producer migration follows the
Scriptorium v4.0.0 release; changing its installers or consumer files is a
separate change.

## Compatibility window

Scriptorium reads the current factory configuration version N and the previous
version N−1. Initially N is 3 and N−1 is 2. One host can serve repositories on
both versions, so upgrading the host and adopting a new Repo Canon configuration
need no synchronized switch. Upgrade the host before adopting a configuration
it does not yet support; older hosts need not accept newer configurations.

Version 2 keeps its single implement invocation, configured labels (including
`needsInput`), model-label prefix, contract-result identity and optional settings.
It acquires no triage or review run, state label requirement or repository model
policy from the host upgrade. Both versions share the
[comment templates](#comment-templates), which Scriptorium v4 changed for both.
Version 3 uses the run kinds and optional model policy described below. Neither version accepts unknown or malformed fields;
versions outside the two-version window are refused rather than converted.

## Version 3

The fields in this example are required; `runKinds.triage`,
`runKinds.review`, `triageResult`, `comments` and every label but `ready`,
`running`, `paused` and `failed` are optional. Unknown fields at any level and
malformed values are invalid.

```json
{
  "$schema": "https://raw.githubusercontent.com/lutzseverino/scriptorium/scriptorium-v4.1.2/schemas/factory-configuration.schema.json",
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
  "$schema": "https://raw.githubusercontent.com/lutzseverino/scriptorium/scriptorium-v4.1.2/schemas/factory-configuration.schema.json",
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
guidance, with a sandbox token narrowed to the kind's fixed
[permissions](host.md#run-kind-token-permissions), which no configuration
changes; a triage run and a review run log beside implement's, as
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
  keep an opening from overriding an existing handoff or stop. Its
  [run result](#run-results) asks for readiness with its brief, or a stop with
  its question; without a result, a run that timed out or was orphaned ends
  once the issue leaves the triage state, and fails when it never did.
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
  while the run comment shows the review. It also claims an open draft PR whose
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
- **A stop**: a run whose result stops in the reporter, grill or owner state,
  or that ends with the issue in the triage, reporter, grill or owner state,
  releases its claim and leaves the issue there. Returning the
  issue to `labels.ready` resumes the same work and PR on a current base, with
  the same guidance version 2 gives a needs-input resume. A review that
  stopped with its PR marked ready resumes as review.
- **A gate**: with a gate label on the issue or its PR, review stops at
  ready-to-merge and moves the issue to the owner state. Once no gate label
  remains on either, the factory claims the issue again and restarts review to
  merge, without waiting for the ready state. An unreadable gate read keeps it
  waiting.

Version 3 has no needs-input label: the state labels name who must act.

### Run results

Every run ends with a [run result](host.md#run-results), which the host posts
in the factory's frame and turns into labels. A result's `state` is fixed by
its kind and outcome. Its other labels come from the families its kind's
`resultLabels` lists: label-name prefixes, compared ignoring case, such as
`"type:"` or `"priority:"`, or a whole label such as `"factory:skip"`. Without
`resultLabels` a kind's results ask for no other label, and version 2 has
none. A label that a role gives factory mechanics, such as running, failed,
paused, a stop, a gate, readiness or a hold, is refused whatever the family;
the `skip` and priority roles may be requested.

```json
"triage": {
  "skill": "triage",
  "arguments": "#{issue}",
  "resultLabels": ["type:", "model:", "priority:", "factory:skip"]
}
```

`resultLabels` is an optional array of distinct, non-empty trimmed strings on
any run kind.

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
| `skip`                                          | 2, 3     | The repository, or a run's result            | Delivery outside the factory, as below.                               |
| `hold`, `releaseHold`                           | 2, 3     | The repository                               | The repository's holds, as below.                                     |
| `priorityHigh`, `priorityNormal`, `priorityLow` | 3        | People, or a run's result                    | Pickup order: high, normal (also no label), then low.                 |

The factory creates or updates only the labels it writes, with the colours
above, on every pass. Priority uses the configured label names; an omitted
priority role names no label. Within a priority, pickup keeps its order by issue
creation time, repository name and issue number. Priority never overrides a
gate, hold or readiness requirement.

### Triage readiness

The factory accepts readiness only from a person, except, with
`runKinds.triage` on, readiness the factory's own triage run applied. That readiness counts when its latest
application is by `triageResult.author`, and the validator's current result
approves that event and verifies its factory proof. In legacy mode, the selected
comment by that account names the triage run on exactly one
`triageResult.marker` line. In body mode, the validator binds the exact body
revision to a separate configured-author attestation and preserved independent
intake provenance; the host checks those referenced platform facts.
See [body-backed triage contracts](body-contracts.md). A result by another
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
  "$schema": "https://raw.githubusercontent.com/lutzseverino/scriptorium/scriptorium-v4.1.2/schemas/factory-configuration.schema.json",
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
| `comments`              | Optional object with optional `run`, `action` and `close` comment templates. Each supplied entry is a non-empty string.                         |

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
and needs-input resumes still proceed under their usual gates. A launch prompt
carries the host's observed hold facts, such as `release-hold: active: #80`,
or `release-hold: unreadable`. Every PR the run owns is excluded. The configured
skill and installed repository rules decide how to handle those facts and
check for holds opened mid-run; the prompt prescribes no merge policy.

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
`repo-canon/issue-contract-state/v1`, `repo-canon/issue-contract-state/v2` or
`repo-canon/issue-contract-state/v3`. V3 is a Seams exemption wrapper validated
by Repo Canon's installed result reader and follows its v1 or v2 base's rules.
The exemption is historical evidence, never authorization for readiness.
The factory reads readiness, selected source and current-event approval. V2
also binds the repository's explicit cutoff, exact observation and verified
factory association; the host checks their platform identities without parsing
contract Markdown. [Body-backed triage contracts](body-contracts.md) explains
publication mode, automatic freshness reevaluation and migration recovery. A result in another format, including an earlier line without
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

Launch prompts carry shared hold facts, such as `factory-hold: active: #9`
or `factory-hold: unreadable`, when applicable. The configured skill and
installed repository rules own hold handling during a run and at merge time.
The host's launch-time facts cannot enforce a hold opened mid-run.

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
`factory/issue-<n>`, retry context and `.scriptorium/Dockerfile` path are fixed by
the factory.

## Comment templates

The factory writes its issue comments deterministically, without an agent,
prompt or provider usage, as [run comments](host.md#run-comments) describe:
one run comment per pass through the pipeline, edited in place, a fresh
action comment when a person must act, and a parent's close comment. Add
`comments` to the required configuration to replace any of their wording.
This optional example changes only the action comment and keeps the default
run and parent-close comments:

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
    "action": "{#failed}Failed: {reason}. Remove `{failed}` to retry.{/failed}{#stopped}Waiting in `{stopped}`.{/stopped}{#gate}Gated by {gate}.{/gate} [Run]({link})"
  }
}
```

Omitting `comments`, supplying `"comments": {}`, or omitting an individual
entry uses the relevant default, in either version. Supplied entries must be
non-empty JSON strings; whitespace and newlines are preserved. Encode a
newline as `\n` in JSON. No placeholder is required, so a fixed comment is
valid. No disclaimer is injected; put any repository-required disclaimer in
each template. Scriptorium v4 replaced the `pause`, `failure` and
`awaitingMerge` templates with `run` and `action`, and refuses the old names
in both versions: remove them, or move their wording to the new templates.

A [run result](host.md#run-results)'s frame is not a template: it starts with
`comments.disclaimer`, `> _This was generated by AI._` when absent, or for a
triage run with `comments.triageDisclaimer`,
`> *This was generated by AI during triage.*` when absent, the variant an
Agent Brief comment starts with. Both are optional non-empty trimmed strings
in either version.

The language has exactly three forms, with case-sensitive, letter-only names
(`A`–`Z` and `a`–`z`):

- `{name}` inserts that fact. Missing or empty facts insert nothing.
- `{#name}…{/name}` renders the block when the fact exists. A scalar renders
  it once; a list renders it once per item, in order; a phase renders it once
  with the phase's facts in scope. Within a list section, `{name}` inserts the
  current item. Other facts remain available, and sections may nest. An empty
  list renders no block. A numeric zero is present.
- Every other brace is literal text, including `{ "a": 1 }`, `{}` and
  `{model_name}`. There is no escape syntax: `{{provider}}` renders a literal
  brace around the provider value, and a backslash does not escape a token.

A list inserted directly with `{name}` joins its items with newlines, and a
phase inserted directly inserts nothing; use a section to supply per-item or
per-phase formatting. Inserted values are text, never parsed as more template
syntax. These are the only names for each comment:

| Comment  | Names                                                                                                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`    | `status`, `triage`, `implement`, `review`, `merge`, `result`, and within a phase `check`, `state`, `reason`, `reset`, `provider`, `model`, `effort`, `attempt`, `round`, `link`, `unpushable` |
| `action` | `failed`, `stopped`, `gate`, `reason`, `unpushable`, `link`                                                                                                                                   |
| `close`  | `tickets`                                                                                                                                                                                     |

For `run`, `status` is the pass's state: `in progress`, `paused`,
`waiting for an answer`, `awaiting merge`, `merged` or `failed`. Each phase,
`triage`, `implement`, `review` and `merge`, is present while it shows:
implement and merge always, review once the repository turns it on, and
triage once it ran in the pass. Within a phase, `check` is `x` once it is
done or merged and a space otherwise; `state` is `running`, `paused`, `done`,
`stopped`, `failed`, `awaiting merge` or `merged`, empty before it starts;
`reason` is the pause's cause, the failure, why the run ended while its pull
request awaits merge, or the state label a stop waits in; and `reset` is the
pause's reset. `provider`, `model`, `effort`, `attempt` and `round` are the
facts of the phase's latest run, `round` only for review and its hand-backs;
`link` is its run result's comment; and `unpushable` lists the paths the
factory cannot push. A merge phase has run facts only for a merge relaunch.
`result` is the latest run result's body, contained as the result's own
comment contains it, between two marker lines the factory reads back on its
next edit; it is empty before any run left one, and is best inserted once.
`cause`, `failure` and the other reasons remain factory-written English
phrases.

For `action`, exactly one of `failed`, `stopped` and `gate` is present, the
occasion's label: the failed label, the stop state that waits on a person, or
the gate labels review stopped at. `reason` is the failure, and `unpushable`
the code-formatted unpushable paths of a failure, joined with commas, present
only when at least one exists. `link` is the run comment's URL. `tickets`
contains closed-ticket references such as `#4` or `owner/repo#4`.

Every supplied template is validated when configuration is read, before any
comment is needed. An unknown name in any of the three syntax forms, including
a name belonging to a different comment, or an unbalanced/mismatched section
invalidates configuration even inside a section that would render nothing.
Malformed `comments` objects, empty or non-string entries and unknown fields,
including the replaced `pause`, `failure` and `awaitingMerge`, also invalidate
it. Invalid templates use the repository pause and recovery behavior below;
they do not fail an individual run or post an issue comment. The retry context
and agent-written comments are separate interfaces.

### Default templates

These are the complete default strings in JSON form, with `\n` denoting each
newline. Defaults and overrides go through the same renderer. The run
comment's four phase sections differ only in their names and titles.

Run:

```json
"**Factory run: {status}**\n\n{#triage}- [{check}] Triage{#state}: {state}{/state}{#reason} ({reason}{#reset}, resets {reset}{/reset}){/reason}{#provider} · `{provider}/{model}@{effort}`, attempt {attempt}{#round}, round {round}{/round}{/provider}{#link} · [result]({link}){/link}\n{#unpushable}  - Unpushable: `{unpushable}`\n{/unpushable}{/triage}{#implement}- [{check}] Implement{#state}: {state}{/state}{#reason} ({reason}{#reset}, resets {reset}{/reset}){/reason}{#provider} · `{provider}/{model}@{effort}`, attempt {attempt}{#round}, round {round}{/round}{/provider}{#link} · [result]({link}){/link}\n{#unpushable}  - Unpushable: `{unpushable}`\n{/unpushable}{/implement}{#review}- [{check}] Review{#state}: {state}{/state}{#reason} ({reason}{#reset}, resets {reset}{/reset}){/reason}{#provider} · `{provider}/{model}@{effort}`, attempt {attempt}{#round}, round {round}{/round}{/provider}{#link} · [result]({link}){/link}\n{#unpushable}  - Unpushable: `{unpushable}`\n{/unpushable}{/review}{#merge}- [{check}] Merge{#state}: {state}{/state}{#reason} ({reason}{#reset}, resets {reset}{/reset}){/reason}{#provider} · `{provider}/{model}@{effort}`, attempt {attempt}{#round}, round {round}{/round}{/provider}{#link} · [result]({link}){/link}\n{#unpushable}  - Unpushable: `{unpushable}`\n{/unpushable}{/merge}{#result}\n<details>\n<summary>Latest run result</summary>\n\n{result}\n\n</details>\n{/result}"
```

Action:

```json
"{#failed}The factory run failed: {reason}.{#unpushable} A person with permission to push {unpushable} must deliver the change.{/unpushable} Remove `{failed}` to run it again.{/failed}{#stopped}The factory waits in `{stopped}` for an answer.{/stopped}{#gate}Review stopped at a gate ({gate}); remove it from the issue and its pull request to merge.{/gate} See [the run comment]({link})."
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

Agents can edit `.scriptorium/`, and the factory does not guard it. An operator
who wants it protected uses CODEOWNERS or branch protection.
