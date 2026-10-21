# Reach the hosting platform through Postern

The factory reads and writes each served repository's issues, labels,
comments, repository roles and pull requests through
[Postern](https://github.com/lutzseverino/postern), the hosting platform
package, pinned at an exact `1.x` version. It no longer runs the GitHub CLI or
calls GitHub's API itself. Git and the sandbox's token file keep their own
token paths. The owner settled this in
[the hosting platform decisions](https://github.com/lutzseverino/repo-canon/issues/504#issuecomment-6244638871),
recorded in
[Repo Canon ADR 0023](https://github.com/lutzseverino/repo-canon/blob/v0.17.0/docs/adr/0023-reach-the-hosting-platform-through-postern.md),
and [issue #23](https://github.com/lutzseverino/scriptorium/issues/23) holds
this repository's contract.

Postern reports facts: label changes with their actor and time, role names,
bot marking, relationships, and edit and link times. Readiness, the frontier,
parent gating, blockers and authorization stay in the factory's own code,
and Postern assumes none of their conventions. The factory connects to each
repository from its remote, so the platform comes from Postern's detection,
and refuses to serve a repository on a platform Postern doesn't serve while
the others carry on. It passes the `Parent` and `Blocked by` body section
names to Postern, so on a platform without native links only Postern's
adapter reads an issue's body; the factory never does. GitHub's links are
native, and GitHub is still the only adapter.

The host configuration lists, for each platform, the role names whose
holders' readiness counts, exactly as the platform names them, with no
neutral role vocabulary between the two. It also lists accounts that never
authorize, whatever their role. A bot never authorizes either; on a platform
without bot marking, the list is required, and the factory refuses to serve
the platform's repositories without it. The factory owns these settings, and
Repo Canon's factory profile supplies their defaults where it provides factory
settings; readiness policy stays in host configuration, as
[ADR 0005](0005-default-the-factorys-own-comment-wording.md) already keeps it.
The earlier `readiness.authorizedRoles`
and `github.tokenCommand` keys stay readable as GitHub's settings, so existing
host configurations keep working unchanged.

Where a platform doesn't report when an issue's body was last edited or when
its latest sub-issue was linked, the factory skips that comparison and never
invents a time. On such a platform, such as Forgejo, readiness that an edit or
a new link should have invalidated stays in place until the issue-contract
trigger removes it as the event arrives, and a missed event leaves it in
place. That weaker guarantee is accepted; a content fingerprint remains a
fallback if the risk shows up in practice.
