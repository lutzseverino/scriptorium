// The hosting platform's comments are the durable index for actionable holds.
// Cleared and recurring reasons reuse the same comment, including after restart.
import type { Comment, IssueTracker } from "@lutzseverino/postern";

export const holdKeys = {
  model: "model-label",
  factory: "factory-hold",
  release: "release-hold",
  configuration: "repository-configuration",
  readiness: "readiness",
  parentReadiness: "parent-readiness",
} as const;
export type HoldKey = (typeof holdKeys)[keyof typeof holdKeys];

// A hold comment's marker line, keyed by its reason, and the wording of its
// next line while the reason holds and once it is resolved.
const markerLine = /^<!-- scriptorium:hold:([a-z0-9-]+) -->$/m;
const holding = "The factory is holding this issue: ";
const resolved = "Resolved: this reason no longer holds the issue.";

export async function reconcileHolds(
  tracker: IssueTracker,
  issue: number,
  holds: { key: HoldKey; reason: string }[],
): Promise<void> {
  const comments = await tracker.comments(issue);
  const pending = new Map<string, string>(
    holds.map((hold) => [hold.key, hold.reason]),
  );
  for (const comment of comments) {
    const match = markerLine.exec(comment.body);
    if (!match) continue;
    const key = match[1];
    const reason = pending.get(key);
    await upsert(tracker, issue, comment, holdComment(key, reason));
    pending.delete(key);
  }
  for (const [key, reason] of pending)
    await upsert(tracker, issue, undefined, holdComment(key, reason));
}

// A marker-keyed comment's write: the comment its marker found, edited only
// when its body changed, or a new one.
export async function upsert(
  tracker: IssueTracker,
  issue: number,
  comment: Comment | undefined,
  body: string,
): Promise<Comment> {
  if (!comment) return tracker.createComment(issue, body);
  return comment.body === body
    ? comment
    : tracker.updateComment(comment.id, body);
}

function holdComment(key: string, reason?: string): string {
  return `<!-- scriptorium:hold:${key} -->\n${reason === undefined ? resolved : `${holding}${reason}.`}`;
}

// Whether a comment body is exactly one of the factory's hold comments, as
// `holdComment` writes it with a one-line reason. Other text never counts.
export function isHoldComment(body: string): boolean {
  const [marker, text, ...rest] = body.split("\n");
  return (
    rest.length === 0 &&
    markerLine.test(marker) &&
    (text === resolved ||
      (text?.startsWith(holding) === true && text.endsWith(".")))
  );
}
