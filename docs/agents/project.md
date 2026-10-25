# Scriptorium agent constraints

For PRs authored by the app named in
`.github/factory-review-policy.json`, skip external review requests and waits
under [issue #47](https://github.com/lutzseverino/scriptorium/issues/47).
This is the repository's explicit exception to the installed reviewer request
and wait rules; `.github/pull-request-reviewer.json` continues to govern other
authors. Apply it through the babysit skill's request and wait commands,
including after fixes, rebases and resumed runs. Keep the factory's Standards
and Spec reviews, checks, merge authorization and handling of arriving
findings. The merge outcome comment records the actual internal review
outcomes and states: "No external reviewer runs on app-authored PRs."

The [usage policy](../usage/host.md#external-review-of-factory-pull-requests)
records the owner's accepted limitation and manual review option.
