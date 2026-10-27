// Agent Brief selection and revision binding belong to the factory. All facts
// arrive through Postern; this module performs no platform access.
import { createHash } from "node:crypto";
import { lexer, type Token } from "marked";
import type { Comment, LabelChange } from "@lutzseverino/postern";
import type { ReadinessHold } from "./readiness.ts";

const feedbackMarker = "<!-- repo-canon:issue-contract-feedback -->";
const stateLine = /^<!-- repo-canon:issue-contract-state (.+) -->$/m;

// Removing a triage category cannot turn a stale Brief approval into a body
// contract. Label history is available without reading a direct issue's body.
export function hasBriefContract(
  labels: string[],
  changes: LabelChange[],
): boolean {
  if (
    labels.some((label) =>
      [
        "wayfinder:map",
        "wayfinder:research",
        "wayfinder:prototype",
        "wayfinder:grilling",
        "wayfinder:task",
      ].includes(label),
    )
  )
    return false;
  return [...labels, ...changes.map((change) => change.label)].some(
    (label) => label === "bug" || label === "enhancement",
  );
}

// Match the contract validator's top-level Markdown heading recognition,
// including formatted and setext headings, excluding code and blockquotes.
function inlineText(tokens: Token[]): string {
  return tokens
    .map((token) => {
      if (token.type === "html") return "";
      if ("tokens" in token && token.tokens) return inlineText(token.tokens);
      return "text" in token ? token.text : "";
    })
    .join("");
}

function isBrief(comment: Comment): boolean {
  return lexer(comment.body.replace(/\r\n?/g, "\n")).some(
    (token) =>
      token.type === "heading" &&
      inlineText(token.tokens ?? [])
        .replace(/[*_`]/g, "")
        .replace(/[ \t]+/g, " ")
        .trim()
        .toLowerCase() === "agent brief",
  );
}

// A categorized request cannot fall back to its intake body or an older
// approved Brief. The highest comment ID, not edit time or approval, selects
// the current Brief, as in the repository contract validator.
export function briefReadiness(
  comments: Comment[],
  ready: LabelChange,
  platform: string,
  latestDeletion: string | null,
): ReadinessHold | null {
  const refuse = (detail: string): ReadinessHold => ({
    reason: `is refused: ${detail}; publish and review the current Agent Brief, then remove and re-apply ${ready.label}`,
    waiting: false,
  });
  const brief = comments.filter(isBrief).sort((a, b) => b.id - a.id)[0];
  if (!brief) return refuse("the current Agent Brief is missing");
  if (
    latestDeletion !== null &&
    Date.parse(ready.time) <= Date.parse(latestDeletion)
  )
    return refuse(
      "a deleted comment may have superseded the current Agent Brief after its review; deleted text is unavailable",
    );
  // The revision and feedback formats below are Repo Canon's GitHub contract.
  // Other platforms must supply equivalent evidence before pickup can proceed.
  if (platform !== "github")
    return refuse(
      "the platform cannot establish approval of the current Agent Brief",
    );
  const feedback = comments
    .filter(
      (comment) =>
        comment.author?.login.toLowerCase() === "github-actions[bot]" &&
        comment.author.bot === true &&
        comment.body.includes(feedbackMarker),
    )
    .sort((a, b) => b.id - a.id)[0];
  let approval;
  try {
    approval = JSON.parse(stateLine.exec(feedback?.body ?? "")?.[1] ?? "null");
  } catch {
    return refuse(
      "the validator's approval of the current Agent Brief is unreadable",
    );
  }
  const revision = `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        format: "repo-canon/issue-contract-revision/v1",
        kind: "triaged Agent Brief",
        source: {
          type: "comment",
          id: brief.nodeId ?? String(brief.id),
          editedAt: brief.updatedAt,
        },
        body: brief.body,
      }),
    )
    .digest("hex")}`;
  if (
    approval?.status !== "approved" ||
    approval.revision !== revision ||
    approval.label !== ready.label ||
    approval.reviewEventId !== String(ready.id) ||
    typeof approval.reviewer !== "string" ||
    approval.reviewer.toLowerCase() !== ready.actor?.login.toLowerCase() ||
    Date.parse(ready.time) <= Date.parse(brief.updatedAt)
  )
    return refuse(
      "readiness is not bound to the current Agent Brief revision and ready-label event",
    );
  return null;
}
