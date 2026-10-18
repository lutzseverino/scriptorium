# Host installation and configuration

One factory process serves every repository its host configuration lists. It
reads each repository from GitHub, keeps a clone of it, launches agents in
sandboxes built from the repository's toolchain image, and records what it is
doing in a status file. Every repository shares one oldest-first queue, and
provider caps and usage thresholds apply across all of them.

## Install and start

The owner must set up the `scriptorium-v*` tag ruleset before the first host
installation, as the [release procedure](../development/release.md) describes.
Check out a Scriptorium release tag (`scriptorium-vX.Y.Z`) of
`lutzseverino/scriptorium`, then from the checkout's root install the runtime
dependencies and start the process with the host configuration's path:

```sh
npm ci --omit=dev
node src/main.ts /etc/factory/host.json
```

Releases up to `scriptorium-v1.0.5` were published from
`lutzseverino/repo-canon`, with the package in its `factory/` directory; a
checkout of one of those tags installs and starts from `factory/` instead. A
host that updates on its own lists the releases of `lutzseverino/scriptorium`
for newer versions, since later releases are published only there.

The process needs stable Node.js 24 or 26 (24 is the default), Git, the GitHub
CLI and Docker with its Buildx plugin on its `PATH`, and runs until it is
stopped; [restarts](#restarts) describes stopping it. It builds sandbox images
with its own user's UID and GID, in its own Buildx builder, which it creates on
its first build; [sandbox image retention](#sandbox-image-retention) describes
the builder and what the factory removes. An unreadable, malformed or invalid
host configuration stops it at start with every problem named. The host keeps
its own service setup: the service definition and its `PATH`, the provider
credential files, and the host configuration itself.

## Host configuration

The host configuration is one JSON file. Every field is required except
`providers.claude-code.usageCredential`, `imageRetention` and the fields whose
default the table below gives. Unknown fields are refused, and nothing comes
from environment variables.

```json
{
  "repositories": ["acme/widgets", "acme/gadgets"],
  "providers": {
    "claude-code": {
      "cap": 2,
      "credential": "/etc/factory/claude-token",
      "usageCredential": "/etc/factory/claude-usage.json"
    },
    "codex": { "cap": 1, "credential": "/etc/factory/codex-auth.json" }
  },
  "models": {
    "default": "claude-sonnet-5-5",
    "retry": "claude-opus-5-5@xhigh"
  },
  "timeLimitMinutes": 240,
  "usage": {
    "drainThreshold": 90,
    "pauseThreshold": 95,
    "afterDrain": "auto-resume"
  },
  "pollSeconds": 300,
  "readiness": { "authorizedRoles": ["admin", "maintain"] },
  "unpushablePaths": [".github/workflows/"],
  "stateDirectory": "/var/lib/factory",
  "gitIdentity": { "name": "factory[bot]", "email": "factory@example.com" },
  "github": { "tokenCommand": ["/usr/local/bin/factory-token"] },
  "imageRetention": { "obsoletePairs": 3, "cacheMinimumAgeHours": 24 }
}
```

| Field                                   | Value                                                                                                                                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repositories`                          | A non-empty list of distinct `<owner>/<name>` GitHub repositories the factory serves.                                                                                                                                   |
| `providers.<name>`                      | One entry per provider the host runs, named `claude-code` or `codex`. Only these providers are in the registry.                                                                                                         |
| `providers.<name>.cap`                  | The whole number of sandboxes that provider may run at once across every repository.                                                                                                                                    |
| `providers.<name>.credential`           | The absolute path of the launch credential: the Claude Code setup-token file, or the Codex login (`auth.json`). Claude also uses it for usage reads when `usageCredential` is omitted.                                  |
| `providers.claude-code.usageCredential` | Optional absolute path of a host-renewed Claude interactive-login copy, used only for usage reads. A configured but unusable copy never falls back to the launch token. See [Claude usage login](#claude-usage-login).  |
| `models.default`                        | The model an issue without a model label runs on.                                                                                                                                                                       |
| `models.retry`                          | The model a failed first attempt retries on.                                                                                                                                                                            |
| `timeLimitMinutes`                      | How long a run may take before it is stopped, and its sandbox's idle limit.                                                                                                                                             |
| `usage.drainThreshold`                  | The provider usage percentage, from 0 to 100, at or above which that provider claims no new issue, or `null` for none. See [usage thresholds](#usage-thresholds).                                                       |
| `usage.pauseThreshold`                  | The provider usage percentage, from `usage.drainThreshold` to 100, at or above which that provider's running runs stop too, or `null` for none. Optional; the default is `null`.                                        |
| `usage.afterDrain`                      | What reopens a drained provider's claims: `auto-resume`, a reading below the drain threshold, or `owner-resume`, only the owner's [resume command](#owner-holds-and-resume). Optional; the default is `auto-resume`.    |
| `pollSeconds`                           | The wait between passes.                                                                                                                                                                                                |
| `readiness.authorizedRoles`             | The repository roles whose [readiness](#readiness) the factory accepts: `admin`, `maintain`, `write`, `triage` or `read`.                                                                                               |
| `unpushablePaths`                       | Path prefixes inside a repository that the factory's GitHub App can't push, such as `.github/workflows/`. Unpushed commits under these paths fail without a retry, naming the paths; see [run outcomes](#run-outcomes). |
| `stateDirectory`                        | The absolute path of the directory the process owns.                                                                                                                                                                    |
| `gitIdentity`                           | The `name` and `email` that commits made from the clones carry.                                                                                                                                                         |
| `github.tokenCommand`                   | The executable and leading arguments that print a GitHub token for a repository.                                                                                                                                        |
| `imageRetention.obsoletePairs`          | The whole number of obsolete sandbox image pairs kept across every repository, newest first; pairs in use stay beyond it. Optional; the default is 3. See [image retention](#sandbox-image-retention).                  |
| `imageRetention.cacheMinimumAgeHours`   | The positive whole number of hours since its last use after which the factory builder's cache is pruned. Optional; the default is 24.                                                                                   |

A model is `<slug>` or `<provider>/<slug>`, optionally followed by
`@<effort>`, and must resolve to a configured provider; the
[providers](#providers) section describes the grammar.

### Usage thresholds

Each threshold applies to one provider at a time, across every repository,
and the other providers carry on. A provider's usage is the fullest window's
percentage its last good reading found; [usage reads](#usage-reads) describes
when that reading counts.

- **Drain threshold.** At or above `usage.drainThreshold`, the provider claims
  no new issue. A failed run's retry is a new claim and waits too. Running
  runs carry on, and so does an [interrupted run's](#restarts) relaunch, which
  is running work. With `auto-resume`, claims start again on the first reading
  below the threshold, even while runs from before the drain are still
  running. With `owner-resume`, the drain also sets an
  [owner hold](#owner-holds-and-resume).
- **Pause threshold.** At or above `usage.pauseThreshold`, the factory also
  stops each of the provider's running runs by killing its sandbox, and holds
  interrupted relaunches. The worktree and the `factory/issue-<n>` branch
  survive, and each stopped run becomes a [paused run](#paused-runs), which
  relaunches as the same attempt. The run time limit still stops a run that
  exceeded it first. Nothing overrides the pause threshold.
- **Usage hold.** A reading at or above either threshold starts a usage hold
  on its provider, which keeps that reading in force once the provider's usage
  is unknown: the reading expired, the provider refused or failed the read, or
  the process restarted. The hold ends on a usable reading below every
  threshold, at the reset the provider reported for its fullest window, or 24
  hours after the hold began, whichever comes first. That deadline is fixed
  when the hold begins and never moves on a later pass or restart, and a usage
  read's backoff is never that deadline. Without a usage hold, unknown usage
  holds no claim, as before.

A pause threshold below the drain threshold is refused; equal thresholds
drain and pause together. Either threshold may be `null`. With both `null`,
usage holds nothing, and a paused run waits only for its deadline.

For this factory release only, a configuration that still sets the legacy
`usageThreshold` is read as `usage.drainThreshold` with no pause threshold,
and the process log warns at start to replace it, for example
`"usageThreshold": 90` with `"usage": { "drainThreshold": 90 }`. Setting
`usageThreshold` together with `usage` is refused rather than choosing either.

### Owner holds and resume

With `"afterDrain": "owner-resume"`, a provider that drains gets an owner
hold: the first pass whose usage, read or kept by a usage hold, holds the
provider's new claims sets it. That is the drain threshold, or the pause
threshold when the host sets no drain threshold. The owner hold keeps that
provider from claiming any new issue, retries included, in every repository,
through low readings, unknown usage and restarts, until the owner resumes the
provider. A low reading, the provider's reset or the usage hold's deadline
ends only the usage hold, never the owner hold. Other providers keep claiming.

The owner hold holds no running work: running runs carry on, interrupted runs
relaunch, and the pause threshold still stops runs. A
[paused run](#paused-runs) relaunches by itself under its own rule, on a
reading below every configured threshold, whatever the owner hold or a reserve
raise says.

The owner resumes a provider with the `resume` command, run as the factory's
user from the release checkout, with the same host configuration:

```sh
node src/main.ts resume <host configuration> <provider> [--drain-threshold N]
```

The command checks the request against the host configuration and writes it
to `requests/` in the state directory; it never runs, stops or edits the
running factory. It prints the request's name, then exits with status 0 once
queued, 1 for a refused request or configuration, and 2 for a malformed
command. The running factory applies each queued request on its next pass,
within `pollSeconds` of its current one, in the order they were queued, before
it decides that pass. It logs `resume request <name> applied`, with what it
lifted or raised, or `resume request <name> was discarded` with the reason,
such as a provider the host configuration no longer lists, and removes the
request. A request is applied once, even across a restart, and one queued
while the factory is stopped applies on its first pass.

- **Plain release.** `resume <host configuration> claude-code` lifts the owner
  hold and nothing else. Claims then follow the drain threshold as with
  `auto-resume`: at or above it they still wait, and on a reading below it they
  reopen. The provider gets a new owner hold only once its usage has stopped
  holding its claims, on a reading below the threshold or at the end of its
  usage hold, and it then drains again.
- **Reserve use.** `--drain-threshold N` also raises the provider's drain
  threshold for new claims once, to `N`: above `usage.drainThreshold`, and at
  most `usage.pauseThreshold`, or 100 without one. The raise lasts until a
  reading below the configured drain threshold or until the reset the
  provider reported for its fullest window passes; a raise granted while no
  reset is known waits for the first one the provider reports. Then the
  configured drain threshold applies again, and a provider whose usage still
  holds its claims drains again. Usage reaching the raise also drains the
  provider, which sets a new owner hold under `owner-resume`. The raise never
  moves the pause threshold, and never releases a paused run.

Both work under `auto-resume` too. It sets no owner hold, though one set
before the host switched to it stays until a resume lifts it. For example,
with a drain threshold of 90, a pause threshold of 95 and `owner-resume`,
Claude Code reads 92% and has an owner hold:

```sh
# Claims wait for the usage to read below 90%, then reopen by themselves.
node src/main.ts resume /etc/factory/host.json claude-code
# Claims reopen at once and run up to 94%; at 94% a new owner hold is set.
node src/main.ts resume /etc/factory/host.json claude-code --drain-threshold 94
```

A raise the host configuration no longer allows, after an edit and restart,
ends on the next pass. An unreadable `owner.json` starts every provider of an
`owner-resume` host with an owner hold, so a damaged record never reopens
claims; resume each provider to lift it.

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

## Providers

The provider registry in `src/providers.ts` holds one adapter per provider the
host configuration names: Claude Code and Codex. Each adapter launches its
agent through Sandcastle, lists its reasoning efforts, routes bare model slugs
by its vendor prefix (`claude-*` or `gpt-*`), supplies the prompt's
`{skillPrefix}` (`/` or `$`), reads its usage, and recognizes its own
usage-limit error at the end of an ended run's raw log. Its launch credential
is a host file: the Claude Code setup-token file, or the Codex login
(`auth.json`) the host keeps renewing. Claude can use a separate host-renewed
login copy for usage. Each credential is read again when needed; no provider
credential comes from an environment variable.

Claude Code's documented setup token supports launches but should not be
expected to read its undocumented, best-effort usage endpoint. A 403 can be a
permission refusal; a 429 means throttling. Neither waiting nor a successful
launch establishes usage permission. The factory backs off refused reads and
reports an unavailable episode once, with updates for changed failures and
numeric recovery. A good cached reading still applies for 20 minutes from its
observation, and a [usage hold](#usage-thresholds) keeps a high one in force
after that; otherwise, once it expires, new claims proceed without the usage
thresholds. Provider caps, run time limits and the provider's actual limit
still apply. A confirmed limit pauses its run until a usable low reading or
its fixed unknown-usage deadline: the first reliably parsed UTC reset relative
to the pause, capped at 24 hours, or a 24-hour fallback. A usable high reading
or a usage hold continues to hold it; capacity and repository holds can also
delay launch. That deadline is no spending quota or cap on repeated pauses.
[Usage reads](#usage-reads) describes backoff, recovery and the separate
`lutzseverino/homelab` responsibility for credential provisioning and renewal.

A model is `<slug>` or `<provider>/<slug>`, optionally followed by
`@<effort>`; a model label is the same under the repository's model label
prefix. A model on a provider the host does not configure, an effort the
provider does not list, or a bare slug no configured provider routes is refused
with the reason.

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

| Path                                             | Contents                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status.json`                                    | The status file.                                                                                                                                                                                                                                                                                                                                           |
| `events.jsonl`                                   | The append-only [operational event stream](#operational-events) for external delivery.                                                                                                                                                                                                                                                                     |
| `events-state.json`                              | The process-owned event checkpoint and pending append, including its related usage or owner policy write. Keep it with the event stream across restarts.                                                                                                                                                                                                   |
| `repositories/<owner>/<name>/clone/`             | The repository's clone. Each pass resets it to the remote's default branch, and runs branch from it.                                                                                                                                                                                                                                                       |
| `repositories/<owner>/<name>/clone/.sandcastle/` | Sandcastle's run worktrees. The clone excludes this directory locally, so the repository need not ignore it.                                                                                                                                                                                                                                               |
| `repositories/<owner>/<name>/logs/`              | Each run's redacted log, `issue-<n>-attempt-<a>.log`.                                                                                                                                                                                                                                                                                                      |
| `usage.json`                                     | Each provider's last good usage reading with when it was read and its reset, the earliest time the provider may be read again, and its usage hold with when it began and ends. It holds no credential or provider answer.                                                                                                                                  |
| `owner.json`                                     | Each provider's [owner hold](#owner-holds-and-resume) with when it was set and the usage that set it, its reserve raise with its threshold, start and reset, whether it is draining, and the resume requests already applied whose files remain.                                                                                                           |
| `requests/`                                      | The resume requests the `resume` command queued and the running factory has not yet applied, one JSON file each, named by when it was queued.                                                                                                                                                                                                              |
| `repositories/<owner>/<name>/runs/`              | Each run's record, `issue-<n>-attempt-<a>.json`: its repository configuration, provider, model, effort, attempt, start, log, base commit, whether it exited or was interrupted, the pause a stop at the pause threshold fixed, its pause's cause, reset, time and deadline and whether its issue was told when it paused, and whether the host settled it. |
| `repositories/<owner>/<name>/sandboxes/`         | The private directories of runs whose agents are still running: each run's token directory and its raw log.                                                                                                                                                                                                                                                |

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

### Foreground execution and incomplete runs

The factory adds an unattended execution contract to the configured prompt,
including retries. There is no interactive notification or resume loop:
validation must finish in the foreground and its exit status must be checked
before delivery. Shell detachment (`&`, `nohup`, `disown`) cannot keep work
running after the sandbox closes. A command timeout must be resolved as a
failure; it never counts as passing validation.

Claude launches with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, both in the
provider environment and in CLI `--settings`. The CLI settings override
conflicting user and project `env` settings; managed settings remain owned by
the factory image. This removes explicit background tools and automatic
backgrounding. Claude's default Bash timeout is 30 minutes, capped by the
host's `timeLimitMinutes`; its maximum Bash timeout is that host limit.
Commands must still fit the run's remaining time, and the host can stop the
whole run sooner. Codex keeps its existing command timeout behavior.

The prompt requests `<promise>COMPLETE</promise>` only after the requested
delivery or explicit owner handoff is recorded, matching the launcher's
completion signal. A signal ends loop control and proves no GitHub outcome.
The table above still applies: a signal without delivery fails, while a valid
PR or owner handoff remains valid without a signal. Runs use one Sandcastle
iteration; another iteration would launch a fresh invocation.

When a run returns without the signal, the process log gives a diagnostic
and recovery identities. Its run record holds `launchResult`: the returned
branch, completion signal, preserved worktree path, and captured session ID
and session file path when available. Raw output and resume functions are
excluded. The host also inspects local Git state into `recovery`, containing
the branch, its commit (`head`), and any registered worktree. This inspection
also covers launcher errors that return no metadata. A recovery-inspection
failure is reported; keep the clone for inspection.

Committed work remains on `factory/issue-<n>`. Sandcastle preserves dirty
worktrees, including staged, unstaged and untracked changes, and reuses them
on retry without resetting those changes. Before each launch the host reads
the preserved state again and tells the agent to continue it and revalidate
before publication. Recovery performs no push or PR creation and grants no
readiness. Pauses and interruptions retain their existing relaunch rules.

For manual recovery after a final failure, retain the repository's clone and
`.sandcastle/` directory together. Inspect the run record and use
`git -C <clone> worktree list --porcelain` to locate its worktree. Review the
branch's commits and the worktree's `git status`, including its index and
untracked files. Continue in that worktree, or let the factory reuse it after
removing the failed label when the failure has been addressed. Revalidate the
recovered work before delivering it. Do not remove the clone or force-remove
the worktree while it holds work you need. A captured session is diagnostic
context; the factory does not resume a live session or a background process.

## Paused runs

A paused run is one whose agent exited on its provider's usage limit, or one
the factory stopped at its provider's
[pause threshold](#usage-thresholds). When the agent exits, the run's provider
adapter reads the end of the run's raw log before its private directory is
removed, and recognizes the provider's own limit error there: Claude Code's
session, weekly or usage limit message, or Codex's usage-limit error. The
model's prose and a high usage read after the exit don't count. When the error
states a reset, such as `resets 12:50pm (UTC)`, the factory keeps it as
written.

A run that exits on its limit pauses when its agent exits. A run stopped at
the pause threshold pauses when the pass that stops it begins, keeping the
reset the reading reported, and it pauses for that cause however its agent
then exits, even on its usage limit. A run that exited before the stop settles
as it ended. A later pass that repeats the stop changes nothing.

The factory fixes the pause's deadline as the run pauses, once. A reset stated
as a UTC time of day, such as `5:50pm (UTC)` or `17:50 (UTC)`, is its first
occurrence at or after the pause, so a run that paused at 15:03 UTC on October
14 has a deadline of 17:50 UTC that day, however late a pass or restart looks
at it. A reset a usage reading reported is that time. Any other reset, or
none, gives the longest hold, 24 hours after the pause, which also caps a
dated reset.

A paused run bypasses the run outcome table, whether its pull request is open,
it has none, or the factory stopped it at the time limit. It is not a failure:
it spends no attempt or retry and takes no provider cap slot. The factory
replaces the issue's running label with the configured paused label and posts
one comment giving the cause, `usage limit` or `pause threshold`, the reset
when known, and the run's model and attempt, and saying that the factory
resumes the run by itself and nobody needs to act. It contains no log output.
Later passes and restarts don't repeat it.

The run relaunches like an [interrupted run](#restarts): as the same attempt,
with the same model, effort, prompt, retry context and log, on its
`factory/issue-<n>` branch, so an agent that was babysitting a pull request
resumes on it. Unlike an interrupted run, its pause holds it:

- Usage at or above either threshold, read or kept by a usage hold, holds it,
  before and after its deadline.
- Usage read since the pause and below every threshold relaunches it at once.
- Unknown usage, or a reading from before the pause, holds it until its
  deadline and no longer. A new claim is not held by unknown usage without a
  usage hold; a paused run is, because its pause shows that the provider ran
  out, but only until the deadline, so a provider whose usage stays unreadable
  cannot hold it forever.
- With neither threshold set, a reading releases nothing, and it relaunches at
  its deadline.
- An owner hold or a reserve raise neither holds nor releases it.

The deadline bounds only the hold caused by unknown usage. A usable high
reading or a usage hold still holds it after the deadline; the deadline
promises no launch despite capacity or repository holds and sets no spending
quota.

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
the effect on the usage thresholds. Repeated unchanged failures and cooldown
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
and survive restarts. This waiting holds back only usage reads, never launches,
and never sets a usage hold's deadline.

The factory keeps each provider's last good reading with the time it was read
and its fullest window's reset, when the provider reports one, and uses it for
20 minutes from then: a failed or skipped read neither discards it nor makes
it younger. After that the usage is unknown, whether the reading was low or
high. A high reading has started a [usage hold](#usage-thresholds) by then,
which keeps it in force until the hold ends; without one, unknown usage
permits new claims without the usage thresholds. Provider concurrency caps,
run time limits, and the provider's actual limit still apply. A confirmed limit exit pauses its
run for the finite unknown-usage hold described in [Paused runs](#paused-runs):
the first reliably parsed UTC reset relative to the pause, capped at 24 hours,
or the 24-hour fallback. This does not cap repeated genuine pauses.
The readings, read deadlines, safe episode categories and usage holds are kept
in `usage.json`, so a restart neither reads too early nor loses them or repeats
the same warning. Older records without episode metadata, resets or holds
still load normally.

Replacing a credential takes effect at the next eligible usage probe without
restarting or deleting `usage.json`; it does not bypass an active refusal
backoff. Codex continues to use its host-renewed `auth.json` for both launches
and usage. Claude uses the separate copy below when configured; omitting it
keeps the existing best-effort setup-token usage read.

### Claude usage login

`providers.claude-code.credential` remains a plain setup-token file for
launches. `providers.claude-code.usageCredential` optionally names a separate
JSON copy of an interactive claude.ai login. The usage endpoint needs
`user:profile` permission; a setup token for model requests does not establish
that permission. The endpoint remains undocumented and best-effort even with
an interactive login.

The factory consumes this copy format (values below are examples):

```json
{
  "claudeAiOauth": {
    "accessToken": "<ACCESS_TOKEN>",
    "expiresAt": 1893456000000
  }
}
```

`accessToken` must be a non-empty string without whitespace. `expiresAt` is a
finite number of milliseconds since the Unix epoch, later than the current
host time. Preserve the expiry from the renewed login; do not invent a longer
lifetime. Extra metadata, such as `scopes`, is ignored. No refresh token is
required or used. Publish only the fields above so the factory has no refresh
authority.

The host owner provisions and renews it; for this service that is
`lutzseverino/homelab`'s responsibility:

1. As root, install Claude Code and complete its
   [interactive claude.ai login](https://code.claude.com/docs/en/authentication#log-in-to-claude-code)
   in a dedicated root-owned configuration directory, for example by running
   `CLAUDE_CONFIG_DIR=/root/.claude-factory-usage claude`. Keep the original
   login, including its refresh token, readable only by root. Do not give the
   factory access to that directory.
2. Arrange host-owned renewal before the access token expires. On Linux, the
   interactive login is in that directory's `.credentials.json`; export only
   `claudeAiOauth.accessToken` and `claudeAiOauth.expiresAt` from each renewed
   login into the copy above. Verify that the login has `user:profile`
   permission; local scope metadata alone does not prove endpoint access.
3. Publish the copy atomically at the configured absolute path, for example
   `/etc/factory/claude-usage.json`: write a temporary file in that directory,
   set its ownership and permissions, then rename it over the old copy. A
   root-owned file with mode `0640` and a group containing the factory's
   service user lets the factory read it without changing it. The service user
   also needs directory traversal permission. Keep the root login and refresh
   token out of this copy, its directory and the service's environment.
4. Set `usageCredential` in the host configuration when starting the factory.
   Later file replacements need no restart. The factory reads the copy only
   on the host for usage, never mounts it in a sandbox, and never renews it or
   substitutes it for the launch token.

A missing, unreadable, malformed or expired copy fails the usage read before
any endpoint request and never falls back to setup-token. It leaves usage
unknown once any recent cached reading expires, through the same bounded
unavailable/recovery reporting as other read failures. Launches still use the
setup token. An empty-window answer is also unknown, not recovery.

To troubleshoot, check the configured path, service-user access, JSON shape,
expiry, host clock and root renewer's operation without printing credentials.
For HTTP 403, check the interactive account and usage-read permission; for
HTTP 429, wait for the recorded read deadline. Renewing or replacing a copy
respects that deadline. Numeric recovery is reported on the next eligible
successful read. Tokens, raw errors and response bodies stay out of process
logs, status and usage records.

## Restarts

A restart, such as for a factory upgrade or a changed host configuration, never
spends a run's retry. On `SIGTERM` or `SIGINT` the process stops claiming and
launching, records each running run as interrupted, removes the sandbox
containers and the runs' private directories, and exits without waiting for the runs to finish. A run the
factory was stopping at the pause threshold is recorded as paused instead. On
startup, before it claims or launches anything, it removes every sandbox
container an earlier process left, then takes up the runs recorded as
interrupted or paused, and pauses a run an earlier process that ended without
the signal was stopping at the pause threshold. A paused run stays paused,
keeping its pause time and deadline, and its issue is told once in all. A paused run recorded by a factory release that kept no pause
time pauses at its recorded exit, or at its start when it has no exit, so its
deadline never counts from the restart and an overdue run relaunches without
changes to its record or labels.

An interrupted run launches again as the same attempt, with the same model,
prompt and log, continuing its `factory/issue-<n>` branch and Sandcastle's
worktree for it, and keeps its claim meanwhile. It takes its issue's turn in
the queue and waits for its provider's cap, its provider's pause threshold and
for its repository to resume; the drain threshold does not hold it. It continues as it would have without the restart, so a
readiness change or a new blocker does not hold it; it releases its claim
instead once its issue is closed or carries its configured needs-input label. Its time
limit starts again at the relaunch.

A sandbox container is any container from a factory sandbox image, which
carries the `factory.agent.identity` label, so a host runs one factory process
and starts no other containers from those images.

## Sandbox image retention

Each repository's sandbox image is a pair: the agent image
`factory-sandbox:<hash>` and its toolchain image
`factory-sandbox:<hash>-toolchain`, named by the
[image tag](sandbox-image.md#image-tags-and-compatibility). A changed
`.factory/Dockerfile` or agent layer builds a new pair and leaves the old one
obsolete. After each pass the factory removes its own obsolete pairs beyond
`imageRetention.obsoletePairs`, keeping the newest, and prunes its builder's
cache that is at least `imageRetention.cacheMinimumAgeHours` old.

The factory keeps, whatever the allowance:

- every repository's current pair, which repositories with the same
  `.factory/Dockerfile` share;
- a pair the image of a run that has not exited belongs to, even if its
  sandbox container does not exist yet;
- a pair whose image any container on the host uses, running or stopped,
  including an image a rebuild for a new UID and GID left untagged.

The allowance counts these kept obsolete pairs too, so when they reach it the
factory keeps them and no other obsolete pair: the host can hold more obsolete
pairs than `imageRetention.obsoletePairs` for as long as they are in use. A
pass removes nothing while any repository has no current image, because its
`.factory/config.json` or `.factory/Dockerfile` is unavailable, its image did
not build or it could not be read; that repository may still need any old
pair. The process log says once that retention waits and for which
repositories, and retention resumes on the first pass that prepares every
repository's image. A failed build therefore never costs the last usable
images.

Only the factory's own images are candidates:

- tags of the `factory-sandbox` repository that are exactly a 64-digit
  lowercase hexadecimal hash, alone or followed by `-toolchain`;
- the `factory-<owner>-<name>-<hash>:latest` images that factory releases from
  `lutzseverino/repo-canon` built, but only under the exact name such a release
  gave a repository the host configuration lists. Each counts as one pair, by
  its age.

Every other image stays, including other tags in `factory-sandbox`, lookalike
names, legacy images of repositories the host no longer lists, and untagged
images. The factory removes an image by its tag and never forces a removal, so
another tag on the same image keeps that image, and Docker refuses to remove an
image a container started meanwhile uses. It never runs Docker's image, system
or builder prune commands, which act on the whole host.

The factory builds every sandbox image in its own Buildx builder,
`factory-sandbox`, which runs BuildKit in a container from the pinned
`moby/buildkit` image. That builder's cache holds only the factory's builds,
so the factory prunes it, and never the Docker daemon's own build cache or
another builder's. Base images in a `.factory/Dockerfile` are pulled by that
builder, with the host user's Docker login but without the daemon's registry
mirrors. While its cache lasts, the builder holds a second copy of the layers
it built besides the images it loads into Docker.

Each removal, pruned cache, failed removal and failed inventory goes to the
process log. A failure never pauses a repository or fails a run: a removal
that fails leaves its pair in place, and an inventory that fails removes
nothing that pass.

### Upgrading to retention

An existing host configuration needs no change: without `imageRetention` the
host keeps three obsolete pairs and prunes cache a day old. The first pass
that prepares every repository's image after the upgrade removes the
obsolete pairs and served repositories' legacy images beyond the allowance.
Build cache from earlier factory releases is in the Docker daemon's own
builder, mixed with other builds on the host, so the factory leaves it alone;
whether to prune it is the operator's choice.

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
It also lists every configured provider in configuration order, even with no
frontier issue or running work. The factory posts no status to GitHub.

Each `providers` entry has the following version 1 operational contract,
also used by the event stream's `state` field. Times are UTC ISO 8601 strings;
percentages are numbers. The snapshot's `updatedAt` identifies the pass, and
each provider's `observedAt` identifies that observation.

| Field                    | Meaning                                                                                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`, `observedAt` | Provider name and observation time.                                                                                                                                                                                                                     |
| `usage`                  | `{ "state": "known", "reading": { "used": 92, "at": "…", "reset": "…" } }` for a fresh reading, or `{ "state": "unknown" }`. The reading's `at` is when it was obtained; `reset` is optional. A fresh cached reading remains known after a failed read. |
| `usageHold`              | Automatic usage hold: `used`, `at`, optional `reset`, and fixed `since` and `until`; otherwise `null`. Its evidence still applies when `usage` is unknown.                                                                                              |
| `ownerHold`              | `{ "since": "…", "used": 92 }`, or `null`. `used` is `null` for recovery from an unreadable owner record. Only an owner resume releases it.                                                                                                             |
| `reserve`                | `{ "drainThreshold": 94, "since": "…", "until": "…" }`, or `null`. `until: null` means no reset has been reported yet.                                                                                                                                  |
| `thresholds`             | Configured `drainThreshold`, `pauseThreshold`, `afterDrain`, and `effectiveDrainThreshold` for new claims after a reserve raise. Disabled thresholds are `null`.                                                                                        |
| `running`, `paused`      | Counts across all repositories, including unreadable repositories. Interrupted work awaiting relaunch counts as running. A run stopping at the pause threshold counts as running until exit and as paused from the stop request.                        |
| `claimsHeld`             | Whether usage or the owner holds new claims, independently of repository readiness and capacity.                                                                                                                                                        |
| `pauseAtThreshold`       | Whether usage in force reaches the pause threshold, including when there is no sandbox to stop.                                                                                                                                                         |
| `drained`                | New claims are held and no running work remains. This is an observation, never a latch on recovery.                                                                                                                                                     |
| `reason`                 | `owner-hold`, `pause-threshold`, `drain-threshold`, or `available`, in that precedence order.                                                                                                                                                           |
| `nextAction`             | `owner-resume`, `wait-for-usage`, or `claims-allowed`. A resume can still meet a usage threshold; a reserve raise never overrides the pause threshold. Paused runs retain their separate automatic recovery.                                            |

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
          "reason": "relaunch waits: claude-code hit its usage limit (resets 12:50pm (UTC)); usage 100% is at or above the 95% pause threshold"
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
  ],
  "providers": [
    {
      "provider": "claude-code",
      "observedAt": "2026-10-09T12:00:00.000Z",
      "usage": { "state": "unknown" },
      "usageHold": null,
      "ownerHold": null,
      "reserve": null,
      "thresholds": {
        "drainThreshold": 90,
        "pauseThreshold": 95,
        "afterDrain": "auto-resume",
        "effectiveDrainThreshold": 90
      },
      "running": 1,
      "paused": 0,
      "claimsHeld": false,
      "pauseAtThreshold": false,
      "drained": false,
      "reason": "available",
      "nextAction": "claims-allowed"
    }
  ]
}
```

The process also logs each pass's decisions, skip reasons and pauses to
standard output, [redacted](#redaction).

## Operational events

`events.jsonl` under `stateDirectory` is the version 1 producer contract for
external consumers such as homelab. The factory writes data only: it sends no
notification request and starts no agent or prompt for these events. The
existing per-run pause comment remains separate.

Every newline-terminated UTF-8 JSON record contains `version: 1`, `id`,
`sequence`, `type`, `provider`, `observedAt`, `reason` and `state`. `state` is
the complete provider observation described above, at that transition. No
credential, provider response body, free-text reset, or raw agent output is
included. `reason` uses the fixed categories below, rather than provider text.

| `type`                | Transition and `reason`                                                                                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `held`                | An automatic usage hold (`usage-hold`) or owner hold (`owner-hold`) begins. They are separate records.                                                                                                                      |
| `released`            | That hold ends, with `usage-hold` or `owner-hold` identifying which. A usage release can follow a low reading, reset, fallback deadline or configuration change; it does not release an owner hold.                         |
| `drain_started`       | New claims become held; `reason` is the provider state's hold reason. Running work continues below the pause threshold.                                                                                                     |
| `drained`             | A held provider has no running work (`no-running-work`). With zero running work at the start, this follows `drain_started` immediately. It does not delay reopening claims on a low reading.                                |
| `paused_at_threshold` | Usage in force first reaches the pause threshold (`pause-threshold`), including with zero running work. This records the threshold observation; individual sandbox stops and their comments follow the usual run lifecycle. |
| `reserve_granted`     | An accepted owner request grants a reserve raise (`owner-request`), including a repeated request for the same threshold.                                                                                                    |
| `resumed`             | An owner request is accepted (`owner-request`), or new claims automatically reopen (`claims-reopened`). An accepted request can leave usage holding claims; inspect `state.claimsHeld` and `nextAction`.                    |

The first observation reports any existing active holds. Repeated passes and
restarts emit no new event for an unchanged transition. Each accepted resume
request is its own transition, even if the provider had no owner hold.
The journal's durable stream UUID and monotonically increasing `sequence`
form `id` as `<UUID>:<sequence>`. Sequence numbers order all providers together;
observation times need not increase if the host clock changes. Within an
observation providers follow host configuration order; hold changes precede
drain, pause and drained transitions, followed by reserve grants and resumes.
An owner hold set and released by a request in one pass remains two distinct
transitions. Events can precede the final atomic status snapshot.

If running work finishes and usage recovers between observations, `drained`
precedes release and resume. Its `state` already describes the recovered
observation, so `state.claimsHeld` and `state.drained` can both be false. The
completion event does not keep the provider held for an extra pass.

The factory syncs a write-ahead checkpoint containing the allocated IDs and
exact append bytes, then syncs the append, commits the associated usage or
owner record, and completes the checkpoint. Recovery finishes this work before
loading policy or observing another pass. A partial append resumes at the
exact missing byte without rewriting committed bytes. A persistence failure
fails the pass and is reported in the process log; the next pass or restart
retries the same pending work. An unreadable checkpoint or a missing checkpoint
beside a nonempty stream requires operator repair, rather than generating new
IDs over old events. Keep the checkpoint, policy records and stream together;
the single factory process owns all of them. Rotation and pruning are not
provided.

A reader must process complete newline-terminated records only. Retain an
incomplete final line without parsing it, and read its remaining bytes after
the producer recovers. A malformed complete line is an error, not an event to
skip. Persist the stream position only through complete records, and deduplicate
delivery by `id` across rereads and restarts. Replaying from byte zero yields
the same identities. Readers may ignore added fields, but must reject an
unsupported `version`. Delivery and its retry/checkpoint transaction belong to
the consumer; this interface makes no exactly-once delivery claim.
