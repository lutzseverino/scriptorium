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
  const operation = body?.query?.match(/query (\w+)/)?.[1] ?? url.pathname;
  const reads = JSON.parse(readFileSync("transport.json", "utf8"));
  reads.push({
    operation,
    variables: body?.variables,
    page: url.searchParams.get("page"),
  });
  writeFileSync("transport.json", JSON.stringify(reads));
  let result;
  const headers = {};
  if (url.pathname === "/graphql") {
    let data;
    if (["BabysitReviewRevision", "PinnedFilesRevision"].includes(operation)) {
      if (state.configurationFailure === "revision")
        throw new Error("Fixture configuration read failed");
      data = {
        nameWithOwner: repository,
        defaultBranchRef: {
          name: "main",
          target: { __typename: "Commit", oid: git("rev-parse", "main") },
        },
      };
      if (state.advanceDefaultTo)
        git("update-ref", "refs/heads/main", state.advanceDefaultTo);
    } else if (
      ["BabysitReviewConfiguration", "PinnedFiles"].includes(operation)
    ) {
      if (state.configurationFailure === "files")
        throw new Error("Fixture configuration read failed");
      const { revision } = body.variables;
      // Only a full commit SHA pins the read; an unknown one is a read failure,
      // never optional absence.
      if (!/^[0-9a-f]{40}$/.test(revision))
        throw new Error("Fixture file read is not pinned");
      execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], {
        stdio: "ignore",
      });
      const blob = (expression) => {
        if (!expression.startsWith(`${revision}:`))
          throw new Error("Fixture file read is not pinned");
        const path = expression.slice(revision.length + 1);
        if (Object.hasOwn(state.fileResponses ?? {}, path))
          return state.fileResponses[path];
        try {
          return {
            __typename: "Blob",
            text: execFileSync("git", ["show", expression], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
            }),
            isTruncated: false,
          };
        } catch {
          return null;
        }
      };
      data = {
        commit: { __typename: "Commit", oid: revision },
        ...Object.fromEntries(
          [...body.query.matchAll(/(\w+): object\(expression: \$(\w+)\)/g)].map(
            ([, alias, variable]) => [alias, blob(body.variables[variable])],
          ),
        ),
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
  } else if (url.pathname === `/repos/${repository}/issues/47/timeline`) {
    const page = Number(url.searchParams.get("page") ?? 1);
    if (state.timelineFailurePage === page)
      throw new Error("Fixture timeline page failed");
    const pages = state.timelinePages ?? [[]];
    if (!Number.isSafeInteger(page) || page < 1 || page > pages.length)
      throw new Error(`Unexpected fixture timeline page: ${page}`);
    result = pages[page - 1];
    if (page < pages.length) {
      url.searchParams.set("page", String(page + 1));
      headers.Link = `<${url.href}>; rel="next"`;
    }
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
  return new Response(JSON.stringify(result), { status: 200, headers });
};
