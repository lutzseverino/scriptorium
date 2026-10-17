# Keep the package outside Repo Canon release inputs

Status: its location in Repo Canon's repository is superseded by
[ADR 0002](0002-release-scriptorium-from-its-own-repository.md).

The factory owns its package, tests, documentation, and SemVer in `factory/`,
and Repo Canon selects no path under it in `standards.yaml`. This implements
the release boundary in
[Repo Canon's ADR 0013](https://github.com/lutzseverino/repo-canon/blob/v0.14.0/docs/adr/0013-install-the-factory-on-the-host-from-its-own-releases.md):
a factory fix can reach the host without a standards release and an adoption
pull request for every repository. A separate repository or package registry
adds coordination and infrastructure before the factory has an external user.
