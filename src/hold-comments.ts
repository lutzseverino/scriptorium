// The hosting platform's comments are the durable index for actionable holds.
// Cleared and recurring reasons reuse the same comment, including after restart.
import type { IssueTracker } from "@lutzseverino/postern";

// A hold comment's marker line, keyed by its reason, and the wording of its
// next line while the reason holds and once it is resolved.
const markerLine = /^<!-- scriptorium:hold:([a-z0-9-]+) -->$/m;
const holding = "The factory is holding this issue: ";
const resolved = "Resolved: this reason no longer holds the issue.";

export async function reconcileHolds(
  tracker: IssueTracker,
  issue: number,
  holds: { key: string; reason: string }[],
): Promise<void> {
  const comments = await tracker.comments(issue);
  const pending = new Map(holds.map((hold) => [hold.key, hold.reason]));
  for (const comment of comments) {
    const match = markerLine.exec(comment.body);
    if (!match) continue;
    const key = match[1];
    const reason = pending.get(key);
    const body = holdComment(key, reason);
    if (body !== comment.body) await tracker.updateComment(comment.id, body);
    pending.delete(key);
  }
  for (const [key, reason] of pending)
    await tracker.createComment(issue, holdComment(key, reason));
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
