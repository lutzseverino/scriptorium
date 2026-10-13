# Host installation and configuration

One factory process serves every repository its host configuration lists. It
reads each repository from GitHub, keeps a clone of it, launches agents in
sandboxes built from the repository's toolchain image, and records what it is
doing in a status file. Every repository shares one oldest-first queue, and
provider caps and usage gates apply across all of them.

## Install and start

The owner must set up the `factory-v*` tag ruleset before the first host
installation, as the [release procedure](../development/release.md) describes.
Check out a factory release tag, then from its `factory/` directory install the
runtime dependencies and start the process with the host configuration's path:

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

| Field                         | Value                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `repositories`                | A non-empty list of distinct `<owner>/<name>` GitHub repositories the factory serves.                                                                                                      |
| `providers.<name>`            | One entry per provider the host runs, named `claude-code` or `codex`. Only these providers are in the registry.                                                                            |
| `providers.<name>.cap`        | The whole number of sandboxes that provider may run at once across every repository.                                                                                                       |
| `providers.<name>.credential` | The absolute path of the provider's one credential file: the Claude Code token file from `claude setup-token`, or the Codex login (`auth.json`). It is read at each launch and usage read. |
| `models.default`              | The model an issue without a model label runs on.                                                                                                                                          |
| `models.retry`                | The model a failed first attempt retries on.                                                                                                                                               |
| `timeLimitMinutes`            | How long a run may take before it is stopped, and its sandbox's idle limit.                                                                                                                |
| `usageThreshold`              | The provider usage percentage, from 0 to 100, at or above which that provider launches nothing.                                                                                            |
| `pollSeconds`                 | The wait between passes.                                                                                                                                                                   |
| `readiness.authorizedRoles`   | The repository roles whose readiness the factory accepts: `admin`, `maintain`, `write`, `triage` or `read`. The factory validates the list but does not check readiness authorization yet. |
| `unpushablePaths`             | Path prefixes inside a repository that the factory's GitHub App can't push, such as `.github/workflows/`. A run whose branch changes them fails without a retry, naming the paths.         |
| `stateDirectory`              | The absolute path of the directory the process owns.                                                                                                                                       |
| `gitIdentity`                 | The `name` and `email` that commits made from the clones carry.                                                                                                                            |
| `github.tokenCommand`         | The executable and leading arguments that print a GitHub token for a repository.                                                                                                           |

A model is `<slug>` or `<provider>/<slug>`, optionally followed by
`@<effort>`, and must resolve to a configured provider; the
[package README](../../README.md#providers) describes the grammar.

### Token command

Each pass runs `github.tokenCommand` once per repository with `<owner>/<name>`
appended as its last argument. It must exit 0 and print exactly one token on
standard output; it is stopped after 60 seconds. The factory uses that token
for its own GitHub reads and writes and its Git operations in the clone. A
failing command, or one that prints no single token, pauses that repository
for the pass without stopping the others. The factory names the failure but
never logs the command's output.

## Repository conventions

Every repository uses the same conventions. The factory picks up issues
labelled `ready-for-agent`, claims them with `factory:running`, and marks them
`factory:failed` or reads `factory:needs-input`; it never adds or removes the
ready label. A `model:` label names an issue's model. A run starts with the
prompt `<skill prefix>implement #<n>` on the branch `factory/issue-<n>`.

## Sandbox GitHub access

At launch the factory writes the repository's token, as GitHub CLI
configuration readable only by the host's user, into a directory of its own
for that run, and mounts the directory read-only at `/run/factory/github`.
The sandbox's environment points the GitHub CLI at that directory
(`GH_CONFIG_DIR`) and makes Git ask the GitHub CLI for its `github.com`
credentials, so neither reads the token from an environment variable. The
factory removes the directory when the run's agent exits. A token is not
refreshed during a run, so a run that outlasts its token loses GitHub access.

## State directory

The process owns everything under `stateDirectory`:

| Path                                             | Contents                                                                                                                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status.json`                                    | The status file.                                                                                                                                                                       |
| `repositories/<owner>/<name>/clone/`             | The repository's clone. Each pass resets it to the remote's default branch, and runs branch from it.                                                                                   |
| `repositories/<owner>/<name>/clone/.sandcastle/` | Sandcastle's run worktrees. The clone excludes this directory locally, so the repository need not ignore it.                                                                           |
| `repositories/<owner>/<name>/logs/`              | Each run's log, `issue-<n>-attempt-<a>.log`.                                                                                                                                           |
| `repositories/<owner>/<name>/runs/`              | Each run's record, `issue-<n>-attempt-<a>.json`: its provider, model, effort, attempt, start, log, base commit, whether it exited or was interrupted, and whether the host settled it. |
| `repositories/<owner>/<name>/github/`            | The token directories of runs whose agents are still running.                                                                                                                          |

Sandbox images live in the host's Docker daemon, tagged as the
[sandbox image contract](sandbox-image.md) describes. The repository's
`.factory/Dockerfile` is read from the clone on every pass.

## Restarts

A restart, such as for a factory upgrade or a changed credential file, never
spends a run's retry. On `SIGTERM` or `SIGINT` the process stops claiming and
launching, records each running run as interrupted, removes the sandbox
containers and exits without waiting for the runs to finish. On startup, before
it claims or launches anything, it removes every sandbox container an earlier
process left, then takes up the runs recorded as interrupted.

An interrupted run launches again as the same attempt, with the same model,
prompt and log, continuing its `factory/issue-<n>` branch and Sandcastle's
worktree for it, and keeps its claim meanwhile. It takes its issue's turn in
the queue and waits for its provider's cap and usage gate and for its
repository to resume. It continues as it would have without the restart, so a
readiness change or a new blocker does not hold it; it releases its claim
instead once its issue is closed or carries `factory:needs-input`. Its time
limit starts again at the relaunch.

A sandbox container is any container from a factory sandbox image, which
carries the `factory.agent.identity` label, so a host runs one factory process
and starts no other containers from those images.

## Repository pauses

A repository is paused for a pass, claiming and launching nothing there, when:

- its token command fails;
- its clone does not update;
- it has no `.factory/Dockerfile`, or its sandbox image does not build;
- its GitHub reads fail.

Its ended runs keep settling while its GitHub reads succeed, and the other
repositories continue. A run whose sandbox is still running counts against its
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
      "held": [{ "issue": 5, "reason": "blocked by #4" }]
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
standard output.
