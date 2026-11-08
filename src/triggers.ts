// Trusted pipeline triggers and the machine citation on a factory finding.
// Issue prose never authorizes a run. Only this exact citation is read from it,
// and the host verifies it against its own durable launch records.
import type { Issue as PlatformIssue } from "@lutzseverino/postern";
import type { Issue } from "./factory.ts";
import { configured, type Labels } from "./label-roles.ts";
import { actorRefusal, type Policy } from "./readiness.ts";

export type Trigger = { id: string; at: string };
export type Provenance = {
  id: string;
  issue: number;
  at: string;
  account: string | null;
  trusted: boolean;
  ownedPullRequests?: number[];
  trigger?: Trigger;
};

export function filingRun(issue: Pick<PlatformIssue, "body">): string | null {
  const lines = [
    ...issue.body.matchAll(
      /^<!-- scriptorium:filing-run (\{[^\r\n]*\}) -->$/gm,
    ),
  ];
  if (lines.length !== 1) return null;
  try {
    const value = JSON.parse(lines[0][1]);
    return typeof value?.run === "string" ? value.run : null;
  } catch {
    return null;
  }
}

export function trustedFinding(
  issue: Pick<Issue, "createdAt" | "author" | "filingRun">,
  records: Provenance[],
  policy: Policy,
): boolean {
  const author = issue.author;
  if (!author || author.kind === "unknown" || author.kind === "unreadable")
    return false;
  if (
    policy.neverAuthorize.some(
      (name) => name.toLowerCase() === author.login.toLowerCase(),
    )
  )
    return false;
  return records.some(
    (record) =>
      record.id === issue.filingRun &&
      record.trusted &&
      record.account?.toLowerCase() === author.login.toLowerCase() &&
      Date.parse(record.at) <= Date.parse(issue.createdAt),
  );
}

// Consumed triggers stay consumed across settlement and host restarts. Only
// a new label application or a new author reply can start another triage.
export function triageTrigger(
  issue: Issue,
  labels: Labels,
  policy: Policy,
): Trigger | null {
  const newer = (at: string) =>
    !issue.lastTriageAt || Date.parse(at) > Date.parse(issue.lastTriageAt);
  if (labels.reporter && issue.labels.includes(labels.reporter)) {
    return issue.reporter &&
      issue.authorReply &&
      Date.parse(issue.authorReply) > Date.parse(issue.reporter.at) &&
      newer(issue.authorReply) &&
      (issue.trustedHistory ||
        actorRefusal(issue.reporter.actor, policy, {
          subject: labels.reporter,
          action: "applied",
        }) === null)
      ? { id: `reply:${issue.authorReply}`, at: issue.authorReply }
      : null;
  }
  if (
    configured(
      labels,
      (role) => role.readiness || (role.stop && !role.applied),
    ).some((label) => issue.labels.includes(label))
  )
    return null;
  if (
    issue.triage &&
    newer(issue.triage.at) &&
    actorRefusal(issue.triage.actor, policy, {
      subject: labels.triage!,
      action: "applied",
    }) === null
  )
    return { id: `label:${issue.triage.at}`, at: issue.triage.at };
  if (
    newer(issue.createdAt) &&
    (issue.filedByTrustedRun ||
      (issue.author &&
        actorRefusal(issue.author, policy, {
          subject: "the issue",
          action: "opened",
        }) === null))
  )
    return { id: `author:${issue.createdAt}`, at: issue.createdAt };
  return null;
}

export function draftTrigger(issue: Issue, policy: Policy): Trigger | null {
  const pr = issue.pullRequest;
  return pr?.draft &&
    issue.author &&
    actorRefusal(issue.author, policy, {
      subject: "the draft PR",
      action: "opened",
    }) === null &&
    !issue.reviewedHeads?.includes(pr.target.headCommit)
    ? { id: `draft:${pr.target.headCommit}`, at: issue.createdAt }
    : null;
}
