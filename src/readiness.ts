// The readiness module: whether an issue's ready label counts, decided from
// its ready-label events, its body's last edit, its native links and its
// blockers. It knows no issue template.
import type { Issue, IssueId } from "./factory.ts";

// Who last applied an issue's ready label. Only a user authorizes, by their
// repository role now, which is null when this pass could not read it. A bot
// or app never authorizes, nor does an account GitHub no longer knows as a
// user.
export type Actor =
  | { kind: "user"; login: string; role: string | null }
  | { kind: "bot"; login: string }
  | { kind: "unknown" };

// The latest event that applied an issue's ready label.
export type Readiness = { at: string; actor: Actor };

// The repository's ready label and the host's authorized roles.
export type Policy = { ready: string; authorizedRoles: string[] };

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
): string | null {
  const refused = refusal(issue, policy);
  if (refused) return `its readiness ${refused}`;
  if (issue.subIssues.length > 0)
    return "an issue with sub-issues never runs; its readiness releases its tickets";
  const parent = openIssues.find(
    (other) => other.number === issue.nativeParent,
  );
  if (!parent) return null;
  const held = parentHold(parent, policy);
  return held ? `sub-issue of ${reference(parent.number)}, ${held}` : null;
}

// Why a ready-labelled issue's readiness doesn't count, as a clause after
// "its readiness" or "whose readiness", or null when it counts: the label's
// latest actor must hold an authorized role now, and the label must be newer
// than the body's last edit. `on` names the issue to re-apply it on when that
// is another issue.
function refusal(issue: Issue, policy: Policy, on = ""): string | null {
  const { ready, authorizedRoles } = policy;
  const reapply = `remove and re-apply ${ready}${on}`;
  const authorized = `a person with the ${authorizedRoles.join(" or ")} role must ${reapply}`;
  if (issue.ready === null)
    return `is refused: no event applying ${ready} was found; ${reapply}`;
  const { at, actor } = issue.ready;
  if (actor.kind === "bot")
    return `is refused: ${ready} was applied by ${actor.login}, a bot or app, which never authorizes; ${authorized}`;
  if (actor.kind === "unknown")
    return `is refused: ${ready} was applied by an account that is not a user, which never authorizes; ${authorized}`;
  if (actor.role === null)
    return `waits: the repository role of @${actor.login}, who applied ${ready}, could not be read this pass`;
  if (!authorizedRoles.includes(actor.role))
    return `is refused: ${ready} was applied by @${actor.login}, whose repository role ${actor.role} is not authorized; ${authorized}`;
  if (issue.editedAt !== null && Date.parse(at) <= Date.parse(issue.editedAt))
    return `is refused: ${ready} was applied at ${at}, not after the body's last edit at ${issue.editedAt}; review the edit, then ${reapply}`;
  return null;
}

// A parent's readiness releases its sub-issues while it counts, is newer than
// the parent's latest sub-issue link, and no open blocker holds the parent.
function parentHold(parent: Issue, policy: Policy): string | null {
  const { ready } = policy;
  const name = reference(parent.number);
  if (!parent.labels.includes(ready))
    return `which is not ready; apply ${ready} to ${name} once its tickets are published`;
  const refused = refusal(parent, policy, ` on ${name}`);
  if (refused) return `whose readiness ${refused}`;
  const link = parent.latestLink;
  if (link && Date.parse(parent.ready!.at) <= Date.parse(link.at))
    return `whose readiness predates its latest ticket${link.ticket === null ? "" : ` ${reference(link.ticket)}`}; remove and re-apply ${ready} on ${name} once its tickets are published`;
  const blockers = parent.blockedBy.filter(
    (blocker) => blocker.state === "open",
  );
  if (blockers.length > 0)
    return `which is blocked by ${references(blockers)}; it waits until ${name}'s blockers close`;
  return null;
}

export function references(issues: { number: IssueId }[]): string {
  return issues.map((issue) => reference(issue.number)).join(", ");
}

export function reference(id: IssueId): string {
  return typeof id === "number" ? `#${id}` : id;
}
