// The readiness module: whether an issue's ready label counts, decided from
// its ready-label changes, its body's last edit, current Agent Brief approval,
// its links and its blockers,
// as the platform reports them. It knows no issue template and reads no
// issue body.
import type { Issue, IssueId } from "./factory.ts";

// Who last applied an issue's ready label. Only a user authorizes, by their
// repository role now as the platform names it, which is null when they hold
// none. A user whose role this pass could not read waits. A bot or app never
// authorizes, nor does an account the platform no longer knows.
export type Actor =
  | { kind: "user"; login: string; role: string | null }
  | { kind: "unreadable"; login: string }
  | { kind: "bot"; login: string }
  | { kind: "unknown" };

// The latest event that applied an issue's ready label.
export type Readiness = { at: string; actor: Actor };

// The repository's ready label, and its platform's role names and accounts
// the host configuration authorizes and never authorizes.
export type Policy = {
  ready: string;
  authorizedRoles: string[];
  neverAuthorize: string[];
};

// A permanent refusal or a transient wait while a role lookup is unreadable.
export type ReadinessHold = { reason: string; waiting: boolean };

// An issue that carries readiness the factory accepts, with at least one
// native sub-issue and every sub-issue closed, is finished.
export function closes(issue: Issue, policy: Policy): boolean {
  return (
    issue.labels.includes(policy.ready) &&
    refusal(issue, policy) === null &&
    issue.subIssues.length > 0 &&
    issue.subIssues.every((ticket) => ticket.state === "closed")
  );
}

// Why a ready-labelled issue's readiness holds its pickup, given its
// repository's open issues, or null when nothing does: its own readiness, its
// being a parent, or its native parent's readiness.
export function readinessExclusion(
  issue: Issue,
  openIssues: Issue[],
  policy: Policy,
): ReadinessHold | null {
  const refused = refusal(issue, policy);
  if (refused) return { ...refused, reason: `its readiness ${refused.reason}` };
  if (issue.subIssues.length > 0)
    return {
      reason:
        "an issue with sub-issues never runs; its readiness releases its tickets",
      waiting: false,
    };
  const parent = openIssues.find(
    (other) => other.number === issue.nativeParent,
  );
  if (!parent) return null;
  const held = parentHold(parent, policy);
  return held
    ? {
        ...held,
        reason: `sub-issue of ${reference(parent.number)}, ${held.reason}`,
      }
    : null;
}

// Why a ready-labelled issue's readiness doesn't count, as a clause after
// "its readiness" or "whose readiness", or null when it counts: the label's
// latest actor must be a user the host doesn't exclude, holding an authorized
// role now, and the label must be newer than the body's last edit when the
// platform reports it. A triaged request also needs its current Agent Brief's
// revision binding. `on` names the issue to re-apply it on when that is
// another issue.
function refusal(issue: Issue, policy: Policy, on = ""): ReadinessHold | null {
  const { ready, authorizedRoles, neverAuthorize } = policy;
  const reapply = `remove and re-apply ${ready}${on}`;
  const authorized = `a person with the ${authorizedRoles.join(" or ")} role must ${reapply}`;
  if (issue.ready === null)
    return {
      reason: `is refused: no event applying ${ready} was found; ${reapply}`,
      waiting: false,
    };
  const { at, actor } = issue.ready;
  if (actor.kind === "bot")
    return {
      reason: `is refused: ${ready} was applied by ${actor.login}, a bot or app, which never authorizes; ${authorized}`,
      waiting: false,
    };
  if (actor.kind === "unknown")
    return {
      reason: `is refused: ${ready} was applied by an account that is not a user, which never authorizes; ${authorized}`,
      waiting: false,
    };
  // Platform logins ignore case.
  if (
    neverAuthorize.some(
      (account) => account.toLowerCase() === actor.login.toLowerCase(),
    )
  )
    return {
      reason: `is refused: ${ready} was applied by @${actor.login}, an account the host configuration never lets authorize; ${authorized}`,
      waiting: false,
    };
  if (actor.kind === "unreadable")
    return {
      reason: `waits: the repository role of @${actor.login}, who applied ${ready}, could not be read this pass`,
      waiting: true,
    };
  if (actor.role === null)
    return {
      reason: `is refused: ${ready} was applied by @${actor.login}, who holds no repository role; ${authorized}`,
      waiting: false,
    };
  if (!authorizedRoles.includes(actor.role))
    return {
      reason: `is refused: ${ready} was applied by @${actor.login}, whose repository role ${actor.role} is not authorized; ${authorized}`,
      waiting: false,
    };
  if (issue.editedAt !== null && Date.parse(at) <= Date.parse(issue.editedAt))
    return {
      reason: `is refused: ${ready} was applied at ${at}, not after the body's last edit at ${issue.editedAt}; review the edit, then ${reapply}`,
      waiting: false,
    };
  return issue.contractHold;
}

// A parent's readiness releases its sub-issues while it counts, is newer than
// the parent's latest sub-issue link, and no open blocker holds the parent.
function parentHold(parent: Issue, policy: Policy): ReadinessHold | null {
  const { ready } = policy;
  const name = reference(parent.number);
  if (!parent.labels.includes(ready))
    return {
      reason: `which is not ready; apply ${ready} to ${name} once its tickets are published`,
      waiting: false,
    };
  const refused = refusal(parent, policy, ` on ${name}`);
  if (refused)
    return { ...refused, reason: `whose readiness ${refused.reason}` };
  const link = parent.latestLink;
  if (link && Date.parse(parent.ready!.at) <= Date.parse(link.at))
    return {
      reason: `whose readiness predates its latest ticket${link.ticket === null ? "" : ` ${reference(link.ticket)}`}; remove and re-apply ${ready} on ${name} once its tickets are published`,
      waiting: false,
    };
  const blockers = parent.blockedBy.filter(
    (blocker) => blocker.state === "open",
  );
  if (blockers.length > 0)
    return {
      reason: `which is blocked by ${references(blockers)}; it waits until ${name}'s blockers close`,
      waiting: false,
    };
  return null;
}

export function references(issues: { number: IssueId }[]): string {
  return issues.map((issue) => reference(issue.number)).join(", ");
}

export function reference(id: IssueId): string {
  return typeof id === "number" ? `#${id}` : id;
}
