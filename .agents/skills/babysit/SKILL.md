---
name: babysit
description: Babysit an opened pull request through checks and review until it merges. Use right after opening a pull request, or when asked to babysit or land one.
---

Take the pull request to its merge. `CONTRIBUTING.md` and the
`github-repository-configuration` rules hold the merge conditions and the
wording rules.

The bundled scripts require Node.js 24 or 26. The wait reads the optional
`.github/pull-request-reviewer.json`, whose schema the
`github-repository-configuration` rules state; without the file, it reports
only checks.

Before the first wait, run `node <this skill's directory>/request.mjs <number>`
in the repository root. It applies the repository's optional
`.github/factory-review-policy.json` before the configured request rule.
That policy names the factory app's author login; matching PRs skip external
review requests and waits on every head, including fixes, rebases and resumed
runs. Other authors keep the configured reviewer behavior. With no policy
file, the configured reviewer behavior applies to every author.

1. Wait with `node <this skill's directory>/wait.mjs <number>`, run in the
   repository root in the foreground until it exits; it waits for the checks
   and the configured reviewer's review of the head, silently. Use a command
   timeout of 600000 ms where supported, and ask for the longest wait each
   time the command yields. The exit code
   says what comes next. Here, "checks passed" also covers a head with no
   check that the `github-repository-configuration` rules count as passed:
   - `0`: checks passed and the configured reviewer reviewed, no reviewer is configured, or the app-author policy skipped external review; go to step 2. A skipped review is not a completed external review.
   - `2`: the listed checks failed; go to step 2.
   - `3` or `4`: checks passed and the configured reviewer did not review this head (`3`
     unavailable, `4` for the reason its line gives); go to step 2 and follow
     the `github-repository-configuration` rules for merging without that
     review.
   - `5`: still waiting; run it again.
   - `1`: follow [Credentials](../../../CONTRIBUTING.md#credentials) for a
     permission refusal; otherwise fix the invocation or other `gh` error and
     run it again.

2. Inspect the PR's reviews and review threads, including findings that arrived
   on a PR whose external review was skipped. Verify each failing check and
   review finding against the source.
3. Fix the real findings `CONTRIBUTING.md` does not let you decline, and answer
   every review thread as it requires, following its
   [comment rules](../../../CONTRIBUTING.md#comments).
4. After a push that fixes a review finding, run
   `node <this skill's directory>/request.mjs <number> --fixes-review`.
   It applies the same app-author policy and configured request bound. Other
   pushes get no new request. After any push, return to step 1.
5. Once the merge conditions hold on the latest head, run
   `node <this skill's directory>/merge.mjs <number> <SHA>`, where `<SHA>` is
   the full SHA that starts the wait's latest line. Exit `0` means merged;
   `2` means the head changed, so return to step 1; `3` means it did not merge
   and needs the owner, so hand off with a question under
   [Comments](../../../CONTRIBUTING.md#comments), without retrying the merge;
   `1` means follow
   [Credentials](../../../CONTRIBUTING.md#credentials) for a permission refusal;
   otherwise fix the invocation or other `gh` error and
   run it again.
6. For a PR whose external review was skipped, post one merge outcome comment
   under the contribution guide's comment rules. Include exactly:
   `No external reviewer runs on app-authored PRs.` Record the actual Standards
   and Spec review outcomes and the checks that passed. Describe the external
   review as skipped by repository policy, without a response timeout or
   external approval. For other PRs, follow the configured reviewer's outcome
   comment rules. Stop.
