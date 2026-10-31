// The hosting platform's comments are the durable index for actionable holds.
// Cleared and recurring reasons reuse the same comment, including after restart.
import type { IssueTracker } from "@lutzseverino/postern";

export async function reconcileHolds(
  tracker: IssueTracker,
  issue: number,
  holds: { key: string; reason: string }[],
): Promise<void> {
  const comments = await tracker.comments(issue);
  const pending = new Map(holds.map((hold) => [hold.key, hold.reason]));
  for (const comment of comments) {
    const match = /^<!-- scriptorium:hold:([a-z0-9-]+) -->$/m.exec(
      comment.body,
    );
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
  return `<!-- scriptorium:hold:${key} -->\n${reason === undefined ? "Resolved: this reason no longer holds the issue." : `The factory is holding this issue: ${reason}.`}`;
}
