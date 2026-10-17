# GitHub repository configuration rules

These rules cover the repository's GitHub settings, the workflows Repo Canon
installs, and the optional pull request reviewer file. They apply to the whole
repository.

## Labels

The repository carries these canonical issue labels, with these colors and
descriptions:

| Label                 | Color    | Description                                                  |
| --------------------- | -------- | ------------------------------------------------------------ |
| `needs-triage`        | `fbca04` | Requires review or renewed review                            |
| `needs-info`          | `d4c5f9` | Waiting for information needed to evaluate the request       |
| `ready-for-agent`     | `0e8a16` | Reviewed and sufficiently specified for agent implementation |
| `ready-for-human`     | `1d76db` | Reviewed and requires human implementation                   |
| `wontfix`             | `ffffff` | Will not be actioned                                         |
| `bug`                 | `d73a4a` | Something isn't working                                      |
| `enhancement`         | `a2eeef` | New feature or request                                       |
| `wayfinder:map`       | `5319e7` | Planning map for related work                                |
| `wayfinder:research`  | `bfd4f2` | Research question in a planning map                          |
| `wayfinder:prototype` | `bfd4f2` | Prototype question in a planning map                         |
| `wayfinder:grilling`  | `bfd4f2` | Design decision requiring discussion                         |
| `wayfinder:task`      | `bfd4f2` | Task in a planning map                                       |

These rules name no `factory:` label: a factory creates its own state labels
from the repository's factory configuration.

## Merge settings

Squash merging is the repository's only merge method: merge commits and rebase
merging are disabled. The squash commit's default subject is the pull request
title and its default message is the pull request body.

Requiring the stable `PR metadata` check is a plan-gated requirement: the
default branch requires it wherever GitHub offers branch protection or rulesets
for the repository. On a private repository whose plan offers neither, the
requirement is unavailable, not optional, and applies once GitHub offers
either. GitHub runs the PR metadata validation workflow only from the default
branch, so the check is required once the workflow is on the default branch.

## Preserved settings

The GitHub configuration changes only the labels, merge settings, and required
check these rules name. Unrelated labels, rules, checks, and repository
settings stay as the repository has them.

## Installed workflow runners

Every installed job reads `vars.REPO_CANON_RUNS_ON`. Unset or empty selects
`ubuntu-latest`; a public repository normally leaves it unset. A private
repository that needs its own runners can set it to a JSON array of runner
label strings, for example `["self-hosted", "homelab"]`. The array must be
non-empty and contain only non-empty strings. A runner must carry every listed
label. Set the variable only when the repository has matching runners.
A repository's own workflows may read the same variable too.

An organization-level variable of the same name also reaches these jobs, and
a repository-level value takes precedence. The installed jobs use no
environments. Never rely on invalid values falling back: malformed JSON or an
unusable `runs-on` value makes every installed job fail during GitHub's
evaluation, before any steps run. The expression does not validate the value's
schema: parsed falsy JSON such as `false`, `0`, `null`, or `""` also selects
the hosted default, but such a value is still invalid.

The runners need `git`, `bash`, and network access for Node.js setup through
`actions/setup-node`. The factory profile's sandbox-image job also needs a
`docker` CLI with a daemon that can run `docker build`. A job with no matching
online runner waits in the queue for up to 24 hours and then fails.
Issue-contract feedback, and therefore readiness review, waits for those
runners too.

The sandbox-image job executes pull request workflow and Dockerfile content,
including content from forks. For repositories accepting untrusted pull
requests, keep the hosted default or select isolated, ephemeral self-hosted
runners with no secrets or sensitive network access. This applies to private
and internal repository forks too. A read-only workflow token does not prevent
untrusted code from compromising a persistent runner and later jobs. Every
runner matching the variable's labels must be suitable for that workload;
runner isolation is a host provisioning responsibility. See GitHub's
[self-hosted runner security guidance](https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners).

If the self-hosted runners are unavailable, return to GitHub-hosted runners by
deleting the variable or setting it to `["ubuntu-latest"]`, without editing
installed files. Deleting a repository-level variable exposes an inherited
organization-level value if one exists; set `["ubuntu-latest"]` to override
that value. A runner on another machine carrying the same labels takes the jobs
with no change at all. Changing the variable selects runners for new jobs;
cancel and rerun a job already queued on unavailable labels.

## Pull request reviewer file

The optional repository-owned `.github/pull-request-reviewer.json` names the
pull request reviewer and its wait bounds as data only. Repo Canon installs no
reviewer file or preset, and the factory does not read it. Without the file,
no reviewer is configured. When the file exists, it is valid JSON holding one
object with the fields below.

Every field is required except `finished` and `bounds.reviewRequests`. Unknown
fields are invalid, at every level.

- `version`: `1`.
- `account`: the reviewer's nonempty GitHub login, including `[bot]` when part
  of the login.
- `request.comment`: a nonempty, trimmed string. A request comment's whole
  trimmed body must equal it; a mention within other text never counts.
- `request.onOpen`: boolean; whether opening the pull request counts as a
  request. A push never counts.
- `finished`: optional object with a nonempty `commentMarker` and a nonempty
  `line`, a valid regular expression interpreted with the Unicode flag that
  has named `sha` and `at` groups.
- `unavailable`: array of nonempty reply texts; an empty array is valid.
- `bounds.responseMinutes` and `bounds.reviewMinutes`: positive finite numbers
  measured from the latest request.
- `bounds.reviewRequests`: optional positive integer; the total request bound
  defined in the contribution guide's Merging section.

A review of the pull request's head is complete when either holds:

- a GitHub review by `account` on the exact head approves, requests changes,
  has a nonempty body, or has an inline comment that starts a new thread. A
  pending review never completes one, and neither does a `COMMENTED` review
  with an empty body and only replies to existing threads;
- with `finished`, a comment by `account` containing `commentMarker` has a line
  matching `line` whose `sha` prefixes the head and whose `at` parses as a time
  at or after the latest request.

A comment by `account` at or after the latest request that contains one of the
`unavailable` texts marks the reviewer unavailable. Any comment by `account` at
or after the request counts as a response, except a request comment, which is
never a response. The reviewer did not respond when no response arrives within
`bounds.responseMinutes` of the latest request, and did not review when no
completed review arrives within `bounds.reviewMinutes` of it.

For example, with placeholder values:

```json
{
  "version": 1,
  "account": "example-reviewer[bot]",
  "request": {
    "comment": "@example-reviewer review",
    "onOpen": true
  },
  "finished": {
    "commentMarker": "<!-- example-review-summary -->",
    "line": "Reviewed `(?<sha>[0-9a-f]{7,40})` at (?<at>\\S+)"
  },
  "unavailable": ["example-reviewer is not enabled for this repository"],
  "bounds": {
    "responseMinutes": 5,
    "reviewMinutes": 30,
    "reviewRequests": 4
  }
}
```
