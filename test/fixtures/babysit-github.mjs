// Preloaded only by the babysit integration fixtures. No request reaches GitHub.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const repository = "example/repository";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  if (url.origin !== "https://api.github.com")
    throw new Error(`Unexpected fixture origin: ${url.origin}`);
  const state = JSON.parse(readFileSync("state.json", "utf8"));
  const body = options.body ? JSON.parse(options.body) : null;
  let result;
  if (url.pathname === "/graphql") {
    let data;
    if (body.query.includes("query BabysitReviewRevision")) {
      data = {
        nameWithOwner: repository,
        defaultBranchRef: {
          name: "main",
          target: { __typename: "Commit", oid: git("rev-parse", "main") },
        },
      };
    } else if (body.query.includes("query BabysitReviewConfiguration")) {
      const blob = (expression) => {
        try {
          return {
            __typename: "Blob",
            text: git("show", expression),
            isTruncated: false,
          };
        } catch {
          return null;
        }
      };
      data = {
        commit: { __typename: "Commit", oid: body.variables.revision },
        policy: blob(body.variables.policy),
        reviewer: blob(body.variables.reviewer),
      };
    } else if (body.query.includes("query PosternPullRequest(")) {
      data = {
        pullRequest: {
          ...state,
          repository: { nameWithOwner: repository },
          number: 47,
          fullDatabaseId: "47",
          id: "PR_fixture",
          url: `https://github.com/${repository}/pull/47`,
          state: "OPEN",
          title: "Fixture pull request",
          body: "",
          author: {
            __typename:
              state.author.login.startsWith("app/") ||
              state.author.login.endsWith("[bot]")
                ? "Bot"
                : "User",
            login: state.author.login
              .replace(/^app\//, "")
              .replace(/\[bot\]$/, ""),
          },
          baseRefName: "main",
          isCrossRepository: false,
        },
      };
    } else if (body.query.includes("query BabysitChecks")) {
      data = {
        object: {
          statusCheckRollup: {
            contexts: {
              nodes: state.statusCheckRollup,
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
    } else throw new Error("Unexpected fixture GraphQL query");
    result = { data: { repository: data } };
  } else if (url.pathname === `/repos/${repository}/activity`) {
    result = [{ after: state.headRefOid, timestamp: state.pushedAt }];
  } else if (url.pathname === `/repos/${repository}/actions/runs`) {
    result = { workflow_runs: [] };
  } else if (url.pathname === `/repos/${repository}/issues/47/comments`) {
    if (options.method === "POST") {
      const requests = JSON.parse(readFileSync("requests.json", "utf8"));
      requests.push(body.body);
      writeFileSync("requests.json", JSON.stringify(requests));
      state.comments.push({
        user: { login: "factory[bot]" },
        body: body.body,
        created_at: new Date().toISOString(),
      });
      writeFileSync("state.json", JSON.stringify(state));
      result = {};
    } else result = state.comments;
  } else if (url.pathname === `/repos/${repository}/pulls/47/reviews`) {
    result = state.reviews.map((review) => ({
      ...review,
      user: {
        ...review.user,
        type: review.user.login.endsWith("[bot]") ? "Bot" : "User",
      },
    }));
  } else if (url.pathname === `/repos/${repository}/pulls/47/comments`) {
    result = [];
  } else throw new Error(`Unexpected fixture request: ${url.pathname}`);
  return new Response(JSON.stringify(result), { status: 200 });
};
