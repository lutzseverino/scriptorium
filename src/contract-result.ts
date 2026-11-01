// The repository's issue-contract validator decides whether readiness is bound
// to an issue's implementation contract, and posts that decision on the issue.
// This module reads the posted result and checks it against platform facts;
// it interprets no contract, parses no Markdown and performs no platform
// access. All facts arrive through Postern.
import type { Comment, LabelChange } from "@lutzseverino/postern";
import type { FactoryConfiguration } from "./factory-configuration.ts";
import { isHoldComment } from "./hold-comments.ts";
import type { ReadinessHold } from "./readiness.ts";

// The one result format this factory reads. Any other format, including the
// earlier line without one, holds the issue.
export const resultFormat = "repo-canon/issue-contract-state/v1";

// One issue's platform facts. A time the platform does not report is
// undefined, which differs from null: never edited, or never deleted.
export type ContractFacts = {
  comments: Comment[];
  labelChanges: LabelChange[];
  // The latest event that applied the ready label.
  ready: LabelChange;
  bodyEditTime: string | null | undefined;
  latestDeletion: string | null | undefined;
};

// A result's fields the factory reads; any may be missing or malformed.
type Result = {
  format?: unknown;
  status?: unknown;
  source?: unknown;
  label?: unknown;
  reviewEventId?: unknown;
};

// Why the validator's latest result does not let the ready label count, or
// null when it does. A result older than any change to the issue waits for the
// validator's next result, since the validator evaluates every comment, edit
// and label event. The factory's own hold comments and its writes of the
// labels its configuration names, other than the ready label, are not changes
// the validator's decision on an open issue reads.
export function contractResultHold(
  facts: ContractFacts,
  configuration: Pick<FactoryConfiguration, "labels" | "contractResult">,
): ReadinessHold | null {
  const { labels, contractResult } = configuration;
  const { ready } = facts;
  const author = `@${contractResult.author}`;
  const refuse = (detail: string, action: string): ReadinessHold => ({
    reason: `is refused: ${detail}; ${action}`,
    waiting: false,
  });
  const reapply = `remove and re-apply ${labels.ready} once the issue-contract validator has evaluated the issue`;
  const unreadable = refuse(
    `the latest contract result from ${author} is unreadable`,
    reapply,
  );

  const posted = latestResult(facts.comments, contractResult);
  if (!posted)
    return refuse(
      `no contract result from ${author} was found on the issue`,
      reapply,
    );
  let result: Result;
  try {
    result = JSON.parse(posted.line);
  } catch {
    return unreadable;
  }
  if (typeof result !== "object" || result === null || Array.isArray(result))
    return unreadable;
  if (result.format !== resultFormat)
    return refuse(
      `the latest contract result from ${author} has ${typeof result.format === "string" ? `format ${result.format}` : "no format version"}, and this factory reads only ${resultFormat}`,
      "update the factory or the repository's issue-contract validator so they share a result format",
    );

  if (facts.bodyEditTime === undefined || facts.latestDeletion === undefined)
    return refuse(
      "the platform reports no body edit or comment deletion times, so the validator's latest contract result cannot be shown current",
      "serve the repository from a platform that reports both",
    );
  const at = Date.parse(posted.comment.updatedAt);
  const newer = (time: string | null) => time !== null && Date.parse(time) > at;
  const factoryLabels = new Set(
    Object.entries(labels).flatMap(([role, label]) =>
      role === "ready" || label === undefined ? [] : [label.toLowerCase()],
    ),
  );
  const stale =
    newer(facts.bodyEditTime) ||
    newer(facts.latestDeletion) ||
    facts.comments.some(
      (comment) =>
        comment.id !== posted.comment.id &&
        !isHoldComment(comment.body) &&
        newer(comment.updatedAt),
    ) ||
    facts.labelChanges.some(
      (change) =>
        !factoryLabels.has(change.label.toLowerCase()) && newer(change.time),
    );
  const waits: ReadinessHold = {
    reason: `waits: the issue changed after the validator's latest contract result at ${posted.comment.updatedAt}; the validator's next result decides it`,
    waiting: true,
  };
  if (stale) return waits;

  if (
    result.status !== "approved" ||
    result.label !== labels.ready ||
    result.reviewEventId !== String(ready.id)
  )
    return refuse(
      `the validator's latest contract result${typeof result.status === "string" ? `, ${result.status},` : ""} does not approve the current ${labels.ready} event`,
      `review the current contract, then ${reapply}`,
    );

  // The contract source the result names must be as the validator read it.
  const source = result.source as {
    type?: unknown;
    id?: unknown;
    editedAt?: unknown;
  } | null;
  const unreadableSource = refuse(
    "the validator's latest contract result names no readable contract source",
    reapply,
  );
  const editedAt = source?.editedAt;
  if (typeof editedAt !== "string" && editedAt !== null)
    return unreadableSource;
  const same = (time: string | null) =>
    time === null || editedAt === null
      ? time === editedAt
      : Date.parse(time) === Date.parse(editedAt);
  if (source?.type === "issue-body")
    return same(facts.bodyEditTime) ? null : waits;
  if (source?.type === "comment" && typeof source.id === "string") {
    const comment = facts.comments.find(
      (comment) => String(comment.id) === source.id,
    );
    return comment && same(comment.updatedAt) ? null : waits;
  }
  return unreadableSource;
}

// The latest comment by the configured author carrying the configured marker's
// state line, with that line's JSON text. Platform logins ignore case.
function latestResult(
  comments: Comment[],
  { marker, author }: FactoryConfiguration["contractResult"],
): { comment: Comment; line: string } | null {
  const prefix = `<!-- ${marker} `;
  const suffix = " -->";
  let latest: { comment: Comment; line: string } | null = null;
  for (const comment of comments) {
    if (comment.author?.login.toLowerCase() !== author.toLowerCase()) continue;
    const line = comment.body
      .split(/\r\n?|\n/)
      .find((line) => line.startsWith(prefix) && line.endsWith(suffix));
    if (line && (latest === null || comment.id > latest.comment.id))
      latest = {
        comment,
        line: line.slice(prefix.length, -suffix.length),
      };
  }
  return latest;
}
