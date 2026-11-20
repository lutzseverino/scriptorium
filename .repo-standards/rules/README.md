# Installed rules

These rules come from https://github.com/lutzseverino/repo-canon v0.31.0, profile factory.
Repo Standards installs and verifies them; adopt again to change them.
Run `repo-standards rules <path>` to print the rules that cover a path.

- [`comments`](comments.md) covers the whole repository.
- [`documentation`](documentation.md) covers:
  - `GLOSSARY.md`
  - `docs/README.md`
  - `docs/adr/0001-keep-the-package-outside-repo-canon-release-inputs.md`
  - `docs/adr/0002-release-scriptorium-from-its-own-repository.md`
  - `docs/adr/0003-hold-each-provider-and-never-override-the-pause-threshold.md`
  - `docs/adr/0004-retain-sandbox-images-the-factory-can-prove-it-owns.md`
  - `docs/adr/0005-default-the-factorys-own-comment-wording.md`
  - `docs/adr/0006-reach-the-hosting-platform-through-postern.md`
  - `docs/adr/0007-read-the-contract-decision-from-the-validators-posted-result.md`
  - `docs/adr/0008-split-work-into-run-kinds-handed-off-by-the-host.md`
  - `docs/adr/0009-stand-in-a-broader-model-at-launch-by-provider-pace.md`
  - `docs/adr/0010-link-run-results-and-mention-whoever-must-act.md`
  - `docs/adr/0011-own-the-formats-the-factory-reads.md`
  - `docs/adr/0012-run-release-as-a-run-kind.md`
  - `docs/adr/0013-detect-github-quota-exhaustion-in-the-host.md`
  - `docs/adr/0014-give-each-run-a-private-git-directory.md`
  - `docs/adr/0015-file-a-runs-findings-from-its-run-result.md`
  - `docs/adr/0016-wait-on-pending-required-checks-in-the-handoff-gate.md`
  - `docs/adr/README.md`
  - `docs/development/README.md`
  - `docs/development/release.md`
  - `docs/usage/README.md`
  - `docs/usage/body-contracts.md`
  - `docs/usage/factory-configuration.md`
  - `docs/usage/host.md`
  - `docs/usage/sandbox-image.md`
  - `docs/usage/terminal-results.md`
- [`factory-sandbox-image`](factory-sandbox-image.md) covers:
  - `.scriptorium/Dockerfile`
  - `.factory/Dockerfile`
  - `.factory/config.json`
- [`factory-workflow`](factory-workflow.md) covers the whole repository.
- [`git-attributes`](git-attributes.md) covers:
  - `.gitattributes`
- [`github-repository-configuration`](github-repository-configuration.md) covers the whole repository.
- [`project-agent-guidance`](project-agent-guidance.md) covers:
  - `docs/agents/project.md`
- [`project-readmes`](project-readmes.md) covers the whole repository.
- [`repository-license`](repository-license.md) covers:
  - `LICENSE`
- [`repository-readme`](repository-readme.md) covers:
  - `README.md`
- [`typescript-node-stack`](typescript-node-stack.md) covers:
  - `package.json`
