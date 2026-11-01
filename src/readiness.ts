// The readiness module: whether an issue's ready label counts, decided from
// its ready-label changes, the issue-contract validator's decision, a parent's
// body edits and links, and its blockers, as the platform reports them. It
// knows no issue template and reads no issue body.
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
// native sub-issue, every sub-issue closed and no open blockers, is finished.
export function closes(issue: Issue, policy: Policy): boolean {
  return (
    issue.labels.includes(policy.ready) &&
    refusal(issue, policy) === null &&
    issue.blockedBy.every((blocker) => blocker.state === "closed") &&
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
): (ReadinessHold & { key?: string }) | null {
  return readinessExclusions(issue, openIssues, policy)[0] ?? null;
}

// All readiness reasons, so one actionable reason cannot hide another's
// comment. The first still determines pickup's existing exclusion precedence.
export function readinessExclusions(
  issue: Issue,
  openIssues: Issue[],
  policy: Policy,
): (ReadinessHold & { key?: string })[] {
  const holds: (ReadinessHold & { key?: string })[] = [];
  const refused = refusal(issue, policy);
  if (refused)
    holds.push({
      ...refused,
      ...(!refused.waiting && { key: "readiness" }),
      reason: `its readiness ${refused.reason}`,
    });
  if (issue.subIssues.length > 0)
    return [
      ...holds,
      {
        reason:
          "an issue with sub-issues never runs; its readiness releases its tickets",
        waiting: false,
      },
    ];
  const parent = openIssues.find(
    (other) => other.number === issue.nativeParent,
  );
  const held = parent && parentHold(parent, policy);
  if (held)
    holds.push({
      ...held,
      ...(!held.waiting && !held.blocked && { key: "parent-readiness" }),
      reason: `sub-issue of ${reference(parent.number)}, ${held.reason}`,
    });
  return holds;
}

// Why a ready-labelled issue's readiness doesn't count, as a clause after
// "its readiness" or "whose readiness", or null when it counts: the label's
// latest actor must be a user the host doesn't exclude, holding an authorized
// role now, and the validator's current result must approve the label's
// event. A parent's label must also be newer than its body's last edit when
// the platform reports it; whether an edit cancels a running issue's
// readiness is the validator's decision. `on` names the issue to re-apply it
// on when that is another issue.
function refusal(issue: Issue, policy: Policy, on = ""): ReadinessHold | null {
  const { ready } = policy;
  const reapply = `remove and re-apply ${ready}${on}`;
  if (issue.ready === null)
    return {
      reason: `is refused: no event applying ${ready} was found; ${reapply}`,
      waiting: false,
    };
  const { at, actor } = issue.ready;
  const refused = actorRefusal(
    actor,
    policy,
    { subject: ready, action: "applied" },
    on,
  );
  if (refused) return refused;
  if (
    issue.subIssues.length > 0 &&
    issue.editedAt !== null &&
    Date.parse(at) <= Date.parse(issue.editedAt)
  )
    return {
      reason: `is refused: ${ready} was applied at ${at}, not after the body's last edit at ${issue.editedAt}; review the edit, then ${reapply}`,
      waiting: false,
    };
  return issue.contractHold;
}

// Ready labels and link additions share the host's complete actor policy.
function actorRefusal(
  actor: Actor,
  policy: Policy,
  event: { subject: string; action: "applied" | "linked" },
  on = "",
): ReadinessHold | null {
  const { ready, authorizedRoles, neverAuthorize } = policy;
  const authorized = `a person with the ${authorizedRoles.join(" or ")} role must remove and re-apply ${ready}${on}`;
  if (actor.kind === "bot")
    return {
      reason: `is refused: ${event.subject} was ${event.action} by ${actor.login}, a bot or app, which never authorizes; ${authorized}`,
      waiting: false,
    };
  if (actor.kind === "unknown")
    return {
      reason: `is refused: ${event.subject} was ${event.action} by an account that is not a user, which never authorizes; ${authorized}`,
      waiting: false,
    };
  // Platform logins ignore case.
  if (
    neverAuthorize.some(
      (account) => account.toLowerCase() === actor.login.toLowerCase(),
    )
  )
    return {
      reason: `is refused: ${event.subject} was ${event.action} by @${actor.login}, an account the host configuration never lets authorize; ${authorized}`,
      waiting: false,
    };
  if (actor.kind === "unreadable")
    return {
      reason: `waits: the repository role of @${actor.login}, who ${event.action} ${event.subject}, could not be read this pass`,
      waiting: true,
    };
  if (actor.role === null)
    return {
      reason: `is refused: ${event.subject} was ${event.action} by @${actor.login}, who holds no repository role; ${authorized}`,
      waiting: false,
    };
  if (!authorizedRoles.includes(actor.role))
    return {
      reason: `is refused: ${event.subject} was ${event.action} by @${actor.login}, whose repository role ${actor.role} is not authorized; ${authorized}`,
      waiting: false,
    };
  return null;
}

// A parent's readiness releases its sub-issues while it counts, every link
// since readiness is authorized, and no open blocker holds the parent. Without
// complete link history, readiness must follow the latest link time.
function parentHold(
  parent: Issue,
  policy: Policy,
): (ReadinessHold & { blocked?: true }) | null {
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
  if (parent.linkAdditions !== null) {
    for (const addition of parent.linkAdditions) {
      if (addition.at === null)
        return {
          reason: `whose ticket link has no known time; remove and re-apply ${ready} on ${name} once its tickets are published`,
          waiting: false,
        };
      if (Date.parse(addition.at) < Date.parse(parent.ready!.at)) continue;
      const refused = actorRefusal(
        addition.actor,
        policy,
        {
          subject: `ticket${addition.ticket === null ? "" : ` ${reference(addition.ticket)}`}`,
          action: "linked",
        },
        ` on ${name}`,
      );
      if (refused)
        return { ...refused, reason: `whose readiness ${refused.reason}` };
    }
  } else if (link && Date.parse(parent.ready!.at) <= Date.parse(link.at))
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
      blocked: true,
    };
  return null;
}

export function references(issues: { number: IssueId }[]): string {
  return issues.map((issue) => reference(issue.number)).join(", ");
}

export function reference(id: IssueId): string {
  return typeof id === "number" ? `#${id}` : id;
}
