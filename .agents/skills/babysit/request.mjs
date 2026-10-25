#!/usr/bin/env node
// Apply repository policy before issuing the request required for an opening
// or a new head that fixes a review finding. No other push requests review.
// Usage: node request.mjs <number> [--fixes-review]
import { spawnSync } from "node:child_process";
import { readReviewer } from "./pull-request-reviewer.mjs";
import { readReviewPolicy, reviewSkipped } from "./review-policy.mjs";
import { reviewRequestedAt, reviewerPhrase } from "./reviewer.mjs";

const gh = (args, input) => {
  const result = spawnSync("gh", args, {
    input,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return result.stdout;
};

try {
  const [number, flag, ...extra] = process.argv.slice(2);
  if (
    !/^[1-9]\d*$/.test(number ?? "") ||
    (flag && flag !== "--fixes-review") ||
    extra.length
  )
    throw new Error("Usage: node request.mjs <number> [--fixes-review]");
  const reviewer = readReviewer();
  const policy = readReviewPolicy();
  const pull = JSON.parse(
    gh(["pr", "view", number, "--json", "author,createdAt"]),
  );
  if (reviewSkipped(pull.author?.login, policy)) {
    console.log(reviewerPhrase(reviewer, "skipped"));
  } else if (!reviewer) {
    console.log("No reviewer configured.");
  } else {
    const comments = JSON.parse(
      gh([
        "api",
        `repos/{owner}/{repo}/issues/${number}/comments?per_page=100`,
        "--paginate",
        "--slurp",
      ]),
    )
      .flat()
      .map((comment) => ({
        body: comment.body ?? "",
        createdAt: comment.created_at,
      }));
    const requestedAt = reviewRequestedAt(
      Date.parse(pull.createdAt),
      comments,
      reviewer,
    );
    const count =
      Number(reviewer.request.onOpen) +
      comments.filter(
        (comment) => comment.body.trim() === reviewer.request.comment,
      ).length;
    if (
      requestedAt === null ||
      (flag && !(count >= reviewer.bounds.reviewRequests))
    ) {
      gh(
        ["pr", "comment", number, "--body-file", "-"],
        reviewer.request.comment,
      );
      console.log("Review requested.");
    } else {
      console.log("No review request required or request bound reached.");
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
