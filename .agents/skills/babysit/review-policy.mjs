// Repository-owned exception for the factory's app-authored PRs. Kept
// separate from the standards-owned reviewer schema; the host reads neither.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const readReviewPolicy = (root = process.cwd()) => {
  let source;
  try {
    source = readFileSync(
      join(root, ".github/factory-review-policy.json"),
      "utf8",
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const policy = JSON.parse(source);
  if (
    !policy ||
    policy.version !== 1 ||
    typeof policy.author !== "string" ||
    !policy.author.trim() ||
    policy.author !== policy.author.trim() ||
    Object.keys(policy).some((key) => !["version", "author"].includes(key))
  )
    throw new Error(
      "factory-review-policy must hold version 1 and a nonempty trimmed author login.",
    );
  return policy;
};

// gh's GraphQL PR author uses app/<slug>; REST uses <slug>[bot].
const login = (author) =>
  author?.replace(/^app\/(.+)$/i, "$1[bot]").toLowerCase();

export const reviewSkipped = (author, policy) =>
  Boolean(policy && login(author) === login(policy.author));
