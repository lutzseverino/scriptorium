# Repository factory configuration

Each repository names its conventions in `.factory/config.json`. The factory
reads it from the repository's default branch on every pass, alongside
`.factory/Dockerfile`. No repository convention has a default.

## Schema

Every field below is required. Unknown fields at either level, malformed
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
| `modelLabelPrefix`  | The prefix of model labels. With this example, `agent:gpt-5.5@high` resolves against the host's configured provider registry.                   |
| `prompt`            | A string containing both `{skillPrefix}` and `{issue}`. Every occurrence expands to the provider's skill prefix and the issue number.           |

Label names and the model label prefix must be non-empty strings without
leading or trailing whitespace. The five label names must be distinct,
ignoring case, so a state label can never write readiness. The factory creates
or updates the four state labels (running, failed, needs input and paused) with
its state descriptions and colors on every pass, leaving the ready label to the
repository.

The state labels say what a person must do. Running means the factory is
working on the issue. Failed means it is stopped until a person acts, whether
the agent's failure note or the factory's own report says why. Needs input
means a person answers the question. Paused means nobody acts: the factory
paused the run and resumes it by itself; see
[paused runs](host.md#paused-runs).

The host's default model applies when an issue has no model label. Multiple
model labels, an unknown provider or model, and an unsupported effort hold
that issue with a reason; see the [provider grammar](../../README.md#providers).

## Prompts and pauses

For the example above, issue 4 starts with `/ship #4` on Claude Code or
`$ship #4` on Codex. A retry uses the current configured template followed by
the factory's fixed context block: the first attempt's failure and, when
readable, the end of its log (at most 200 lines and 16 KiB). The branch
`factory/issue-<n>`, retry context and `.factory/Dockerfile` path are fixed by
the factory.

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
