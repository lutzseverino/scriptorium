# Factory release procedure

Scriptorium is released from this repository with its own SemVer in
`package.json`. Its annotated tags are `scriptorium-vX.Y.Z`. The release stream
began in [`lutzseverino/repo-canon`](https://github.com/lutzseverino/repo-canon),
which published `scriptorium-v1.0.0` through `scriptorium-v1.0.5` with the
package under `factory/`. Those tags and releases stay there, at their original
objects. This repository continues the same stream from `scriptorium-v1.0.6`.
A version published in either repository is never published again, and
releases here start above `scriptorium-v1.0.5`.

## Owner-only tag setup

Before the first release or a host installation, the owner must configure an
active repository **tag ruleset** targeting `scriptorium-v*`. Enable [Restrict creations, Restrict updates and Restrict deletions](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
and add only the owner's account to the bypass list with Always permission.
GitHub supports [individual users as bypass actors](https://github.blog/changelog/2026-05-07-repository-rulesets-user-bypass-and-branch-renaming/).
Do not grant that bypass to GitHub Apps, agents, other accounts, or a role that
includes them. Restricting deletion keeps a published tag permanent. Verify
that the owner can create a matching tag and no other actor can create,
update or delete one. This ruleset is a setup requirement, not something a release agent
may bypass. A factory tag selects code the host runs, so only the owner's
account creates and pushes it.

## Choose the version

Breaking changes change the host configuration schema, the factory
configuration schema (`version` major), or the sandbox image contract. They
require a new major and a deliberate host update; the host stays on its pinned
major otherwise. Compatible capabilities receive a minor and compatible fixes
receive a patch.

## Prepare the release pull request

Each release is one pull request into `main`, titled `<type>: release vX.Y.Z`
for compatible releases: use `feat` for a capability, `fix` for a fix, or
`chore` for maintenance only. A breaking release is titled
`feat!: release vX.Y.Z`. The pull request updates `package.json` and
`package-lock.json` together, and carries the changes needed for the release.
Nothing is committed for the release after it merges.

Follow the [contribution guidelines](../../CONTRIBUTING.md), including review,
the PR body, issue reference, and squash merge. The body names the version and
the previous factory tag, with its repository when that is
`lutzseverino/repo-canon`. It summarizes the package diff since that tag,
reports the package typecheck and tests and the CI outcome, and carries draft
release notes. For breaking releases, include Impact and Migration, describing
the configuration or sandbox contract change and the ordered host migration.
Run the checks in the [development guide](README.md#setup-and-validation) on
the final commit.

## Publish and verify

Only the owner performs publication. In an up-to-date checkout of `main`,
set `factory_version` to the chosen SemVer and `factory_pr` to the merged
release pull request's number. Save the reviewed release notes in the task's
scratch directory and set `factory_notes` to that file's absolute path.
Read the reviewed head and merge commit, fetch both, and confirm the manifest
and lockfile at the merge commit both name `factory_version`:

```sh
factory_reviewed_head=$(gh pr view "$factory_pr" --json headRefOid --template '{{.headRefOid}}')
factory_merge=$(gh pr view "$factory_pr" --json mergeCommit --template '{{.mergeCommit.oid}}')
git fetch origin main "$factory_reviewed_head"
git show "$factory_merge:package.json"
git show "$factory_merge:package-lock.json"
```

Compare the entire released tree with the reviewed head before tagging. A
squash merge can include a change that reached `main` after the release's last
review. If the trees differ, stop and review the release again; checking the
version in the manifests alone cannot detect those bytes. The diff guard below
must succeed before the tag is created.

Tag that exact merge commit and create an ordinary GitHub Release:

```sh
git diff --exit-code "$factory_reviewed_head" "$factory_merge" &&
git tag --annotate "scriptorium-v$factory_version" "$factory_merge" \
  --message "Scriptorium v$factory_version" &&
  git push origin "scriptorium-v$factory_version" &&
  gh release create "scriptorium-v$factory_version" --verify-tag \
    --title "Scriptorium v$factory_version" --notes-file "$factory_notes"
```

A release below the newest published version, such as a fix to an older major,
passes `--latest=false` so that GitHub's latest release stays the newest
version.

Verify that the remote tag is annotated and peels to the merge commit, and
that the release is neither draft nor prerelease. Hosts find releases through
the release list, so also check that it shows the new release:

```sh
git ls-remote origin "refs/tags/scriptorium-v$factory_version" \
  "refs/tags/scriptorium-v$factory_version^{}"
gh release view "scriptorium-v$factory_version" --json tagName,isDraft,isPrerelease,url
gh api repos/lutzseverino/scriptorium/releases \
  --jq ".[] | select(.tag_name == \"scriptorium-v$factory_version\") | {tag_name, draft, prerelease}"
```

Release notes summarize factory changes and migration, with document links
pinned to the new factory tag. Append the merge commit, release pull request,
and verification outcomes to the GitHub release notes; keep no point-in-time
copy in the repository. Never move, delete, or retarget a published tag, in
this repository or in `lutzseverino/repo-canon`; issue a new version for a
correction.
