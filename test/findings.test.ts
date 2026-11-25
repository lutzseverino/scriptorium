import assert from "node:assert/strict";
import { test } from "node:test";
import { connect, PlatformError } from "@lutzseverino/postern";
import {
  fileFindings,
  findingTarget,
  findingsTable,
  type FindingRecord,
  type FindingTarget,
} from "../src/findings.ts";
import type { Finding } from "../src/run-result.ts";

// How the host files a run's findings, over fake targets that record each
// create and comment, and a target's writes through Postern's GitHub adapter
// over a fake `fetch` that answers as GitHub's API.
const citation = '<!-- scriptorium:filing-run {"run":"r1"} -->';
const now = () => new Date("2026-11-25T12:00:00Z");

function targets(failures: Record<string, Error> = {}) {
  const writes: string[] = [];
  const issues: { title: string; body: string; number: number }[] = [];
  const comments: { issue: number; body: string }[] = [];
  const fail = (operation: string) => {
    const failure = failures[operation];
    if (failure) {
      delete failures[operation];
      throw failure;
    }
  };
  const target = (repository: string): FindingTarget => ({
    async create(title, body) {
      issues.push({ title, body, number: 20 + issues.length });
      writes.push(`create ${repository} ${title}`);
      fail(`create ${title}`);
      return {
        number: issues.at(-1)!.number,
        url: `https://github.com/${repository}/issues/${issues.at(-1)!.number}`,
      };
    },
    async created(title, body, since) {
      writes.push(`find ${repository} ${title} since ${since}`);
      const found = issues.find(
        (issue) => issue.title === title && issue.body === body,
      );
      return found
        ? {
            number: found.number,
            url: `https://github.com/${repository}/issues/${found.number}`,
          }
        : null;
    },
    async comment(issue, body, retry) {
      fail(`comment ${issue}`);
      const posted =
        retry &&
        comments.find(
          (comment) => comment.issue === issue && comment.body === body,
        );
      if (!posted) {
        comments.push({ issue, body });
        writes.push(`comment ${repository}#${issue}`);
      }
      return `https://github.com/${repository}/issues/${issue}#comment`;
    },
  });
  return {
    writes,
    issues,
    comments,
    async resolve(repository: string) {
      writes.push(`resolve ${repository}`);
      return repository === "acme/elsewhere"
        ? { unfiled: "the host does not serve acme/elsewhere" }
        : target(repository);
    },
  };
}

const findings: Finding[] = [
  {
    repository: "acme/widgets",
    title: "Retries | ignore the limit",
    body: "Steps.",
    observed: true,
  },
  { repository: "acme/widgets", issue: 7, comment: "Seen again." },
  {
    repository: "acme/elsewhere",
    title: "A broken link",
    body: "Read in the docs.",
    observed: false,
  },
  { invalid: "it names no issue number" },
  {
    repository: "Acme/Widgets",
    title: "A second defect",
    body: "Read in code.",
    observed: false,
  },
];

test("each finding is filed with the citation, linked, or reported unfiled, and the table lists them all", async () => {
  const fake = targets();
  const records: (FindingRecord | undefined)[] = [];
  let saves = 0;
  await fileFindings(findings, records, {
    targets: fake.resolve,
    citation,
    now,
    save: () => saves++,
  });
  // One resolution per repository, ignoring case, and no write elsewhere.
  assert.deepEqual(fake.writes, [
    "resolve acme/widgets",
    "create acme/widgets Retries | ignore the limit",
    "comment acme/widgets#7",
    "resolve acme/elsewhere",
    "create acme/widgets A second defect",
  ]);
  assert.deepEqual(fake.issues[0], {
    title: "Retries | ignore the limit",
    body: `Steps.\n\n${citation}`,
    number: 20,
  });
  assert.deepEqual(fake.comments, [{ issue: 7, body: "Seen again." }]);
  assert.deepEqual(records, [
    {
      state: "filed",
      issue: "acme/widgets#20",
      url: "https://github.com/acme/widgets/issues/20",
    },
    {
      state: "linked",
      issue: "acme/widgets#7",
      url: "https://github.com/acme/widgets/issues/7#comment",
    },
    { state: "unfiled", reason: "the host does not serve acme/elsewhere" },
    { state: "invalid", reason: "it names no issue number" },
    {
      state: "filed",
      issue: "Acme/Widgets#21",
      url: "https://github.com/acme/widgets/issues/21",
    },
  ]);
  // Each write is saved as attempted, then as its outcome.
  assert.equal(saves, 8);
  assert.equal(
    findingsTable(findings, records),
    [
      "| Finding | Filing |",
      "| --- | --- |",
      "| acme/widgets#20: Retries \\| ignore the limit | ↗️ Filed, observed |",
      "| acme/widgets#7 | ↗️ Linked by [a recurrence comment](https://github.com/acme/widgets/issues/7#comment) |",
      "| A broken link | ⏭️ Not filed in acme/elsewhere: the host does not serve acme/elsewhere |",
      "| Finding 4 | ❌ Invalid: it names no issue number |",
      "| Acme/Widgets#21: A second defect | ↗️ Filed, only read |",
    ].join("\n"),
  );
  // Settled findings are never written again.
  await fileFindings(findings, records, {
    targets: fake.resolve,
    citation,
    now,
    save: () => saves++,
  });
  assert.equal(fake.writes.length, 5);
});

test("an interrupted write is found again rather than made twice, and a refusal leaves its finding unfiled", async () => {
  const fake = targets({
    "create Retries | ignore the limit": new PlatformError(
      "unavailable",
      "The response was lost",
    ),
    "comment 7": new PlatformError("notFound", "Not Found"),
  });
  const records: (FindingRecord | undefined)[] = [];
  const options = { targets: fake.resolve, citation, now, save() {} };
  await assert.rejects(
    fileFindings(findings, records, options),
    /The response was lost/,
  );
  assert.deepEqual(records, [
    { state: "attempted", at: "2026-11-25T12:00:00.000Z" },
  ]);
  await fileFindings(findings, records, options);
  // The lost create landed, so its retry looks back an hour and finds it.
  assert.deepEqual(
    fake.writes.filter((write) => write.includes("Retries")),
    [
      "create acme/widgets Retries | ignore the limit",
      "find acme/widgets Retries | ignore the limit since 2026-11-25T11:00:00.000Z",
    ],
  );
  assert.equal(fake.issues.length, 2);
  assert.deepEqual(records.slice(0, 2), [
    {
      state: "filed",
      issue: "acme/widgets#20",
      url: "https://github.com/acme/widgets/issues/20",
    },
    { state: "unfiled", reason: "acme/widgets refused the write (notFound)" },
  ]);
  // A recurrence retried after its attempt reuses the comment it finds.
  const retried: (FindingRecord | undefined)[] = [
    records[0],
    { state: "attempted", at: "2026-11-25T11:59:00.000Z" },
  ];
  fake.comments.push({ issue: 7, body: "Seen again." });
  await fileFindings(findings.slice(0, 2), retried, options);
  assert.equal(fake.comments.length, 1);
  assert.equal(retried[1]?.state, "linked");
});

test("a run without filing provenance files no new finding", async () => {
  const fake = targets();
  const records: (FindingRecord | undefined)[] = [];
  await fileFindings(findings.slice(0, 2), records, {
    targets: fake.resolve,
    citation: null,
    now,
    save() {},
  });
  assert.deepEqual(records[0], {
    state: "unfiled",
    reason: "the run has no filing provenance to cite",
  });
  assert.equal(records[1]?.state, "linked");
  assert.throws(
    () => findingsTable(findings, records),
    /finding 3 has no final record/,
  );
});

// GitHub's API for acme/widgets, answering each request as `answer` does and
// recording each as `<method> <path>`.
function github(
  answer: (
    request: string,
    body: any,
  ) => { status: number; data?: unknown } | undefined,
) {
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const request = `${init?.method ?? "GET"} ${url.pathname}`;
    requests.push(request);
    const answered = answer(
      request,
      init?.body ? JSON.parse(String(init.body)) : undefined,
    );
    assert.ok(answered, `GitHub has an answer for ${request}`);
    return new Response(
      answered.data === undefined ? null : JSON.stringify(answered.data),
      { status: answered.status },
    );
  };
  const connection = connect("https://github.com/acme/widgets.git", {
    credential: () => "ghs_widgets",
    relationshipSections: { parent: "Parent", blockedBy: "Blocked by" },
    fetch,
  });
  return { requests, connection };
}

const restComment = (id: number, body: string) => ({
  id,
  node_id: `IC_${id}`,
  html_url: `https://github.com/acme/widgets/issues/7#issuecomment-${id}`,
  user: { login: "factory[bot]", type: "Bot" },
  body,
  created_at: "2026-10-09T12:00:00Z",
  updated_at: "2026-10-09T12:00:00Z",
});

test("a finding target files in the triage state, finds an interrupted create and comments only on issues", async () => {
  const body = 'Retry twice.\n\n<!-- scriptorium:filing-run {"run":"r1"} -->';
  const { connection, requests } = github((request, sent) => {
    switch (request) {
      case "POST /repos/acme/widgets/issues":
        assert.deepEqual(sent, {
          title: "Retries ignore the limit",
          body,
          labels: ["state:triage"],
        });
        return {
          status: 201,
          data: {
            number: 12,
            html_url: "https://github.com/acme/widgets/issues/12",
          },
        };
      case "GET /repos/acme/widgets/issues":
        return {
          status: 200,
          data: [
            {
              number: 3,
              title: "Retries ignore the limit",
              body,
              pull_request: {},
            },
            {
              number: 12,
              title: "Retries ignore the limit",
              body: body.replaceAll("\n", "\r\n"),
              html_url: "https://github.com/acme/widgets/issues/12",
            },
          ],
        };
      case "GET /repos/acme/widgets/issues/7":
        return { status: 200, data: { number: 7 } };
      case "GET /repos/acme/widgets/issues/8":
        return { status: 200, data: { number: 8, pull_request: {} } };
      case "GET /repos/acme/widgets/issues/7/comments":
        return {
          status: 200,
          data: [restComment(5, "Seen again.")],
        };
      case "POST /repos/acme/widgets/issues/7/comments":
        return { status: 201, data: restComment(1, "Seen again.") };
    }
  });
  const target = findingTarget(connection, "state:triage");
  assert.deepEqual(await target.create("Retries ignore the limit", body), {
    number: 12,
    url: "https://github.com/acme/widgets/issues/12",
  });
  // A pull request never stands for a filed issue; line endings may differ.
  assert.deepEqual(
    await target.created(
      "Retries ignore the limit",
      body,
      "2026-10-09T11:00:00Z",
    ),
    { number: 12, url: "https://github.com/acme/widgets/issues/12" },
  );
  assert.equal(
    await target.created("Another title", body, "2026-10-09T11:00:00Z"),
    null,
  );
  assert.equal(
    await target.comment(7, "Seen again.", true),
    "https://github.com/acme/widgets/issues/7#issuecomment-5",
  );
  assert.equal(
    await target.comment(7, "Seen again.", false),
    "https://github.com/acme/widgets/issues/7#issuecomment-1",
  );
  await assert.rejects(
    target.comment(8, "Seen again.", false),
    (error: unknown) =>
      error instanceof PlatformError && error.reason === "notFound",
  );
  assert.deepEqual(requests, [
    "POST /repos/acme/widgets/issues",
    "GET /repos/acme/widgets/issues",
    "GET /repos/acme/widgets/issues",
    "GET /repos/acme/widgets/issues/7",
    "GET /repos/acme/widgets/issues/7/comments",
    "GET /repos/acme/widgets/issues/7",
    "POST /repos/acme/widgets/issues/7/comments",
    "GET /repos/acme/widgets/issues/8",
  ]);
});
