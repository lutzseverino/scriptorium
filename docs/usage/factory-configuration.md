# Repository factory configuration

Each repository names its conventions in `.factory/config.json`. The factory
reads it from the repository's default branch on every pass, alongside
`.factory/Dockerfile`. Labels, the model-label prefix and the prompt have no
defaults. Optional comment templates default to the factory's own wording; see
[the ownership decision](../adr/0005-default-the-factorys-own-comment-wording.md).

## Schema

The fields in this example are required. `labels.skip`, `comments` and its
individual entries are optional. Unknown fields at any level, malformed
values and versions other than numeric `1` are invalid.

```json
{
  "version": 1,
  "labels": {
    "ready": "queued",
    "running": "working",
    "failed": "broken",
    "needsInput": "question",
    "paused": "waiting"
  },
  "modelLabelPrefix": "agent:",
  "prompt": "{skillPrefix}ship #{issue}"
}
```

| Field               | Value                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`           | Numeric `1`, the factory configuration schema version.                                                                                          |
| `labels.ready`      | The repository's ready label. The repository creates it; the factory never creates, adds or removes it.                                         |
| `labels.running`    | The label the factory adds when it claims an issue and removes when it releases, pauses or fails the claim.                                     |
| `labels.failed`     | The label the factory adds after a final failure. Remove it to allow another run.                                                               |
| `labels.needsInput` | The label an agent adds when it needs an answer. After answering, remove it to allow a fresh first attempt.                                     |
| `labels.paused`     | The label the factory swaps in for the running label when it pauses a run: the factory paused the run and resumes it by itself; leave it alone. |
| `labels.skip`       | Optional repository-owned label that prevents pickup for a new run. The factory never creates, adds, removes or recolours it.                  |
| `modelLabelPrefix`  | The prefix of model labels. With this example, `agent:gpt-5.5@high` resolves against the host's configured provider registry.                   |
| `prompt`            | A string containing both `{skillPrefix}` and `{issue}`. Every occurrence expands to the provider's skill prefix and the issue number.           |
| `comments`          | Optional object with optional `pause`, `failure`, `close` and `awaitingMerge` comment templates. Each supplied entry is a non-empty string.                      |

Label names and the model label prefix must be non-empty strings without
leading or trailing whitespace. All configured label names, including the
optional skip label, must be distinct, ignoring case, so a state label can
never write readiness or the skip label. The factory creates
or updates the four state labels (running, failed, needs input and paused) with
its state descriptions and colors on every pass, leaving the ready and skip
labels to the repository.

When `labels.skip` is configured, a ready issue carrying that label is not
picked up for a new run, including a fresh attempt after the failed or needs
input label is removed. For example, `"skip": "manual-delivery"` produces the
skip reason ``labelled `manual-delivery`; delivered outside the factory`` in
status and logs. Removing the skip label returns the issue to the frontier on
the next pass under the usual rules. Adding it to an existing run does not
stop or change that run, its retry, or its resumption after a pause. Omitting
`labels.skip` leaves pickup unchanged.

The state labels say what a person must do. Running means the factory is
working on the issue. Failed means it is stopped until a person acts, whether
the agent's failure note or the factory's own report says why. Needs input
means a person answers the question. Paused means nobody acts: the factory
paused the run and resumes it by itself; see
[paused runs](host.md#paused-runs).

The host's default model applies when an issue has no model label. Multiple
model labels, an unknown provider or model, and an unsupported effort hold
that issue with a reason; see the [provider grammar](host.md#providers).

## Prompts and pauses

For the example above, issue 4 starts with `/ship #4` on Claude Code or
`$ship #4` on Codex. A retry uses the current configured template followed by
the factory's fixed context block: the first attempt's failure and, when
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
  "version": 1,
  "labels": {
    "ready": "queued",
    "running": "working",
    "failed": "broken",
    "needsInput": "question",
    "paused": "waiting"
  },
  "modelLabelPrefix": "agent:",
  "prompt": "{skillPrefix}ship #{issue}",
  "comments": {
    "pause": "Waiting for {provider}: {cause}.{#reset} Resets {reset}.{/reset}{#threshold} Threshold: {threshold}%.{/threshold} The factory will remove `{label}` when it resumes."
  }
}
```

Omitting `comments`, supplying `"comments": {}`, or omitting an individual
entry uses the relevant default. Version remains `1`; there is no host
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

| Comment   | Names                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------- |
| `pause`   | `provider`, `model`, `effort`, `attempt`, `cause`, `reset`, `threshold`, `label`                     |
| `failure` | `failure`, `provider`, `model`, `effort`, `attempt`, `log`, `unpushable`, `unpushableCount`, `label` |
| `close`   | `tickets`                                                                                            |
| `awaitingMerge` | `provider`, `model`, `effort`, `attempt`, `log`, `label` |

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
