# Host installation and configuration

One factory process serves every repository its host configuration lists. It
reads each repository from GitHub, keeps a clone of it, launches agents in
sandboxes built from the repository's toolchain image, and records what it is
doing in a status file. Every repository shares one oldest-first queue, and
provider caps and usage gates apply across all of them.

## Install and start

The owner must set up the `scriptorium-v*` tag ruleset before the first host
installation, as the [release procedure](../development/release.md) describes.
Check out a Scriptorium release tag (`scriptorium-vX.Y.Z`), then from its
`factory/` directory install the runtime dependencies and start the process
with the host configuration's path:

```sh
npm ci --omit=dev
node src/main.ts /etc/factory/host.json
```

The process needs Node.js 24, Git, the GitHub CLI and Docker on its `PATH`, and
runs until it is stopped; [restarts](#restarts) describes stopping it. It builds
sandbox images with its own user's UID and GID. An unreadable, malformed or invalid host configuration stops it at start
with every problem named. The host keeps its own service setup: the service
definition and its `PATH`, the provider credential files, and the host
configuration itself.

## Host configuration

The host configuration is one JSON file. Every field is required, an unknown
field is refused, and nothing comes from environment variables.

```json
{
  "repositories": ["acme/widgets", "acme/gadgets"],
  "providers": {
    "claude-code": { "cap": 2, "credential": "/etc/factory/claude-token" },
    "codex": { "cap": 1, "credential": "/etc/factory/codex-auth.json" }
  },
  "models": {
    "default": "claude-sonnet-5-5",
    "retry": "claude-opus-5-5@xhigh"
  },
  "timeLimitMinutes": 240,
  "usageThreshold": 80,
  "pollSeconds": 300,
  "readiness": { "authorizedRoles": ["admin", "maintain"] },
  "unpushablePaths": [".github/workflows/"],
  "stateDirectory": "/var/lib/factory",
  "gitIdentity": { "name": "factory[bot]", "email": "factory@example.com" },
  "github": { "tokenCommand": ["/usr/local/bin/factory-token"] }
}
```

| Field                         | Value                                                                                                                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repositories`                | A non-empty list of distinct `<owner>/<name>` GitHub repositories the factory serves.                                                                                                                                   |
| `providers.<name>`            | One entry per provider the host runs, named `claude-code` or `codex`. Only these providers are in the registry.                                                                                                         |
| `providers.<name>.cap`        | The whole number of sandboxes that provider may run at once across every repository.                                                                                                                                    |
| `providers.<name>.credential` | The absolute path of the provider's one credential file: the Claude Code token file from `claude setup-token`, or the Codex login (`auth.json`). It is read at each launch and usage read.                              |
| `models.default`              | The model an issue without a model label runs on.                                                                                                                                                                       |
| `models.retry`                | The model a failed first attempt retries on.                                                                                                                                                                            |
| `timeLimitMinutes`            | How long a run may take before it is stopped, and its sandbox's idle limit.                                                                                                                                             |
| `usageThreshold`              | The provider usage percentage, from 0 to 100, at or above which that provider launches nothing.                                                                                                                         |
| `pollSeconds`                 | The wait between passes.                                                                                                                                                                                                |
| `readiness.authorizedRoles`   | The repository roles whose [readiness](#readiness) the factory accepts: `admin`, `maintain`, `write`, `triage` or `read`.                                                                                               |
| `unpushablePaths`             | Path prefixes inside a repository that the factory's GitHub App can't push, such as `.github/workflows/`. Unpushed commits under these paths fail without a retry, naming the paths; see [run outcomes](#run-outcomes). |
| `stateDirectory`              | The absolute path of the directory the process owns.                                                                                                                                                                    |
| `gitIdentity`                 | The `name` and `email` that commits made from the clones carry.                                                                                                                                                         |
| `github.tokenCommand`         | The executable and leading arguments that print a GitHub token for a repository.                                                                                                                                        |

A model is `<slug>` or `<provider>/<slug>`, optionally followed by
`@<effort>`, and must resolve to a configured provider; the
[package README](../../README.md#providers) describes the grammar.

### Token command

The factory runs `github.tokenCommand` with the repository's `<owner>/<name>`
appended as its last argument. The command must:

- exit 0 and print exactly one token, with no whitespace inside it, on
  standard output, within 60 seconds, after which it is stopped;
- print a token that stays valid for at least 45 minutes after it prints it,
  such as a newly minted GitHub App installation token, which lasts an hour.

The factory caches each repository's token and reuses it for 30 minutes after
the command printed it, then runs the command again. It refreshes a token when
a pass needs it, and every minute, between and during passes, for each
repository with a running sandbox. The token serves the factory's own GitHub
reads and writes, its Git operations in the clone, and the
[sandbox's GitHub access](#sandbox-github-access).

A command that fails, or prints no single token, pauses that repository for
the pass, with the failure as the reason in the process log and the status
file, and the other repositories continue. A running sandbox keeps its last
token, which is still valid, and the factory retries the refresh every minute.
The factory names the failure but never logs the command's output.

## Repository conventions

Each repository names its labels, model label prefix and prompt in
`.factory/config.json`, read from its default branch on every pass. The
[factory configuration schema](factory-configuration.md) documents those
required fields and the repository's ownership of readiness. The factory
knows no repository convention by default.

## Readiness

The factory decides pickup itself from an issue's ready-label events, its
body's last edit, its native GitHub links and its native blockers. It knows no
issue template and reads no issue body.

- **Authorization.** The account that last applied the ready label must hold
  one of `readiness.authorizedRoles` now. The factory reads that account's
  repository role on every pass, once per account and repository. Readiness a
  bot or GitHub App applied never counts. A role it can't read holds the issue
  for that pass.
- **Revision binding.** The ready label must be newer than the issue body's
  last edit, to the second. A title change or a comment doesn't count. After
  reviewing an edit, remove and re-apply the label.
- **Parents.** An open issue with native sub-issues in the same repository is
  a parent, and it never launches. Its sub-issue runs only while the parent's
  readiness counts, is newer than the parent's latest sub-issue link, to the
  second, and the parent has no open native blocker. A native parent that is
  closed or in another repository holds nothing.
- **Closing.** An open issue whose readiness counts, with at least one native
  sub-issue and every sub-issue closed, in any repository, is closed with a
  comment listing them.

Refused readiness is a skip with its reason in the process log and the
[status file](#status-file). The factory never writes the ready label and
never comments about readiness.

## Sandbox GitHub access

At launch the factory writes the repository's token, as GitHub CLI
configuration readable only by the host's user, into a directory of its own
for that run, and mounts the directory read-only at `/run/factory/github`.
The sandbox's environment points the GitHub CLI at that directory
(`GH_CONFIG_DIR`) and makes Git ask the GitHub CLI for its `github.com`
credentials, so neither reads the token from an environment variable. Each
time the repository's token is refreshed, the factory replaces the files
whole, so a run longer than a token's lifetime keeps its GitHub access. The
factory removes the directory when the run's agent exits, so a token outlives
no run.

That installation token is the sandbox agent's only GitHub identity, so a push
the GitHub App can't make stays refused. The provider login a run signs in with
adds none: the image's provider policy turns off ChatGPT apps for Codex and
claude.ai connectors for Claude Code, which could otherwise act as the
account's linked GitHub user. The
[sandbox image contract](sandbox-image.md#factory-agent-layer) gives the
details.

## Redaction

The factory replaces with `<REDACTED>` every token the token command printed
during the process's lifetime, including replaced ones, and every provider
credential value a launch delivered: the Claude Code token, and the Codex
login's API key and tokens. It redacts them from:

- the process log;
- each run's log, which it copies line by line from the raw log Sandcastle
  writes into the run's private directory;
- the status file's reasons.

A restarted process redacts the tokens it printed itself; the earlier
process redacted its own logs as it wrote them.

## State directory

The process owns everything under `stateDirectory`:

| Path                                             | Contents                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status.json`                                    | The status file.                                                                                                                                                                                                                                                                                            |
| `repositories/<owner>/<name>/clone/`             | The repository's clone. Each pass resets it to the remote's default branch, and runs branch from it.                                                                                                                                                                                                        |
| `repositories/<owner>/<name>/clone/.sandcastle/` | Sandcastle's run worktrees. The clone excludes this directory locally, so the repository need not ignore it.                                                                                                                                                                                                |
| `repositories/<owner>/<name>/logs/`              | Each run's redacted log, `issue-<n>-attempt-<a>.log`.                                                                                                                                                                                                                                                       |
| `usage.json`                                     | Each provider's last good usage reading with when it was read, and the earliest time the provider may be read again. It holds no credential or provider answer.                                                                                                                                             |
| `repositories/<owner>/<name>/runs/`              | Each run's record, `issue-<n>-attempt-<a>.json`: its repository configuration, provider, model, effort, attempt, start, log, base commit, whether it exited or was interrupted, its pause's cause, reset, time and deadline and whether its issue was told when it paused, and whether the host settled it. |
| `repositories/<owner>/<name>/sandboxes/`         | The private directories of runs whose agents are still running: each run's token directory and its raw log.                                                                                                                                                                                                 |

Sandbox images live in the host's Docker daemon, tagged as the
[sandbox image contract](sandbox-image.md) describes. The repository's
`.factory/Dockerfile` is read from the clone on every pass.

## Run outcomes

Ended runs and orphaned claims use the same table, in order. Pull requests
come from the issue's closing references and its `factory/issue-<n>` branch.
An open pull request takes precedence even when the run timed out or the
issue closed.

| First matching observation               | Run outcome    | Action                                                                  |
| ---------------------------------------- | -------------- | ----------------------------------------------------------------------- |
| Pull request open                        | Awaiting merge | Keep the claim without taking a provider cap slot.                      |
| Issue closed                             | Done           | Release the claim.                                                      |
| Pull request merged, issue open          | Failed, final  | Fail without retrying.                                                  |
| Configured needs-input label present     | Needs input    | Release without failure or retry, including after timeout or orphaning. |
| Unpushed commits under `unpushablePaths` | Failed, final  | Fail without retrying and name the paths.                               |
| Anything else                            | Failed         | Retry attempt 1 once on `models.retry`; fail attempt 2.                 |

After the owner answers the question and removes the needs-input label, pickup
starts a fresh attempt 1 on the existing branch. Interrupted and
[paused runs](#paused-runs) bypass the table and relaunch as the same attempt.
An orphaned claim with no interrupted or paused record settles as a failed
attempt; an existing run record supplies its attempt number, and a claim with
no record counts as attempt 1. An issue carrying the configured running or
paused label that no run on the host holds is such a claim. Failing or
releasing a claim removes whichever of the two labels it carries, and a claim
kept awaiting merge or retried carries the running label.

## Paused runs

A paused run is one whose agent exited on its provider's usage limit. When the
agent exits, the run's provider adapter reads the end of the run's raw log
before its private directory is removed, and recognizes the provider's own
limit error there: Claude Code's session, weekly or usage limit message, or
Codex's usage-limit error. The model's prose and a high usage read after the
exit don't count. When the error states a reset, such as
`resets 12:50pm (UTC)`, the factory keeps it as written.

The run pauses when its agent exits, and the factory fixes the pause's
deadline then, once: a reset stated as a UTC time of day, such as
`5:50pm (UTC)` or `17:50 (UTC)`, is its first occurrence at or after the pause,
so a run that paused at 15:03 UTC on October 14 has a deadline of 17:50 UTC
that day, however late a pass or restart looks at it. Any other reset, or none,
gives the longest hold, 24 hours after the pause, which also caps a dated
reset.

A paused run bypasses the run outcome table, whether its pull request is open,
it has none, or the factory stopped it at the time limit. It is not a failure:
it spends no attempt or retry and takes no provider cap slot. The factory
replaces the issue's running label with the configured paused label and posts
one comment giving the cause, the reset when known, and the run's model and
attempt, and saying that the factory resumes the run by itself and nobody
needs to act. It contains no log output. Later passes and restarts don't
repeat it.

The run relaunches like an [interrupted run](#restarts): as the same attempt,
with the same model, effort, prompt, retry context and log, on its
`factory/issue-<n>` branch, so an agent that was babysitting a pull request
resumes on it. Unlike an interrupted run, its usage limit holds it:

- Usage at or above `usageThreshold` holds it, before and after its deadline.
- Usage read since the pause and below the threshold relaunches it at once.
- Unknown usage, or a reading from before the pause, holds it until its
  deadline and no longer. A fresh launch is not held by unknown usage; a paused
  run is, because its pause shows that the provider ran out, but only until the
  deadline, so a provider whose usage stays unreadable cannot hold it forever.

The deadline bounds only the hold caused by unknown usage. A usable high
reading still holds it after the deadline; the deadline promises no launch
despite capacity or repository holds and sets no spending quota.

It also waits for its provider's cap and for its repository to resume, however
long those take. Before it launches, the factory swaps the paused label back for the
running label; if that write fails, the run does not launch that pass.
Resuming posts nothing. A relaunch that hits the limit again pauses again,
with a new comment, and nothing caps the number of pauses.

While a run is paused, its claim is released, and both labels removed, once
its issue closes or carries the configured needs-input label. An open issue
carrying the paused label is never picked up as a fresh attempt.

### Usage reads

Each pass reads each configured provider's usage unless its read deadline
has not arrived. Claude Code's `/api/oauth/usage` is undocumented and
best-effort. The [documented long-lived token](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)
from `claude setup-token` supports model requests and launches, but should not
be expected to permit usage reads. Successful launches do not establish that
permission. HTTP 403 may mean the token lacks usage-read permission; the status
alone does not prove a scope error. HTTP 429 means the usage read was throttled,
which does not establish permission either. Backoff does not grant permission.

The first unavailable read is written to the process log with the provider,
the numeric HTTP status or safe failure category, when it is next read, and
the effect on the percentage gate. Repeated unchanged failures and cooldown
skips stay quiet, including after restart. A different status or failure
category produces an updated diagnostic. The next successful numeric reading
reports recovery once and rearms failure reporting; an answer without a usage
window is not recovery. No credential, raw error or response body is logged or
kept in the episode state, and nothing is posted on an issue.

When a refusal carries `Retry-After`, as seconds from the answer or as an HTTP
date, the factory does not read that provider's usage again before then, and
reads it on the first pass at or after that time. Other providers are read
as usual meanwhile.
For HTTP 403, a missing, malformed or past header instead gives a one-hour
fallback; for HTTP 429 it gives a separate 20-minute fallback, each measured
from response receipt. Other failures retain normal next-pass polling without
a usable header. These deadlines apply per provider across every repository
and survive restarts. This waiting holds back only usage reads, never launches.

The factory keeps each provider's last good reading with the time it was read,
and uses it for 20 minutes from then: a failed or skipped read neither discards
it nor makes it younger. After that the usage is unknown, whether the reading
was low or high. Unknown usage permits fresh launches without the
`usageThreshold` percentage gate. Provider concurrency caps, run time limits,
and the provider's actual limit still apply. A confirmed limit exit pauses its
run for the finite unknown-usage hold described in [Paused runs](#paused-runs):
the first reliably parsed UTC reset relative to the pause, capped at 24 hours,
or the 24-hour fallback. This does not cap repeated genuine pauses.
The readings, read deadlines and safe episode categories are kept in
`usage.json`, so a restart neither reads too early nor loses them or repeats
the same warning. Older records without episode metadata still load normally.

The host keeps supplying one credential file, read at each launch and eligible
usage probe. Replacing it takes effect at the next eligible probe without
deleting `usage.json`; the factory neither inspects token scopes nor manages a
new login or refresh flow. For this service, evaluating a permitted
usage-capable credential and its renewal or rotation belongs in
`lutzseverino/homelab`, which owns credential provisioning. An interactive login
may have broader scopes but a different lifetime and refresh contract; copying
a short-lived access token alone is not a durable fix. Factory refusal handling
works independently of that separate host decision.

## Restarts

A restart, such as for a factory upgrade or a changed credential file, never
spends a run's retry. On `SIGTERM` or `SIGINT` the process stops claiming and
launching, records each running run as interrupted, removes the sandbox
containers and the runs' private directories, and exits without waiting for the runs to finish. On startup, before
it claims or launches anything, it removes every sandbox container an earlier
process left, then takes up the runs recorded as interrupted or paused. A
paused run stays paused, keeping its pause time and deadline, and its issue is
not told again. A paused run recorded by a factory release that kept no pause
time pauses at its recorded exit, or at its start when it has no exit, so its
deadline never counts from the restart and an overdue run relaunches without
changes to its record or labels.

An interrupted run launches again as the same attempt, with the same model,
prompt and log, continuing its `factory/issue-<n>` branch and Sandcastle's
worktree for it, and keeps its claim meanwhile. It takes its issue's turn in
the queue and waits for its provider's cap and usage gate and for its
repository to resume. It continues as it would have without the restart, so a
readiness change or a new blocker does not hold it; it releases its claim
instead once its issue is closed or carries its configured needs-input label. Its time
limit starts again at the relaunch.

A sandbox container is any container from a factory sandbox image, which
carries the `factory.agent.identity` label, so a host runs one factory process
and starts no other containers from those images.

## Repository pauses

A repository is paused for a pass, claiming and launching nothing there, when:

- its token command fails;
- its clone does not update;
- its `.factory/config.json` is missing or invalid;
- it has no `.factory/Dockerfile`, or its sandbox image does not build;
- its configured state labels cannot be created;
- its GitHub reads fail.

Its ended runs keep settling while its GitHub reads succeed, and the other
repositories continue. A repository pause is no [paused run](#paused-runs): it
never adds the paused label or posts on an issue, and its reason appears only
in the process log and the status file. A run whose sandbox is still running counts against its
provider's cap and time limit even while its repository can't be read.

## Status file

After every pass the factory replaces `status.json` whole. It lists each
repository in the host configuration's order with its state, `running` or
`paused` with the reason, and the issues the pass held with their skip reasons.
The factory posts no status to GitHub.

```json
{
  "updatedAt": "2026-10-09T12:00:00.000Z",
  "repositories": [
    {
      "repository": "acme/widgets",
      "state": "running",
      "held": [
        { "issue": 5, "reason": "blocked by #4" },
        {
          "issue": 7,
          "reason": "relaunch waits: claude-code hit its usage limit (resets 12:50pm (UTC)); usage 100% is at or above the 80% threshold"
        }
      ]
    },
    {
      "repository": "acme/gadgets",
      "state": "paused",
      "reason": "it has no .factory/Dockerfile",
      "held": [
        {
          "issue": 2,
          "reason": "acme/gadgets is paused: it has no .factory/Dockerfile"
        }
      ]
    }
  ]
}
```

The process also logs each pass's decisions, skip reasons and pauses to
standard output, [redacted](#redaction).
