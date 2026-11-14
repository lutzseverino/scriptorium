# Host installation and configuration

One factory process serves every repository its host configuration lists. It
reads each repository's issues and pull requests from its
[hosting platform](#hosting-platform), keeps a clone of it, launches agents in
sandboxes built from the repository's toolchain image, and records what it is
doing in a status file. Every repository shares one queue: configured high
priority first, then normal, then low; an issue without a priority label counts
as normal. Within a priority, older issues go first, then repository name and
issue number break ties. Provider caps and usage thresholds apply across all
of them, and priority overrides no gate, hold or readiness requirement.

## Install and start

The owner must set up the `scriptorium-v*` tag ruleset before the first host
installation, as the [release procedure](../development/release.md) describes.
Install pnpm 11 (the package pins 11.28.8), then check out a Scriptorium release tag (`scriptorium-vX.Y.Z`) of
`lutzseverino/scriptorium`, then from the checkout's root install the runtime
dependencies and start the process with the host configuration's path:

```sh
pnpm install --prod --frozen-lockfile
node src/main.ts /etc/factory/host.json
```

This manual installation runs on the host and does not inherit the toolchain
image's store setting. Production-only installation still uses a pnpm content
store. Keep the platform default when suitable; if it selects a path inside
the checkout or one the installing user cannot write, choose an external
directory owned by that user:

```sh
export pnpm_config_store_dir="$HOME/.local/share/pnpm/store"
pnpm store path
pnpm install --prod --frozen-lockfile
```

If home is restricted, use another writable absolute path outside the checkout.
pnpm 11 also supports `--store-dir /absolute/writable/store` on the install and
`store path` commands, or `storeDir` in the user's global YAML configuration;
`npm_config_store_dir` and non-authentication `.npmrc` settings are not read.
No existing cache needs deleting or migrating. The homelab automated updater
already passes its own explicit staging store with `--store-dir`, outside the
extracted source, and needs no additional image-derived setting.

Releases up to `scriptorium-v1.0.5` were published from
`lutzseverino/repo-canon`, with the package in its `factory/` directory; a
checkout of one of those tags installs and starts from `factory/` instead. A
host that updates on its own lists the releases of `lutzseverino/scriptorium`
for newer versions, since later releases are published only there.

The process needs stable Node.js 24 or 26 (24 is the default), Git and Docker
on its `PATH`, and runs until it is stopped;
[restarts](#restarts) describes stopping it. It builds sandbox images with its
own user's UID and GID, with the Docker daemon's own builder unless
`imageBuilder` opts into the [factory builder](#the-factory-builder), which
also needs Docker's Buildx plugin;
[sandbox image retention](#sandbox-image-retention) describes what the
factory removes. An unreadable, malformed or invalid host configuration stops
it at start with every problem named. The host keeps its own service setup:
the service definition and its `PATH`, the provider credential files, and the
host configuration itself.

## Host configuration

The host configuration is one JSON file. Every field is required except
`providers.claude-code.usageCredential`, `implement`, `imageBuilder`, `imageRetention`, `imageStorage` and
the fields whose default the table below gives. Unknown fields are refused,
and nothing comes from environment variables.

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
    "effort": "high",
    "default": "claude-sonnet-5-5",
    "retry": "claude-opus-5-5@xhigh",
    "metadata": {
      "claude-sonnet-5-5": { "guidance": "Routine implementation and triage" },
      "codex/gpt-5.5": {
        "guidance": "Complex implementation",
        "effort": "xhigh"
      }
    }
  },
  "timeLimitMinutes": 240,
  "usage": {
    "drainThreshold": 90,
    "pauseThreshold": 95,
    "afterDrain": "auto-resume"
  },
  "pollSeconds": 300,
  "platforms": {
    "github": {
      "tokenCommand": ["/usr/local/bin/factory-token"],
      "authorizedRoles": ["admin", "maintain"],
      "neverAuthorize": ["dependabot[bot]"]
    }
  },
  "unpushablePaths": [".github/workflows/"],
  "stateDirectory": "/var/lib/factory",
  "gitIdentity": { "name": "factory[bot]", "email": "factory@example.com" },
  "imageBuilder": "daemon",
  "imageRetention": { "obsoletePairs": 3, "cacheMinimumAgeHours": 24 }
}
```

| Field                                   | Value                                                                                                                                                                                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repositories`                          | A non-empty list of distinct `<owner>/<name>` GitHub repositories the factory serves.                                                                                                                                                                |
| `providers.<name>`                      | One entry per provider the host runs, named `claude-code` or `codex`. Only these providers are in the registry.                                                                                                                                      |
| `implement.total`                       | Optional whole nonnegative safe integer limiting simultaneous implement sandboxes across all repositories and providers. Zero admits no implement; omitted means no host-total implement restriction.                                                |
| `implement.perRepository`               | Optional whole nonnegative safe integer limiting simultaneous implement sandboxes in each repository across providers. Zero admits no implement; omitted means no per-repository implement restriction.                                              |
| `providers.<name>.cap`                  | The whole number of sandboxes that provider may run at once across every repository.                                                                                                                                                                 |
| `providers.<name>.credential`           | The absolute path of the launch credential: the Claude Code setup-token file, or the Codex login (`auth.json`). Claude also uses it for usage reads when `usageCredential` is omitted.                                                               |
| `providers.claude-code.usageCredential` | Optional absolute path of a host-renewed Claude interactive-login copy, used only for usage reads. A configured but unusable copy never falls back to the launch token. See [Claude usage login](#claude-usage-login).                               |
| `models.default`                        | The model an issue's implement attempt runs on without a model label or a [model policy](#model-selection) preference, and a triage or review run's without `models.triage` or `models.review`.                                                      |
| `models.triage`                         | Optional default model for [triage runs](factory-configuration.md#run-kinds). Without it, triage takes `models.default`.                                                                                                                             |
| `models.review`                         | Optional default model for review runs. Without it, review takes `models.default`. Only an explicit value is a review's [provider diversity](#provider-diversity) alternative.                                                                       |
| `models.allowed`                        | Optional non-empty list of unique model names, without efforts. Every entry must resolve through a configured provider. Default and retry must be listed; provider and model are compared, ignoring effort. Without it, no membership check applies. |
| `models.retry`                          | The model a failed first implement attempt retries on, unless the repository's model policy prefers another.                                                                                                                                         |
| `models.effort`                         | Required nonempty host-wide reasoning effort. Each provider validates it wherever it is effective. There is no implicit adapter default.                                                                                                             |
| `models.metadata`                       | Optional object keyed by model identity, with nonempty `guidance` and/or an `effort` override per entry. Metadata must stay within configured providers and `models.allowed`.                                                                        |
| `timeLimitMinutes`                      | How long a run may take before it is stopped, and its sandbox's idle limit.                                                                                                                                                                          |
| `usage.drainThreshold`                  | The provider usage percentage, from 0 to 100, at or above which that provider claims no new issue, or `null` for none. See [usage thresholds](#usage-thresholds).                                                                                    |
| `usage.pauseThreshold`                  | The provider usage percentage, from `usage.drainThreshold` to 100, at or above which that provider's running runs stop too, or `null` for none. Optional; the default is `null`.                                                                     |
| `usage.afterDrain`                      | What reopens a drained provider's claims: `auto-resume`, a reading below the drain threshold, or `owner-resume`, only the owner's [resume command](#owner-holds-and-resume). Optional; the default is `auto-resume`.                                 |
| `pollSeconds`                           | The wait between passes.                                                                                                                                                                                                                             |
| `platforms.<name>`                      | One entry per [hosting platform](#hosting-platform) the served repositories are on; `github` is the only one. A repository on a platform without an entry isn't served.                                                                              |
| `platforms.<name>.tokenCommand`         | The executable and leading arguments that print a token for a repository on that platform. See [token command](#token-command).                                                                                                                      |
| `platforms.<name>.authorizedRoles`      | The platform's role names whose holders' [readiness](#readiness) the factory accepts. On `github`: `admin`, `maintain`, `write`, `triage` or `read`.                                                                                                 |
| `platforms.<name>.neverAuthorize`       | Accounts whose readiness never counts under [person-applied authorization](#readiness), whatever their role. Factory-triage readiness uses its verified proof instead. Optional where the platform marks bots; required where it doesn't.            |
| `unpushablePaths`                       | Path prefixes inside a repository that the factory's GitHub App can't push, such as `.github/workflows/`. Unpushed commits under these paths fail without a retry, naming the paths; see [run outcomes](#run-outcomes).                              |
| `stateDirectory`                        | The absolute path of the directory the process owns.                                                                                                                                                                                                 |
| `gitIdentity`                           | The `name` and `email` that commits made from the clones carry.                                                                                                                                                                                      |
| `imageBuilder`                          | Where sandbox images build: `daemon`, the Docker daemon's own builder, or `factory`, the [factory builder](#the-factory-builder), whose old cache the factory then prunes. Optional; the default is `daemon`.                                        |
| `imageRetention.obsoletePairs`          | The whole number of obsolete sandbox image pairs kept across every repository, newest first; pairs in use stay beyond it. Optional; the default is 3. See [image retention](#sandbox-image-retention).                                               |
| `imageRetention.cacheMinimumAgeHours`   | The positive whole number of hours since its last use after which the factory builder's cache is pruned, when `imageBuilder` is `factory`. Optional; the default is 24.                                                                              |
| `imageRetention.cacheMaximumBytes`      | Optional positive whole-byte target for the factory builder's cache, independently of age. No default. Ignored in daemon mode.                                                                                                                       |
| `imageStorage`                          | Optional storage admission policy; omitted means no filesystem reserve. See [storage admission](#image-build-storage-admission).                                                                                                                     |
| `imageStorage.storePaths`               | Nonempty list of absolute existing directories identifying every local Docker content/snapshot store's filesystem.                                                                                                                                   |
| `imageStorage.cachePath`                | Absolute existing directory on the filesystem backing the factory builder's cache; required when storage admission and the factory builder are selected.                                                                                             |
| `imageStorage.reserveBytes`             | Positive whole-byte minimum available space required before starting each new build.                                                                                                                                                                 |
| `imageStorage.resumeBytes`              | Positive whole-byte recovery threshold, strictly greater than the reserve; required to release a storage hold.                                                                                                                                       |

A model is `<slug>` or `<provider>/<slug>`, optionally followed by
`@<effort>`, and must resolve to a configured provider; the
[providers](#providers) section describes the grammar.

The host operator maintains `models.allowed` in the host configuration, for
example `["claude-sonnet-5-5", "codex/gpt-5.5"]`. Names use the same provider
routing as `models.default`, without `@<effort>`; aliases resolving to the
same provider and model count as duplicates. Add every default, retry, triage,
review, label-selected and policy-selected model the host should run, and
restart the host after editing.
An unlisted `model:` label holds the issue with a comment instead of falling
back to another model. Pickup and retry launch nothing until the label is
fixed or the operator lists that model. Interrupted, paused and merge
relaunches also wait if their recorded model has been removed from the list.
Omitting the list preserves unrestricted model selection.

### Host migration to v4.0.0

Supply `models.effort` explicitly before promoting a v4.0.0 candidate. To
retain a host's previous `high` effort, set `"effort": "high"` in `models`;
there is no inferred old-host effort or host schema version compatibility
layer. Validate the matching candidate configuration with the candidate's
read-only status command before promotion:

```sh
node src/main.ts status /path/to/candidate-host.json --json
```

This host migration is separate from the repository configuration v2/v3
[compatibility contract](factory-configuration.md). Existing recorded runs
keep their model and effort when resumed; capability restrictions still apply.

Host configurations from before `platforms` set
`"readiness": { "authorizedRoles": [...] }` and
`"github": { "tokenCommand": [...] }` instead. The factory still reads them, as
`platforms.github` without `neverAuthorize`, and refuses either alongside
`platforms`.

The factory owns its host configuration's settings, including each platform's
accepted roles and accounts that never authorize. A standards profile that
provides factory settings, such as Repo Canon's factory profile, supplies
defaults for them, but the factory reads only this file.

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

The factory runs the `tokenCommand` of the repository's platform with the
repository's `<owner>/<name>` appended. For the repository's own token, that
is its last argument. For a sandbox's token, a second argument follows: the
[run kind's permission set](#run-kind-token-permissions) as one JSON object, in
the form GitHub's
[installation token request](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
takes as `permissions`, such as
`{"contents":"read","issues":"read","metadata":"read","pull_requests":"read"}`.
The command must:

- exit 0 and print exactly one token, with no whitespace inside it, on
  standard output, within 60 seconds, after which it is stopped;
- print a token that stays valid for at least 45 minutes after it prints it,
  such as a newly minted GitHub App installation token, which lasts an hour;
- given a permission set, print a token narrowed to exactly that set, such as
  by passing it as the request's `permissions`, or fail.

The factory caches each repository's token, and each permission set's token
apart from it, and reuses each for 30 minutes after the command printed it,
then runs the command again. It refreshes the repository's token when a pass
needs it, and every minute, between and during passes, each running sandbox's
token within its run kind's permission set. The repository's token serves the
factory's own [platform](#hosting-platform) reads and writes and its Git
operations in the clone; it never reaches a sandbox. Only the
[sandbox's GitHub access](#sandbox-github-access) uses the narrowed tokens.

A command that fails, or prints no single token, pauses that repository for
the pass, with the failure as the reason in the process log and the status
file, and the other repositories continue. A sandbox's token that fails to
mint at launch launches nothing, and the claimed issue launches on a later
pass. A running sandbox keeps its last token, which is still valid, and the
factory retries the refresh every minute. The factory names the failure but
never logs the command's output.

### Run kind token permissions

Each [run kind](factory-configuration.md#run-kinds) gets a sandbox token
narrowed to its own GitHub App permissions. The factory fixes these sets;
neither the host nor the factory configuration names them. The App must hold
every permission a kind it runs requests, and the
[token command](#token-command) must narrow each token to its set: one that
ignores the set hands every sandbox the App's whole permissions.

| Run kind  | Permissions                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------- |
| Triage    | `contents`, `issues`, `metadata` and `pull_requests`: read                                            |
| Implement | `contents` and `pull_requests`: write; `actions`, `checks`, `issues`, `metadata` and `statuses`: read |
| Review    | `contents` and `pull_requests`: write; `actions`, `checks`, `issues`, `metadata` and `statuses`: read |
| Version 2 | `contents`, `issues` and `pull_requests`: write; `actions`, `checks`, `metadata` and `statuses`: read |

A triage run cannot comment, label or push. Implement and review cannot
comment on or label the issue either, but push, open, comment on and review
pull requests, and read the checks they wait on. A run in a repository on
[factory configuration version 2](factory-configuration.md#version-2) gets
implement's permissions with `issues` write as well, so its agent still asks
its question on the issue and adds the needs-input label. GitHub grants
merging with the `contents` write a push needs, so a token cannot withhold
merging from implement: with review on, only review's skill merges, and
without it, implement's does.

## Providers

The provider registry in `src/providers.ts` holds one adapter per provider the
host configuration names: Claude Code and Codex. Each adapter launches its
agent through Sandcastle, lists its reasoning efforts, routes bare model slugs
by its vendor prefix (`claude-*` or `gpt-*`), renders the configured skill and
arguments as an invocation (`/skill …` or `$skill …`), reads its usage, and
recognizes its own usage-limit error at the end of an ended run's raw log. Its launch credential
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

## Model selection

The host owns capabilities: the providers and models it can reach, their
efforts, `models.allowed` and the credentials. It also owns each run kind's
default: `models.default` for an implement attempt, `models.retry` for its
retry, and `models.triage` and `models.review`. A repository's preferences and
an issue's model label choose within those capabilities and never grant one.
Nothing model-specific is built into the factory; model identities are
configuration.

After choosing a model, the registry resolves effort in order: explicit
`@<effort>` on a label or host selection (or `effort` on a repository policy
selection), the chosen model's `models.metadata` override, then
`models.effort`. This applies to every run kind, fallback and diversity
alternative. The provider's accepted effort list still applies, including to
later explicit selections. A valid per-model override shadows the host effort
on that model. Metadata never selects a model, adds a provider, changes
`models.allowed` or grants a capability.

Metadata uses the resolver's canonical `<provider>/<model>` identity. Bare
and qualified aliases are deduplicated; conflicting metadata is refused.
Keys cannot contain `@<effort>`. The exposed catalog is the finite union of
metadata, default/retry/per-kind selections and `allowed` identities, sorted
by canonical identity. An unrestricted provider does not enumerate every
possible model. Guidance is optional, including on a configured default.

Model guidance is the host owner's short statement of which work a model in
the host's catalog suits, from which every launcher chooses a model by fit,
the cheaper one where several fit. A model without guidance is used only when
named for a launch or as a configured default. Triage receives validated
catalog, guidance, effort and default facts through the shared run prompt;
Repo Canon owns the judgment rule. Factory review and implement retry remain
deterministic under repository policy, host defaults and existing provider
diversity. Per-issue factory review-model selection remains deferred.

Each launch resolves its model in this order, and records the model and where
it came from (`selection` in its run record: `issue-label`, `policy`,
`host-default`, `fallback`, `diversity` or `recorded`):

- An initial implement attempt: the issue's model label, then the repository
  policy's `runKinds.implement.initial`, then `models.default`.
- An implement retry: the policy's `runKinds.implement.retry`, then
  `models.retry`.
- A triage or review run: the policy's `runKinds.triage` or `runKinds.review`,
  then `models.triage` or `models.review`, then `models.default`.
- A hand-back from review resolves as an initial implement attempt; an
  interrupted, paused or merge relaunch keeps the model it recorded.

A stage preference of `{ "source": "issue-label" }` reuses the issue's model
label, for example to keep retries on it; without a label that stage holds
with a model-label hold comment rather than inventing a model. Several,
unresolvable or unlisted model labels hold every continuation of the issue, as
before, whatever the stage would select. A policy preference outside the
host's capabilities holds the same way.

### Repository model policy

For version 3 factory configurations, the optional repository-owned
`.github/factory-model-policy.json` holds the repository's preferences.
Version 2 ignores this file and keeps its issue-label selection and host defaults.
The factory reads it from the same default-branch
revision as `.scriptorium/config.json`, never from a run's pull request. Without
the file, every launch takes the host's defaults, including `models.retry`.
A present file that is unreadable, not JSON or invalid pauses the repository
with its correction, as invalid configuration does; it never reads as absence.
Repo Canon checks the file's schema and ships no values.

```json
{
  "version": 1,
  "fallback": "host-default",
  "runKinds": {
    "triage": { "provider": "claude-code", "model": "claude-sonnet-5-5" },
    "implement": { "retry": { "source": "issue-label" } },
    "review": { "provider": "codex", "model": "gpt-5.5", "effort": "high" }
  }
}
```

`version`, `fallback` and `runKinds` are required; every kind and attempt is
optional and falls back to the host default. A selection is exactly
`{ "provider", "model", "effort"? }` or exactly `{ "source": "issue-label" }`;
an omitted effort takes the model override, then host effort. Unknown fields, mixed
selections and empty or untrimmed strings are invalid.

`fallback` says what a launch does when its chosen model is valid but
unavailable this pass, because its provider is at its cap, drained or under
an owner hold. `wait` keeps the same issue, work and PR waiting, with the
reason in the log and status file, and launches once the choice is available
or the policy changes. `host-default` launches on that kind's host default
instead when it is available, and otherwise waits. Neither starts a retry,
substitutes another model or changes the issue's label. Without a policy
file, an unavailable choice waits.

### Provider diversity

When the repository's configuration sets
`runKinds.review.differentProvider`, a review compares its chosen provider
with the provider of the implement attempt that produced the PR, including a
retry or a hand-back. A different provider satisfies it. When they match, the
only alternative is an explicit `models.review`: the review switches to it
when the repository has no model policy or its fallback is `host-default`, and
that model is available on another provider. Otherwise it runs on its choice,
and the log says provider diversity was unavailable. It never searches the
host's models for another provider and never waits for diversity alone.

## Repository conventions

Each repository names its labels, model label prefix and prompt in
`.scriptorium/config.json`, read from its default branch on every pass.
Scriptorium v4.0.0 reads repository inputs only from `.scriptorium/`,
with no legacy-directory transition; move both `config.json` and `Dockerfile`
there before upgrading the host. The v2/v3 configuration window is unchanged.
The [factory configuration schema](factory-configuration.md) documents those
required fields and the repository's ownership of readiness. The factory
knows no repository convention by default.

## Hosting platform

The factory reaches each repository's hosting platform, GitHub for now,
through [Postern](https://github.com/lutzseverino/postern), which reports the
platform's facts: issues, label changes, comments, repository roles, bots and
pull requests. Readiness, the queue and authorization stay the factory's own
decisions. Postern detects the platform from the repository's remote, and the
factory uses that platform's `platforms` entry for its token command, roles
and accounts. [ADR 0006](../adr/0006-reach-the-hosting-platform-through-postern.md)
records this boundary.

The factory refuses to serve a repository, as a paused repository with the
reason in the process log and the [status file](#status-file), while the
others continue, when:

- no platform adapter serves its remote;
- the host configuration has no entry for its platform;
- its platform marks no bots and its entry has no `neverAuthorize` list.

A platform failure, such as GitHub being unavailable or rate limiting the
token, fails that repository's reads for the pass, or the write it was making,
and the next pass tries again. The factory adds a state label before it
removes the one it replaces, so a write that fails part way never leaves a
claimed issue without one. It creates its state labels when they are missing
and leaves an existing label's color and description as they are.

## Readiness

The factory decides pickup itself from an issue's ready-label changes, the
repository's issue-contract validator's posted result, a parent's body edits
and links, and its blockers, as the platform reports them. It reads no issue
body and interprets no implementation contract. On GitHub its links and
blockers are native; on a platform without native links Postern reads them
from the issue's `Parent` and `Blocked by` sections, which the factory names.

- **Person-applied authorization.** Except for the factory's own triage run
  below, the account that last applied the ready label must be a person holding
  one of its platform's `authorizedRoles` now, by the role name the platform
  reports. The factory reads that account's repository role on every pass,
  once per account and repository. Readiness a bot or app applied never
  counts, nor does readiness from an account in `neverAuthorize`, whatever its
  role, or from an account without a role. A role it can't read holds the
  issue for that pass. The validator applies its own role rule as well, so a
  host can narrow who starts runs but never widen it; a refusal names the
  role.
- **Version 3 factory-triage exception.** With `runKinds.triage` on and
  `triageResult` configured, readiness the factory's own triage run applied
  counts without a role when its latest application is by `triageResult.author`
  and the validator's current result approves that event and verifies the
  factory proof. See [Triage readiness](factory-configuration.md#triage-readiness)
  for the proof rules. Every other contract-result check, parent rule and blocker
  rule still applies; a stale or non-approving result grants no readiness.
- **Contract result.** Whether readiness is bound to the issue's
  implementation contract is the validator's decision, which it posts on the
  issue. The factory reads, through Postern, the latest comment by the
  [configured](factory-configuration.md#contract-result) trusted author that
  carries a line `<!-- <marker> {…} -->` under the configured marker, and
  parses that line's JSON object. It reads format
  `repo-canon/issue-contract-state/v1`, as
  [Repo Canon v0.21.0](https://github.com/lutzseverino/repo-canon/blob/v0.21.0/docs/development/issue-contract-validation.md#published-result)
  publishes it. The ready label counts only when the result:
  - has that format;
  - is `approved`, names the ready label, and names the current ready-label
    event as its `reviewEventId`;
  - is newer than every comment created or edited on the issue, its body's
    last edit, its latest comment deletion and every label change, to the
    second. The factory's own hold comments, known by their exact marker and
    wording, its [run and action comments](#run-comments), known by their
    marker line and the bot account that posts them, and changes to the labels
    its configuration names, other than the ready label, don't count, so
    neither a hold comment, an edit of the run comment nor the running label
    written at pickup makes a result stale;
  - names a contract source, an Agent Brief comment or the issue body, that
    the platform still reports with the edit time the result records.

  A missing result, one whose format the factory doesn't read, an unreadable
  one, and one that doesn't approve the current ready-label event hold the
  issue with a hold comment. A result older than a change, or whose source has
  changed or gone, waits for the validator's next result, without a comment:
  the validator evaluates every comment, edit and label event, so its next
  result follows. So a triaged request whose body is edited after readiness
  runs once the validator posts a newer approving result, and a category label
  removed after an approving result holds the issue until the validator posts
  again. Comment deletions are GitHub facts the neutral comment port doesn't
  expose, read through Postern's authenticated `access.request`. An unreadable
  comment list or deletion history waits for access to recover. A platform
  that doesn't report body edit or comment deletion times can't show a result
  current, so it holds every ready issue. This is a pickup-snapshot guarantee,
  not an atomic lock against a contract edit after pickup.

- **Parent body revision binding.** A parent's ready label must be newer than
  its body's last edit, to the second. A title change or ordinary discussion
  doesn't count. After reviewing an edit, remove and re-apply the label.
  Whether an edit cancels another issue's readiness is the validator's
  decision.
- **Parents.** An open issue with native sub-issues in the same repository is
  a parent, and it never launches. Its sub-issue runs only while the parent's
  readiness counts and the parent has no open native blocker. With complete
  link history, additions at or after readiness keep it valid only when every
  link actor passes the same readiness policy: an authorized person who is not
  a bot or never-authorize account. An unauthorized, unknown or unreadable actor,
  or an unknown link time, holds the parent; a later authorized link never hides
  an earlier unauthorized one. Without complete history, readiness must be newer
  than the parent's latest sub-issue link, to the second. On a platform that
  doesn't report link times, the factory skips the link check. A native
  parent that is closed or in another repository holds nothing.
- **Closing.** An open issue whose readiness counts, with at least one native
  sub-issue and every sub-issue closed, in any repository, is closed with a
  comment listing them.

The contract result also gates retries, resumes after a needs-input answer,
child release and readiness-dependent parent closure. A retry that meets a
stale result waits instead of failing. Parent link-time and native-blocker
checks still apply.

With the version 3 triage run kind on, the factory writes the ready label only
when applying a triage run's done result, as `triageResult.author`, together with
the posted brief, as [Run results](#run-results) describes. It writes the ready
label in no other case. Under version 2, and under version 3 without
`runKinds.triage`, readiness comes only from an authorized person and the factory
never writes the ready label.

Refused readiness is a skip with its reason in the process log and the
[status file](#status-file).

### Hold comments

The factory comments on actionable holds: refused readiness (the actor, a
missing role, a parent's edit after readiness, or a missing, unknown-format,
unreadable or non-approving contract result),
a parent not ready under the parent rules above, a model-label error (several
labels, an unresolvable label or an unlisted model), and a repository paused
for its configuration, a [factory hold](factory-configuration.md#factory-hold),
and a release hold on merging. Each reason has one
marker-keyed comment on the held
issue. Changed details update it in place; a cleared reason edits it to say
it is resolved. Recurrence reuses that comment, including after a host restart.
Comments are never deleted.

Open blockers, including a parent's blockers, usage drains and owner holds,
provider caps and states already carrying labels or notices (running, paused,
needs-input, failed and skip) stay log-only. A transient unreadable role
lookup, a stale contract result and an unreadable comment list also stay
log-only. The [run, action and parent-close comments](#run-comments) keep
their own wording and lifecycle. If no valid repository configuration is
cached, including after a restart, the host cannot read its issues and posts
no hold comment.

Where the factory skips a parent's link check, on a platform that doesn't
report link times, the repository's issue-contract trigger removes readiness
when a ticket links to a ready parent. A missed event leaves stale readiness
in place; that weaker guarantee is accepted.

## Sandbox GitHub access

At launch the factory mints a token narrowed to the run's
[kind](#run-kind-token-permissions) and writes it, as GitHub CLI configuration
readable only by the host's user, into a directory of its own for that run,
and mounts the directory read-only at `/run/factory/github`.
The sandbox's environment points the GitHub CLI at that directory
(`GH_CONFIG_DIR`) and makes Git ask the GitHub CLI for its `github.com`
credentials, so neither reads the token from an environment variable. Each
time the run's token is refreshed, within the same permissions, the factory
replaces the files whole, so a run longer than a token's lifetime keeps its
GitHub access. Concurrent runs of different kinds in one repository each keep
their own kind's token, and the factory's own reads and refreshes never
replace it. The
factory removes the directory when the run's agent exits, so a token outlives
no run.

That installation token is the sandbox agent's only GitHub identity, so a push
that the GitHub App or the run kind's permissions don't allow stays refused.
The provider login a run signs in with adds none: the image's provider policy
turns off ChatGPT apps for Codex and claude.ai connectors for Claude Code,
which could otherwise act as the account's linked GitHub user. The
[sandbox image contract](sandbox-image.md#factory-agent-layer) gives the
details.

## Run results

Every run ends by leaving a run result: a JSON file its agent writes to
`/run/factory/result/result.json`. That directory is the run's own, writable,
and separate from the read-only token directory, and the factory reads the file
when the agent exits, before it removes the directory. The run's prompt states
the interface for its kind and repository. The object holds only these fields:

| Field     | Meaning                                                                                                                                                                                                                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outcome` | `done`, `stop` or `failed`.                                                                                                                                                                                                                                                                               |
| `state`   | For a triage run that is done, the ready label. For a stop, the label of whoever must answer: version 2's needs-input label, or a configured reporter, grill or owner state. No other result has one.                                                                                                     |
| `labels`  | Optional other labels to apply, each in a family [`runKinds.<kind>.resultLabels`](factory-configuration.md#run-results) lists. A label a role gives factory mechanics, such as running, failed, a stop, a gate or readiness, is refused; `skip` and the priority roles are not. A failed result has none. |
| `body`    | Markdown the factory posts on the issue, without a disclaimer, at most 60,000 characters.                                                                                                                                                                                                                 |
| `reason`  | One line of at most 300 characters on why the run ended; required when it failed.                                                                                                                                                                                                                         |

After the agent exits, the factory, not the agent, posts the body in its frame:
the configured disclaimer (the triage variant for a triage run), the body, a
line of run facts (kind, model, attempt, outcome and reason) and a marker
naming the run. A triage run's marker is the configured
[`triageResult.marker`](factory-configuration.md#triage-readiness), so its
brief backs the readiness it asks for. It then applies the requested labels and
the state together, and removes a triage run's triage label. A failed write
retries on the next pass without posting the comment again, and the run does
not settle until both land, so the comment and the labels always agree. Model
text is contained before it is posted: every `<!--` in the body or reason is
escaped, so it cannot open an HTML comment and forge the factory's or the
validator's marker. Pull request comments and review-thread replies during a
run stay the agent's own.

A missing or invalid result fails a run that exited by itself, with the reason,
whatever its pull request shows, and the factory posts and applies nothing it
asked for. A failed result fails the run with its own reason. Either retries as
any failed first implement attempt does. The process log records each result's
outcome and reason, or why it was invalid, when the agent exits. The run's
[completion signal](#foreground-execution-and-incomplete-runs) remains separate
loop control. The posted result's body also becomes the
[run comment](#run-comments)'s latest result, and its phase's line links it.

## Run comments

Each pass through the pipeline has one run comment on its issue, or on the
pull request of an independent review, from its first launch, triage or
implement on readiness, to merge or failure. Every run kind, stop and resume
of the pass edits the same comment in place, as
[ADR 0008](../adr/0008-split-work-into-run-kinds-handed-off-by-the-host.md)
records. It holds a heading with the pass's state, a checklist line for each
phase (Triage, Implement, Review and Merge) with its state and its latest
run's provider, model, effort, attempt, review round and result link, a pause
or failure on the line of the phase it happened in, and the latest run
result's body in a `<details>` block. Triage shows once it ran in the pass,
and Review once the repository turns review on. A phase that starts, and a
merge, finishes an earlier phase left running, paused or stopped. A failure after its pull
request closed or merged without closing the issue is the merge's.

The comment's last line is its marker,
`<!-- scriptorium:run {…} -->`, whose JSON holds each phase's facts, whether
the pass has ended and, after a stop releases the claim, its continuation:
the PRs and review the answered stop resumes on. The factory reads the
marker back on every write, so what the issue was told survives host
restarts without host state; it trusts only a comment its bot account posted.
A write after the pass merged or failed starts the next pass's comment, so a
retry after a failure, once its failed label is removed, starts a new one.

Progress writes, at each launch, posted result, pause and wait for merge, are
best-effort: a failed one is logged and the next write carries the state on.
A pass's final write, at merge or failure, a stop's continuation and every
action are required: the decision fails and retries on a later pass, and a
retry finds the same comment and posts no action twice. An unchanged comment
is not edited.

An action comment is posted fresh, once per occasion, only when a person must
act: when a run's stop leaves the issue in the reporter, grill or owner state,
when review stops at a gate, and when the run fails. It is one line naming the
label to act on, with a link to the run comment, and mentions nobody. Its
marker line names the run comment and the occasion, which makes a retried or
re-observed occasion find it. A version 2 stop under the needs-input label
gets no action comment: its agent asked on the issue itself. A pause, a
resume and a pull request awaiting merge edit only the run comment.

A parent whose sub-issues closed gets the close comment, posted fresh before
it closes. Hold comments stay separate, since holds precede claims. Every
comment's wording comes from the
[comment templates](factory-configuration.md#comment-templates).

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

| Path                                             | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status.json`                                    | The status file.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `events.jsonl`                                   | The append-only [operational event stream](#operational-events) for external delivery.                                                                                                                                                                                                                                                                                                                                                            |
| `events-state.json`                              | The process-owned event checkpoint and pending append, including its related usage or owner policy write. Keep it with the event stream across restarts.                                                                                                                                                                                                                                                                                          |
| `repositories/<owner>/<name>/clone/`             | The repository's clone. Each pass resets it to the remote's default branch, and runs branch from it.                                                                                                                                                                                                                                                                                                                                              |
| `repositories/<owner>/<name>/clone/.sandcastle/` | Sandcastle's run worktrees. The clone excludes this directory locally, so the repository need not ignore it.                                                                                                                                                                                                                                                                                                                                      |
| `repositories/<owner>/<name>/logs/`              | Each run's redacted log, `issue-<n>-attempt-<a>.log`.                                                                                                                                                                                                                                                                                                                                                                                             |
| `usage.json`                                     | Each provider's last good usage reading with when it was read and its reset, the earliest time the provider may be read again, and its usage hold with when it began and ends. It holds no credential or provider answer.                                                                                                                                                                                                                         |
| `owner.json`                                     | Each provider's [owner hold](#owner-holds-and-resume) with when it was set and the usage that set it, its reserve raise with its threshold, start and reset, whether it is draining, and the resume requests already applied whose files remain.                                                                                                                                                                                                  |
| `requests/`                                      | The resume requests the `resume` command queued and the running factory has not yet applied, one JSON file each, named by when it was queued.                                                                                                                                                                                                                                                                                                     |
| `repositories/<owner>/<name>/runs/`              | Each run's record, `issue-<n>-attempt-<a>.json`: its repository configuration, provider, model, effort, attempt, start, log, base commit, whether it exited or was interrupted, the pause a stop at the pause threshold fixed, its pause's cause, reset, time and deadline, its run result as read and whether its comment and labels landed, and whether the host settled it. What the issue was told lives in its [run comment](#run-comments). |
| `repositories/<owner>/<name>/sandboxes/`         | The private directories of runs whose agents are still running: each run's token directory, result directory and raw log.                                                                                                                                                                                                                                                                                                                         |

Scriptorium v4 reads no `repositories/<owner>/<name>/claims/` directory, which
earlier releases kept for awaiting-merge notices and stop continuations, and an
operator can delete it. A stop an earlier release recorded there resumes as a
fresh attempt on the issue's branch.

Sandbox images live in the host's Docker daemon, tagged as the
[sandbox image contract](sandbox-image.md) describes. The repository's
`.scriptorium/Dockerfile` is read from the clone on every pass.

## Run outcomes

Ended runs and orphaned claims use the same table, in order. Its first input is the run's [result](#run-results);
the platform and the run's branch decide the rest, and every ending without a
valid result that did not exit by itself: an orphaned claim, a run the factory
found orphaned on a restart or a timed-out run, and a record from before run
results. That fallback keeps
recovery evidence and the claim's continuation; it never turns a run that
exited by itself without a valid result into a success. Pull requests come
from the issue's closing references and its `factory/issue-<n>` branch. A
closed issue settles as done first. For an open issue, a merged PR's actual
closing-reference evidence determines completion. A stop, a question waiting
on an answer, takes precedence over an unmerged PR, even after timeout or
orphaning: version 2's configured needs-input label, or in version 3 any of
the configured triage, reporter, grill and owner states.

| First matching observation                                 | Run outcome    | Action                                                                                |
| ---------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------- |
| Issue closed                                               | Done           | Release the claim.                                                                    |
| A run that exited by itself without a valid result         | Failed         | Fail with the reason; retry an implement attempt 1 once.                              |
| A failed result                                            | Failed         | Fail with its reason; retry an implement attempt 1 once.                              |
| A stop result                                              | Stopped        | Release the claim once its state is applied, as for a stop label below.               |
| A triage run's done result                                 | Done           | Release the claim once its readiness and labels are applied.                          |
| Pull request merged with a closing reference to this issue | Done           | Close the issue and clear the claim's running, paused, needs-input and failed labels. |
| Pull request merged without a closing reference            | Failed, final  | Fail without retrying; the owner must decide whether the work finished the issue.     |
| A stop label present                                       | Stopped        | Release the claim and retain the existing work and PR context for resumption.         |
| Pull request open                                          | Awaiting merge | Show it on the run comment and keep the claim; assess a merge relaunch below.         |
| Unpushed commits under `unpushablePaths`                   | Failed, final  | Fail without retrying and name the paths.                                             |
| Anything else                                              | Failed         | Retry an implement attempt 1 once; fail attempt 2, a triage and a review run.         |

A triage run changes no code: its result decides it, and without one it ends
once its issue leaves the triage state, releasing its claim, and fails when it
ended with the issue still in triage. Every other done result leaves delivery
to the rows below it. With review on, a pull request left open hands off instead of awaiting
merge, as [run kinds](factory-configuration.md#handoffs) describe: an
implement run's PR starts review, and a review's PR left a draft starts a
hand-back to implement on the same PR, at most twice. A review that would
hand back a third time fails the issue because its rounds did not converge. A handed-off PR does not
await merge. A review that marked its PR ready and left it open
awaits merge like any other run.

An ended run awaiting merge shows it on the Merge line of its
[run comment](#run-comments), with why the run ended, and the factory retains
the claim without a live agent while it waits. The reason is the run result's,
or, without a result, what the factory observed: the time limit, or that no
factory run holds the claim. An eligible stale PR gets a merge relaunch as
described below. Otherwise the owner resolves the pull request by merging or
closing it; the factory keeps observing the outcome under the table above.
Merging does not always close the issue. Later polls and host restarts find
the comment already showing it and edit nothing, and a failed write retries
on a later pass. A failure, or a stop that waits on a person, also posts an
action comment.

The running label and an unsettled host run record are independent pickup
gates. Removing the running label alone leaves the host record holding the
issue, including after restart. Removing that label alone starts no new attempt
and does not authorize a merge relaunch.

The configured state labels have these meanings:

- `labels.running`: the factory holds the issue, including while awaiting merge.
- `labels.needsInput`: an owner question holds the work. Once answered, remove
  this label to resume the same work and PR, whether the PR is open or
  closed-unmerged. The run comment keeps the continuation across restarts and
  starts a fresh attempt 1 once the existing readiness, authorization, blockers,
  skip, repository, capacity and usage gates allow pickup. Its prompt directs
  the agent to preserve the PR, reviews, answers, handoff context and all local
  work, reopen the existing PR when needed, refresh the default branch, rebase
  or replay only this issue's changes and revalidate before delivery. It must
  never open a replacement PR; uncertain ownership requires an owner handoff.
- `labels.failed`: the run failed for good. Address its failure and remove the
  label to retry under the same pickup gates.
- `labels.paused`: provider usage paused the run; the factory resumes it
  automatically. Do not remove this label by hand.

These are configured strings, not fixed label names. Skipped work stays outside
factory pickup and follows its repository's designated merge handoff. A merged
branch-only PR is insufficient evidence to close an issue: only an actual
closing reference authorizes that completion.

Interrupted and [paused runs](#paused-runs) bypass the table and relaunch as
the same attempt. An orphaned claim with no interrupted or paused record uses
the table; an existing run record supplies its attempt number, and a claim
with no record counts as attempt 1. An issue carrying the configured running
or paused label that no run on the host holds is such a claim. Failing or
releasing a claim removes whichever of the two labels it carries, and a claim
kept awaiting merge or retried carries the running label. The run comment starts
no babysitting or retry attempt by itself and changes no outcome precedence.

### Merge relaunches

An optional [release hold](factory-configuration.md) makes merge relaunches wait
while another open PR carries `labels.releaseHold`, or the hold cannot be read.
It leaves implementation launches, retries and interrupted or paused runs
under their usual gates; a [factory hold](factory-configuration.md#factory-hold)
also holds those, and defers merges the same way. Release-held PRs resume after a successful clear read,
waiving only the behind requirement below. Sticky per-run evidence and the
release-held PR numbers persist in the run record; a merge run ended by a hold
does not consume its head. The issue's release-hold comment updates and resolves
in place across restarts.

Each pass assesses an ended run or orphaned claim awaiting merge for one
**merge relaunch** per PR head. Exactly one open, same-repository PR must be
owned by the run: its head branch is `factory/issue-<n>`, or its author matches
the factory identity successfully read through the supplied platform
connection. A closing reference alone, a person's unrelated PR, or an arbitrary
bot author grants no delivery ownership. If the identity read fails (including
an installation token's unsupported viewer read), only branch ownership counts;
the repository is neither paused nor failed for that failure.

The PR must target the refreshed remote default branch and be behind it:
`origin/HEAD` is not an ancestor of the PR head fetched by SHA into the clone.
Current-base PRs wait. Issues carrying the configured needs-input or failed
label and issues with a running sandbox get no merge relaunch. The configured
skip label reserves delivery for the orchestrating agent outside the factory,
so it also holds merge relaunches, including interrupted or paused delivery.
A failed label or an unresolved recorded model also holds that resumption.

A merge relaunch takes a provider cap slot and waits for the pause threshold
and for the repository to resume, as an interrupted run does. It keeps the
attempt, provider, model, effort and PR history of the run that opened the PR;
it consumes no retry. A label-only orphan uses its model label or the host's
default model, as pickup does. An unresolved model is logged and skipped.
The host persists consumed PR/head pairs before launch, across passes and
restarts. An unchanged consumed head stays awaiting merge. A new head is
assessed again: each advance of the default branch can earn another relaunch
when a head produced by previous recovery falls behind. The bound is per PR
head, not one recovery for the entire PR.

The merge-relaunch prompt identifies the same PR, head and current base, and
preserves dirty work, reviews and handoff context. The configured skill and
installed repository rules decide delivery, checks, review and merge
conditions. The prompt retains the delivery-push mechanism: fetch origin,
resolve its default branch, inspect outgoing history and diff, rebase or replay
only the issue's changes, and revalidate. Never merge the default branch into
the issue branch. Recovery-state instructions apply to restoring local state.

Repo Canon v0.19.1 has no branch-update recovery or final freshness guard: its
ruleset does not require strict check freshness. A default-branch advance
between the recovery push and merge can therefore still race, as on other
factory merges. Installing a Repo Canon release containing [#697](https://github.com/lutzseverino/repo-canon/pull/697)
freshness and branch-update recovery closes that window;
[#749](https://github.com/lutzseverino/repo-canon/pull/749) tightens freshness
confirmation. Code on Repo Canon main alone changes no installed adopter.

The relaunch ends through the same run-outcome table. Conflicts, failed
validation or checks, uncertain ownership and permission refusals require a
reasoned owner handoff with work preserved, without merging or switching
identity. The host observes Git ancestry and launches agents; delivery Git
operations and babysit remain the agent's responsibility. The existing
post-run restricted-path assessment keeps its role; no pre-push gate is added.

### External review of factory pull requests

On 2026-10-25 the owner accepted that Codex cannot be triggered by the
factory app, although a request from the owner's account works, and that no
settings fix is available. The [decision in issue #47](https://github.com/lutzseverino/scriptorium/issues/47#issuecomment-6400027564)
is to proceed with the factory's internal Standards and Spec reviews and no
external reviewer on its app-authored PRs. An owner can still manually request
Codex review. Runs use only their supplied credentials; they never switch to
the owner's account to trigger one.

The host adds unattended-execution, completion, supplied-credential and work
preservation context to every launch prompt, including retries and recovered
runs. It supplies observed holds as facts. It neither reads the repository's
external-review policy nor adds review or merge policy to the prompt. The
configured skill and installed repository guidance own that policy and its
request and wait workflow.

In this repository, `.github/factory-review-policy.json` contains version `1`
and the factory app's `author` login. The babysit request and wait commands
compare the PR's author with that login, accepting GitHub's REST
`<slug>[bot]` and CLI `app/<slug>` forms. Matching PRs get no external review
request or response/review wait on initial or later heads, including after
fixes, rebases and resumed runs. The separate
`.github/pull-request-reviewer.json` remains intact for owner-authored PRs.
Repositories without the app-author policy keep their configured reviewer
behavior for every PR.

Required checks and their waits, internal Standards and Spec reviews, merge
authorization and handling of review findings that actually arrive still
apply. The merge outcome comment records actual internal review outcomes and
states: "No external reviewer runs on app-authored PRs." Skipping external
review is neither a response timeout nor external approval.

### Delivery from the current default branch

Before every delivery push, including retries and recovered runs, the agent
refreshes the remote default branch and inspects both outgoing history and
the change against it. From the run's worktree:

```sh
git fetch --prune origin
git remote set-head origin --auto
git log --stat --patch -m origin/HEAD..HEAD
git diff --stat origin/HEAD...HEAD
git diff origin/HEAD...HEAD
```

Resolve the remote's default rather than assuming `main`. Review every
outgoing commit, including each merge parent's patch, for issue ownership.
A clean final workflow diff is insufficient: a workflow edit followed by its
revert, or an unrelated rewritten base commit, can still be outgoing history.
Keep intentional workflow edits visible; never strip them to make a push
succeed.

When the base has advanced, rebase the verified issue commits onto
`origin/HEAD`, or replay only those commits onto a new branch from it. Never
merge the default branch into the issue branch. Before changing history,
preserve the original head with a backup branch and retain staged, unstaged
and untracked work. For a verified issue-only dirty worktree, one option is
`git stash push --include-untracked`, record its object ID, and restore with
`git stash apply --index <saved-stash>` after rebase or selective replay. Keep
the backup and stash until the reconstruction and all worktree layers have
been verified. Preserve any additional ignored work separately. Recheck both
history and diff, review `git status` and the index, and rerun the repository's
required validation on the reconstructed change before publication.

Continue an existing PR and its review and handoff context where applicable;
reconstruction alone authorizes no force push or replacement PR. If ownership
is uncertain, an update or restoration conflicts, or publication needs an
owner decision, preserve the original work and ask under the repository's
owner-question rules. After a permission refusal, stop and hand off without
a second push, credential discovery or identity switch. Ask how to proceed
without assuming broader App permissions are necessary. A later owner request
can authorize reconstruction; the refusal itself cannot authorize a retry.

The shared clone's `updateClone()` refreshes its default branch before a
launch. The explicit Sandcastle branch strategy reuses an existing issue
branch and preserves its dirty worktree; that refresh does not update the
issue branch. Delivery Git operations belong to the implementation agent.
The host's history-aware restricted-path detection runs after an ended run or
claim, not as a pre-push gate. The exact Git operations behind the reported
[workflow-permission refusals in #49](https://github.com/lutzseverino/scriptorium/issues/49)
remain unverified. Local regression fixtures demonstrate rebase and selective
replay with an advanced default branch, hidden workflow history and preserved
dirty work; they do not reproduce a GitHub refusal or prove agent compliance.

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
The table above still applies: a signal without delivery or a valid run result
fails, while a valid PR or owner handoff remains valid without a signal. Runs use one Sandcastle
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
the preserved state again and tells the agent to continue from it and revalidate
before publication, following the [delivery procedure](#delivery-from-the-current-default-branch).
Continuing preserves work and existing PR, review and handoff context; it does
not require retaining unrelated history or override an owner's explicit
request to reconstruct the issue's changes on a current base. Recovery
performs no push or PR creation and grants no
readiness. Pauses and interruptions retain their existing relaunch rules.

For manual recovery after a final failure, retain the repository's clone and
`.sandcastle/` directory together. Inspect the run record and use
`git -C <clone> worktree list --porcelain` to locate its worktree. Review the
branch's commits and the worktree's `git status`, including its index and
untracked files. Continue in that worktree, or let the factory reuse it after
removing the failed label when the failure has been addressed. Revalidate the
recovered work before delivering it. An owner-directed reconstruction follows
the same preservation and history checks above, handing back preserved work
when ownership is uncertain or conflicts arise. Do not remove the clone or force-remove
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
replaces the issue's running label with the configured paused label and shows
the pause on its phase's line of the [run comment](#run-comments): the cause,
`usage limit` or `pause threshold`, the reset when known, and the run's model
and attempt. It asks nobody to act, since the factory resumes the run by
itself, and contains no log output. The paused label records that the issue
was told, so later passes and restarts don't repeat it.

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
Resuming shows the run running again on the same run comment. A relaunch that
hits the limit again pauses again, edited onto that comment, and nothing caps
the number of pauses.

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
`.scriptorium/Dockerfile` or agent layer builds a new pair and leaves the old one
obsolete. After each pass the factory removes its own obsolete pairs beyond
`imageRetention.obsoletePairs`, keeping the newest. A host that opts into the
[factory builder](#the-factory-builder) also has that builder's cache pruned
once it is at least `imageRetention.cacheMinimumAgeHours` old.

The factory keeps, whatever the allowance:

- every repository's current pair, which repositories with the same
  `.scriptorium/Dockerfile` share;
- a pair the image of a run that has not exited belongs to, even if its
  sandbox container does not exist yet;
- a pair whose image any container on the host uses, running or stopped,
  including an image a rebuild for a new UID and GID left untagged.

The allowance counts these kept obsolete pairs too, so when they reach it the
factory keeps them and no other obsolete pair: the host can hold more obsolete
pairs than `imageRetention.obsoletePairs` for as long as they are in use. A
pass removes nothing while any repository has no current image, because its
`.scriptorium/config.json` or `.scriptorium/Dockerfile` is unavailable, its image did
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

The factory never prunes the Docker daemon's own build cache or another
builder's: their records carry no owner, so nothing proves which cache is the
factory's.

Each removal, pruned cache, failed removal and failed inventory goes to the
process log. A failure never pauses a repository or fails a run: a removal
that fails leaves its pair in place, and an inventory that fails removes
nothing that pass.

### The factory builder

By default the Docker daemon's own builder builds sandbox images, as
`docker build` does: it reads base images the daemon already has, pulls the
others through the daemon's registry mirrors, and its build cache is the
operator's to manage, since the factory cannot tell its own cache from other
builds on the host.

With `"imageBuilder": "factory"`, the factory builds every sandbox image in its
own Buildx builder, `factory-sandbox`, which its first build creates with the
`docker-container` driver from the pinned `moby/buildkit` image. That needs
Docker's Buildx plugin. The builder's cache holds only the factory's builds,
so the factory prunes it by age after each pass and, when configured, toward its byte-size target. Base images in a
`.scriptorium/Dockerfile` are pulled by that builder, with the host user's Docker
login but without the daemon's registry mirrors, so a base image that exists
only in the local daemon does not build there. While its cache lasts, the
builder holds a second copy of the layers it built besides the images it loads
into Docker.

Either builder gives the same pair the same tag, so switching reuses the pairs
already built. Switching back to `daemon` stops the cache pruning; a factory
builder left from earlier stays, with its cache, until the operator removes it
with `docker buildx rm factory-sandbox`.

### Upgrading to retention

An existing host configuration needs no change, and its sandbox images still
build with the daemon's own builder: without `imageBuilder` and
`imageRetention`, the host keeps three obsolete pairs and prunes no build
cache. The first pass that prepares every repository's image after the
upgrade removes the obsolete pairs and served repositories' legacy images
beyond the allowance. Build cache stays in the Docker daemon's own builder,
mixed with other builds on the host, so the factory leaves it alone; whether
to prune it is the operator's choice.

## Image-build storage admission

Existing configurations keep their builder and need no migration. To enable
admission, identify the actual native local Docker content and snapshot stores,
including a separate containerd store when used. Verify their locations from the
host's daemon/containerd configuration and mount layout. Then set, for example:

```json
{
  "imageStorage": {
    "storePaths": ["/var/lib/containerd", "/var/lib/docker"],
    "reserveBytes": 16106127360,
    "resumeBytes": 18253611008
  }
}
```

These example paths must be replaced with this host's verified paths. A path is
an operator assertion about the store's backing filesystem, not an instruction
to discover or relocate a store. The checkout, process root and Docker data-root
alone do not identify every content/snapshot store. The host process needs to
see the same backing mounts as the native daemon. Docker Desktop/VM stores,
remote stores and unresolved mappings cannot be measured this way; leave the
policy disabled until a trustworthy native local mapping is available.
Loading an enabled `imageStorage` policy resolves every configured store and
cache path, checks that it is a directory and validates its local filesystem
reading. A missing, inaccessible, non-directory or unmeasurable path rejects the
configuration with its field, path and underlying error. This preflight uses the
loading process's effective identity and mount view; it runs no Docker command,
reclamation or admission-state write. Run deployment preflight as the actual
service identity with the service's mount visibility. An administrator's
successful parse does not prove that the service can access those paths.
A host wrapper's `check-config` calls the installed release's
`readHostConfiguration`; running that wrapper as another identity cannot
certify service access.

An explicitly configured readable parent or mount point can identify a store's
filesystem without traversing the private store directory. The host operator
must verify that it maps to every actual backing filesystem in the service's
mount view; a parent on a different mount measures the wrong filesystem.
Configure such a directory explicitly. The factory never climbs to an ancestor
or substitutes the process root when a configured child is inaccessible.

Enabled admission rejects non-Unix Docker endpoints and factory builders that
use a remote, different or multiple daemon endpoint. Missing, unreadable,
invalid or incomplete observations hold builds rather than fall back to a
measurement of the process filesystem.

For `imageBuilder: "factory"`, also set `imageStorage.cachePath` to an existing
directory on the verified backing filesystem of that builder's BuildKit volume.
When the builder has not yet been created, identify its future volume's backing
filesystem and use an existing directory there. Do not assume it shares the
image store. Store aliases on one device are measured as one filesystem, using
the lowest available reading; every distinct constrained filesystem must qualify.
`statfs` available blocks exclude space reserved from ordinary users.

The example uses a 15 GiB reserve and a configurable 2 GiB recovery margin
(resume at 17 GiB), as reviewed in issue #70. These are opt-in example values,
not global defaults. A byte is the configuration unit: 1 GB is 1,000,000,000
bytes; 1 GiB is 1,073,741,824 bytes. Choose both thresholds explicitly.

The host checks before a toolchain build, an agent-stage build, builder setup
and a factory bake. Below reserve it attempts only dedicated factory-cache
reclamation, then measures again. Daemon mode leaves all shared cache to the
host operator, even if an old factory builder exists. Existing image retention
still runs under its complete-current-image, reference and rollback protections;
a storage hold never relaxes those protections. No image pruning is attempted
as part of admission when the current image inventory is incomplete.

Once held, every constrained filesystem must reach `resumeBytes` on a fresh
reading. Equality at reserve admits an unheld build; equality at recovery
releases a held one. The hold survives host restarts in the private
`image-storage.json` record. Failure to record admission state also holds builds.
Existing-image reuse proceeds, and running work can finish. Storage pressure
alone consumes no attempt, changes no ticket readiness and creates no provider
usage hold, owner hold or paused run. Affected repositories wait for a later
pass to prepare their image.

A factory builder may additionally set `imageRetention.cacheMaximumBytes`,
with or without a filesystem reserve. Age pruning runs first. A separate
[Buildx prune](https://docs.docker.com/reference/cli/docker/buildx/prune/)
uses `--max-used-space` for the byte target; pressure also uses
`--min-free-space` at the recovery threshold, without an age filter, so recent
unused cache is expendable. Only `factory-sandbox` is selected. In-use cache
stays; failed pruning or reported cache remaining above the configured target
holds new builds. The post-prune check accepts Buildx JSON byte strings and unit-formatted
variants; the latter have the precision Buildx reports. Unsupported Buildx flags
or unreadable usage fail closed. A missing builder has no cache to prune.

The cache target and filesystem reserve are separate conditions. The host's
roughly 8 GB daemon GC target is host policy, not a factory-cache default.
Pruning a cache on another filesystem cannot recover an image store, and a
cache target cannot guarantee free space.

One host process serializes whole image preparations and cache maintenance;
each subsequent build measures again after the earlier operation completes.
This coordinates the factory's own work, not CI, external builders, other host
processes or growing running workloads. Those need host coordination and can
consume the reserve during an admitted build. Admission does not reserve bytes
or guarantee a build's peak disk requirement.

The private process log reports the hold. `status.json.imageStorage` exposes
`held`, `reason`, `observedAt`, the byte thresholds, each filesystem's identity,
configured paths and available bytes, and the reclamation pressure, freed-space
report and error. `held` includes configuration and measurement failures;
`reclamation.pressure` is true only after a fresh, valid observation below the
applicable reserve or recovery threshold. An unreadable path keeps admission
held, with the path and cause in `reason`, without implying storage pressure on
retries or after restart. Thresholds are null for a cache-target-only policy. These
diagnostics do not appear in the public provider event stream or issue comments.

## Repository pauses

A repository is paused for a pass, claiming and launching nothing there, when:

- its token command fails;
- its clone does not update;
- its `.scriptorium/config.json` is missing or invalid;
- it has no `.scriptorium/Dockerfile`, its sandbox image does not build, or storage admission holds a new build;
- its configured state labels cannot be created;
- its [hosting platform](#hosting-platform) isn't served;
- its platform reads fail;
- an open issue or PR carries its [factory hold](factory-configuration.md#factory-hold)
  label, or that hold cannot be read. A merge relaunch whose target PR alone
  carries the label still launches.

Its ended runs keep settling while its platform reads succeed, and the other
repositories continue. A repository pause is no [paused run](#paused-runs): it
never adds the paused label. Its reason appears in the process log and the
status file, and an actionable configuration hold gets a [hold comment](#hold-comments)
on affected issues when the host can read them using a valid configuration. A run whose sandbox is still running counts against its
provider's cap and time limit even while its repository can't be read.

## Read-only launch budget

From the installed package directory, read the host configuration and its
operational observations without starting the factory:

```sh
node src/main.ts status /etc/factory/host.json
node src/main.ts status /etc/factory/host.json --json
node src/main.ts status /etc/factory/host.json --json --live-usage
```

Text and JSON expose the same provider facts, in configuration order, and the
same normalized model facts from the validated host configuration. The
configuration is validated before any usage read. By default the command reads
local observations only. `--live-usage` also attempts the configured providers'
existing usage reads, honoring persisted read backoff. A failed read or an
answer with no usage window preserves a cached reading only for the existing
20-minute freshness period, and preserves a usage hold until its existing
deadline. Errors use safe categories, never provider responses or credentials.
The live read uses only configured host usage credentials; it grants no token
permission to a sandbox.

The command does not run a daemon pass, reconcile state, claim work, launch a
sandbox, apply or queue a resume, or write the factory's state. It leaves owner
holds in force through low and unknown usage. Reserve expiry and effective
thresholds use the same rules as the host, projected without saving changes.
Queued resume requests remain unapplied. Codex's existing usage adapter may
make its temporary private credential copy and remove it after reading; the
configured credential and factory records remain unchanged.

### Forward recovery of retained exited work

After upgrading from v4.1.1 or earlier, which counted exited runs awaiting
publication or ending observation as running, normal passes and supported
restart recovery restore truthful sandbox capacity for existing retained exited
runs. No record edits or deletion, cap increases, force-cleared claims or
replacement attempts are needed. A repository that cannot be read still retains
its exited work; passes continue to write status and provider observations.
Running sandboxes in that repository continue to occupy capacity until their
agent exits.

Publication resumes from its saved checkpoint once the repository and validator
prerequisites recover, preserving the result, run identity, attempt and PR
ownership. Publication, readiness, review and final settlement keep their
existing gates. A missing ending is never evidence of a paused run. Slot
recovery is not completed PR delivery: an open PR can still await review or
merge while its exited run consumes no running capacity. An unreadable or
older status observation remains unavailable under the rules below; absence
of trustworthy counts never establishes free capacity.

### Implement capacity

The optional host configuration object `implement` accepts `total` and
`perRepository` independently. No numeric defaults are installed. Every implement
sandbox must fit its provider cap and each configured implement limit, including
initial attempts, retries, resumption, interruption recovery, review hand-backs
and merge delivery that runs implement. Admissions consume slots immediately
within the same pass, preserving the existing queue priority and other gates.
Triage and review consume provider slots but no implement slots.

All dimensions count the same factory-managed sandboxes whose agent has not
exited. A sandbox still stopping counts until its agent exits. Pending result
publication, ending observation, paused or interrupted records, and claims
awaiting merge take no slot after exit. A posted result or an open PR alone does not prove exit.
A later launch reacquires capacity.
These caps neither end running work nor change usage or owner holds.

The `capacity` field in status JSON extends the existing version 1 projection:

- `counting: "non-ended-runs"` identifies the shared run-exit boundary: the
  run's agent has not exited, independently of its derived ending or settlement.
- `observation` has the same provenance shape as provider observations. Counts
  come from `status.json.capacity.observedAt` and are always `last-observed`;
  missing, legacy, unreadable, future or inconsistent snapshots and pending
  operational transactions make them `unavailable`. A live usage read does not
  establish work counts. The event checkpoint has no capacity fallback.
- `host` and each entry of `repositories` contain `runKinds` (runs whose agent has not
  exited: `implement`, `triage` and `review` counts) and `implement` with `limit`,
  `running` and `free`. Repository entries also name `repository`.
- Limits come from the validated configuration read by the command. A `null`
  limit means unset, with `free: null`; with a limit, free is
  `max(0, limit - running)`. Zero free means exhausted. Unavailable observations
  have `runKinds: null`, `running: null` and `free: null`, retaining the configured
  limit. Text renders unset limits explicitly and observed unrestricted slots
  as `unlimited`.

The host's atomic status file carries the same capacity shape with concrete
counts and its original `observedAt`, before the command adds provenance.
Provider holds and usage facts remain independent of these free-slot counts.
This mechanism accounts only for factory-managed sandbox admission. Independent
hand launches cooperate with observations; there is no registration interface,
shared booking service or serialization across launchers. Numeric free capacity
is no reservation or launch grant.

Homeserver's chosen values (one implement per repository, two per host) belong
to the separate [homelab configuration rollout](https://github.com/lutzseverino/homelab/issues/367)
and its [granted live acceptance](https://github.com/lutzseverino/homelab/issues/368),
using the released configuration interface. This generic source change installs
neither those values nor that deployment; guidance rollout remains separate.

### Observation provenance

There is no liveness or operational-observation timeout. Reading a file cannot
establish that a daemon is running or that its counts still describe running
sandboxes. Work counts are therefore always `last-observed`, with the original
provider observation time, including while the process is down. The newest
provider observation in `status.json` or the version 1 `events-state.json`
checkpoint supplies work facts. Missing, unreadable, legacy, future-dated,
duplicate or inconsistent count observations produce unavailable counts rather
than zeroes. An incomplete checkpoint transaction requires host recovery; the
command never replays it.

Separate `usage.json` and `owner.json` records supply usage and owner facts;
when those records have no provider observation, the operational snapshot can
supply explicitly last-observed facts instead. Each source's problem is named.
A successful live usage read makes only the usage observation `current`. It
cannot establish work counts or release an owner hold. A stale reading is
`unknown` after the existing freshness period even when its operational
snapshot is still available. Unknown usage without an active usage hold follows
the host's existing threshold behavior; this introduces no launch fallback.

The per-provider `observations` object has independent `work`, `usage` and
`owner` entries. Each has `state` (`current`, `last-observed`, or `unavailable`),
`source` (`status.json`, `events-state.json`, `usage.json`, `owner.json`, or
`provider`), `at` (ISO timestamp or `null`), and an optional safe `problem`.
For work and snapshot fallbacks, `at` is the provider observation time. For
cached usage it is the reading time when available; for separate owner records
and usage records with no reading it is the file modification time. A record's
modification time establishes no daemon liveness. `unavailable` has `at: null`.

### JSON contract, version 1

The command's JSON document has `version: 1`, `observedAt` (when inspection
began), and `providers`. Each provider reuses the operational fields documented
under [Status file](#status-file), with the following additions and unavailable
representations. Its `observedAt` identifies the projection time, while the
`observations` entries identify the underlying evidence. Configured caps and
thresholds come from the configuration read for this command.

| Field                                     | Meaning                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `counting`                                | `non-ended-runs`, identifying the shared run-exit boundary.                                                                                                                                                                                                              |
| `cap`                                     | The configured provider sandbox cap.                                                                                                                                                                                                                                     |
| `running`, `free`                         | Runs whose agent has not exited across all served repositories, and `max(0, cap - running)`, or `null` when work cannot be established.                                                                                                                                  |
| `paused`                                  | Last-observed paused work, including a sandbox stopping for a pause; `null` when unavailable.                                                                                                                                                                            |
| `retained`                                | Last-observed exited runs retained by the host, including unresolved endings, pending publication, paused and interrupted work and claims awaiting merge; `null` when unavailable. Paused work can be a subset of retained work.                                         |
| `claimsHeld`                              | Whether observed usage or owner control holds new claims; `null` when the observations cannot establish this.                                                                                                                                                            |
| `pausedRecoveryUsageHeld`                 | Whether usage holds paused-run recovery under the configured thresholds, without a reserve raise. Interrupted running-work recovery instead uses the pause threshold. Owner holds apply to new claims, not paused-run recovery. `null` means unavailable usage evidence. |
| `launchPermission`                        | Always `not-established`: this command grants no claim or continuation launch.                                                                                                                                                                                           |
| `pauseAtThreshold`, `drained`, `draining` | The operational facts, or `null` when required evidence is unavailable. `draining` means claims are held and last-observed running work remains.                                                                                                                         |
| `thresholds.effectiveDrainThreshold`      | The configured drain threshold with an applicable reserve raise, or `null` when disabled or owner control is unavailable; consult `observations.owner` to distinguish those cases.                                                                                       |
| `reason`                                  | The operational reason, or `unavailable` when observations cannot establish one.                                                                                                                                                                                         |
| `nextAction`                              | The operational advice, or `inspect-observations` when required facts are unavailable. This is advice about observed policy, never a launch grant.                                                                                                                       |
| `observations`                            | The independent provenance entries defined above.                                                                                                                                                                                                                        |

A `null` hold or reserve means no applicable hold or raise only when its
observation is available; with an unavailable observation it means no fact can
be established. `usage.state: "unknown"` does not mean zero usage. Independent
facts coexist: a provider can have positive `free` slots, paused work, both an
owner hold and a usage hold, and a reserve raise at the same time. The owner
hold takes reason precedence without hiding those other fields.

Ended runs, interrupted work awaiting relaunch, and retained claims awaiting
merge occupy no sandbox slot. A sandbox stopping at the pause threshold still
occupies a slot until its run ends. Counts describe factory-owned work;
independent hand-launched work is not registered by factory admission. A read
is neither an atomic slot reservation nor serialization between launchers.
Hand launchers cooperate with observed caps and holds, but must handle
unavailable or changed observations. Repository readiness, per-run pause
recovery and every other launch gate still apply even when `free` is positive
and an observed usage gate is clear.

The top-level `models` field (rendered as `models=<JSON>` in text) contains:

- `effort`: the required host-wide effort.
- `defaults`: normalized `default`, `retry`, `triage` and `review` selections,
  each with `provider`, `model` and resolved `effort`. Omitted per-kind defaults
  inherit the full `default` selection, including explicit effort.
- `catalog`: one entry per canonical `identity`, with `provider`, `model`,
  optional `guidance`, optional `effort` override and `effectiveEffort` for a
  selection omitting effort. A default selection's explicit effort can differ
  from its catalog entry's effective effort.

Model facts come from the configuration validated for this command, rather
than the daemon's last pass; they do not assert daemon liveness or grant launch
permission. The status base and this model extension ship together in v4.0.0.
Hand launchers read this single projection for both budget and model facts.

Consumers should check `version`, inspect provenance and unavailable values,
and allow additive fields. Implement capacity and run-kind counts use the same
admission projection. This command does not read orchestration threads or
implement the downstream records view.

Exit status is `0` for an observation (including unavailable facts), `1` for
invalid or unreadable host configuration, and `2` for malformed arguments.
Warnings and configuration errors go to stderr, leaving JSON stdout parseable.

## Status file

After every pass the factory replaces `status.json` whole. It lists each
repository in the host configuration's order with its state, `running` or
`paused` with the reason, and the issues the pass held with their skip reasons.
It also lists every configured provider in configuration order, even with no
frontier issue or running work. A repository with active merge relaunches has
`mergeRelaunches` entries naming each `issue`, `pullRequest` and `headCommit`;
these distinguish delivery recovery from pickup and failure retries. The
factory posts no status to GitHub.

Each `providers` entry has the following version 1 operational contract,
also used by the event stream's `state` field. Times are UTC ISO 8601 strings;
percentages are numbers. The snapshot's `updatedAt` identifies the pass, and
each provider's `observedAt` identifies that observation.

| Field                                 | Meaning                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`, `observedAt`              | Provider name and observation time.                                                                                                                                                                                                                                                               |
| `usage`                               | `{ "state": "known", "reading": { "used": 92, "at": "…", "reset": "…" } }` for a fresh reading, or `{ "state": "unknown" }`. The reading's `at` is when it was obtained; `reset` is optional. A fresh cached reading remains known after a failed read.                                           |
| `usageHold`                           | Automatic usage hold: `used`, `at`, optional `reset`, and fixed `since` and `until`; otherwise `null`. Its evidence still applies when `usage` is unknown.                                                                                                                                        |
| `ownerHold`                           | `{ "since": "…", "used": 92 }`, or `null`. `used` is `null` for recovery from an unreadable owner record. Only an owner resume releases it.                                                                                                                                                       |
| `reserve`                             | `{ "drainThreshold": 94, "since": "…", "until": "…" }`, or `null`. `until: null` means no reset has been reported yet.                                                                                                                                                                            |
| `thresholds`                          | Configured `drainThreshold`, `pauseThreshold`, `afterDrain`, and `effectiveDrainThreshold` for new claims after a reserve raise. Disabled thresholds are `null`.                                                                                                                                  |
| `running`, `paused`                   | Counts across all repositories, including unreadable repositories. Only runs whose agent has not exited occupy slots; pending publication and unresolved endings after exit take no slot. A run stopping at the pause threshold counts as running until exit and as paused from the stop request. |
| `counting`, `cap`, `free`, `retained` | New host observations include `counting: "non-ended-runs"`, the configured cap, nonnegative free slots, and retained exited work, including unresolved endings. Older observations lack this boundary marker, so the status command cannot use their counts.                                      |
| `claimsHeld`                          | Whether usage or the owner holds new claims, independently of repository readiness and capacity.                                                                                                                                                                                                  |
| `pauseAtThreshold`                    | Whether usage in force reaches the pause threshold, including when there is no sandbox to stop.                                                                                                                                                                                                   |
| `drained`                             | New claims are held and no running work remains. This is an observation, never a latch on recovery.                                                                                                                                                                                               |
| `reason`                              | `owner-hold`, `pause-threshold`, `drain-threshold`, or `available`, in that precedence order.                                                                                                                                                                                                     |
| `nextAction`                          | `owner-resume`, `wait-for-usage`, or `claims-allowed`. A resume can still meet a usage threshold; a reserve raise never overrides the pause threshold. Paused runs retain their separate automatic recovery.                                                                                      |

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
      "reason": "it has no .scriptorium/Dockerfile",
      "held": [
        {
          "issue": 2,
          "reason": "acme/gadgets is paused: it has no .scriptorium/Dockerfile"
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
run comment's pause line remains separate.

Every newline-terminated UTF-8 JSON record contains `version: 1`, `id`,
`sequence`, `type`, `provider`, `observedAt`, `reason` and `state`. `state` is
the complete provider observation described above, at that transition. No
credential, provider response body, free-text reset, or raw agent output is
included. `reason` uses the fixed categories below, rather than provider text.

| `type`                | Transition and `reason`                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `held`                | An automatic usage hold (`usage-hold`) or owner hold (`owner-hold`) begins. They are separate records.                                                                                                                          |
| `released`            | That hold ends, with `usage-hold` or `owner-hold` identifying which. A usage release can follow a low reading, reset, fallback deadline or configuration change; it does not release an owner hold.                             |
| `drain_started`       | New claims become held; `reason` is the provider state's hold reason. Running work continues below the pause threshold.                                                                                                         |
| `drained`             | A held provider has no running work (`no-running-work`). With zero running work at the start, this follows `drain_started` immediately. It does not delay reopening claims on a low reading.                                    |
| `paused_at_threshold` | Usage in force first reaches the pause threshold (`pause-threshold`), including with zero running work. This records the threshold observation; individual sandbox stops and their run comments follow the usual run lifecycle. |
| `reserve_granted`     | An accepted owner request grants a reserve raise (`owner-request`), including a repeated request for the same threshold.                                                                                                        |
| `resumed`             | An owner request is accepted (`owner-request`), or new claims automatically reopen (`claims-reopened`). An accepted request can leave usage holding claims; inspect `state.claimsHeld` and `nextAction`.                        |

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
