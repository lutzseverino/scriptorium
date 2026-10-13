# Factory release procedure

Scriptorium is the factory this repository releases, with its own SemVer
starting at 1.0.0 in `factory/package.json`. Its annotated tags are
`scriptorium-vX.Y.Z`, starting with `scriptorium-v1.0.0`; Repo Canon keeps its
`vX.Y.Z` tags.
Nothing under `factory/` is declared by `standards.yaml` or selected as a
Repo Canon release input. The live `.sandcastle/` runner stays in place until
the boundary work cuts over; this skeleton alone is not the runnable first
factory release.

## Owner-only tag setup

Before the first release or a host installation, the owner must configure an
active repository **tag ruleset** targeting `scriptorium-v*`. Enable [Restrict creations and Restrict updates](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
and add only the owner's account to the bypass list with Always permission.
GitHub supports [individual users as bypass actors](https://github.blog/changelog/2026-05-07-repository-rulesets-user-bypass-and-branch-renaming/).
Do not grant that bypass to GitHub Apps, agents, other accounts, or a role that
includes them. Also restrict deletion: a published tag is permanent. Verify
that the owner can create a matching tag and no other actor can create or
update one. This ruleset is a setup requirement, not something a release agent
may bypass. A factory tag selects code the host runs, so only the owner's
account creates and pushes it.

## Choose the version

Breaking changes change the host configuration schema, the factory
configuration schema (`version` major), or the sandbox image contract. They
require a new major and a deliberate host update; the host stays on its pinned
major otherwise. Compatible capabilities receive a minor and compatible fixes
receive a patch.

Factory releases do not change Repo Canon's version or its required Repository
Standards CLI version. Keep factory and tool version mentions in this package's
docs so the repository's version-agreement check does not read them as Repo
Canon or CLI versions.

## Prepare the release pull request

Each release is one pull request into `main`, titled
`<type>(factory): release vX.Y.Z` for compatible releases: use `feat` for a
capability, `fix` for a fix, or `chore` for maintenance only. A breaking release
is titled `feat(factory)!: release vX.Y.Z`, with `!` after the scope. The pull
request updates `factory/package.json` and its lockfile together,
and carries the changes needed for the release. Nothing is committed for the
release after it merges.

Follow the repository's [contribution guidelines](../../../CONTRIBUTING.md),
including review, the PR body, issue reference, and squash merge. The body
names the version and previous factory tag, summarizes the package diff,
reports the package typecheck and tests plus the shared checks, and carries
draft release notes. For breaking releases, include Impact and Migration,
describing the configuration or sandbox contract change and the ordered host
migration. Run the checks in the [development index](README.md#setup-and-validation)
and shared setup guide on the final commit.

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
git show "$factory_merge:factory/package.json"
git show "$factory_merge:factory/package-lock.json"
```

Compare the entire released `factory/` tree with the reviewed head before
tagging. A squash merge can include a factory change that reached `main` after
the release's last review. If the trees differ, stop and review the release
again; checking the version in the manifests alone cannot detect those bytes.
The diff guard below must succeed before the tag is created.

Tag that exact merge commit and create an ordinary GitHub Release that is
**not marked latest**, so Repo Canon's release remains GitHub's latest:

```sh
git diff --exit-code "$factory_reviewed_head" "$factory_merge" -- factory/ &&
git tag --annotate "scriptorium-v$factory_version" "$factory_merge" \
  --message "Scriptorium v$factory_version" &&
  git push origin "scriptorium-v$factory_version" &&
  gh release create "scriptorium-v$factory_version" --verify-tag --latest=false \
    --title "Scriptorium v$factory_version" --notes-file "$factory_notes"
```

Verify that the remote tag is annotated and peels to the merge commit, the
release is neither draft nor prerelease, and GitHub's latest release still
names a Repo Canon `v*` tag:

```sh
git ls-remote origin "refs/tags/scriptorium-v$factory_version" \
  "refs/tags/scriptorium-v$factory_version^{}"
gh release view "scriptorium-v$factory_version" --json tagName,isDraft,isPrerelease,url
gh api repos/lutzseverino/repo-canon/releases/latest --jq .tag_name
```

Release notes summarize factory changes and migration, with document links
pinned to the new factory tag. Append the merge commit, release pull request,
and verification outcomes to the GitHub release notes; keep no point-in-time
copy in the repository. Never move, delete, or retarget a published tag; issue
a new version for a correction.
