# Keep the package outside Repo Canon release inputs

The factory owns its package, tests, documentation, and SemVer in `factory/`,
and Repo Canon selects no path under it in `standards.yaml`. This implements
the release boundary in
[system ADR 0013](../../../docs/adr/0013-install-the-factory-on-the-host-from-its-own-releases.md):
a factory fix can reach the host without a standards release and an adoption
pull request for every repository. A separate repository or package registry
adds coordination and infrastructure before the factory has an external user.
