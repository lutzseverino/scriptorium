import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connect,
  PlatformError,
  type Connection,
  type IssueTracker,
  type Comment,
} from "@lutzseverino/postern";
import { relationshipSections, repositoryPlatform } from "../src/platform.ts";
import { readinessExclusion } from "../src/readiness.ts";
import { briefComment, approvalComment } from "./contract-fixture.ts";

// One repository's platform reads and writes, through Postern's GitHub
// adapter over a fake `fetch` that answers as GitHub's API, and through a
// fake connection that fails a write part way.
const labels = {
  ready: "ready-for-agent",
  running: "factory:running",
  failed: "factory:failed",
  needsInput: "factory:needs-input",
  paused: "factory:paused",
};

type Answer = { status: number; data?: unknown };

// GitHub's API for acme/widgets, answering each request as `answer` does
// and recording each as `<method> <path>`, or a GraphQL query's name. Every
// request must carry the token.
function github(
  answer: (request: string, body: any) => Answer | undefined,
  token = "ghs_widgets",
) {
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const request =
      url.pathname === "/graphql"
        ? /^query (\w+)/.exec(body.query)![1]
        : `${init?.method ?? "GET"} ${url.pathname}`;
    requests.push(request);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${token}`,
    );
    const answered = answer(request, body);
    assert.ok(answered, `GitHub has an answer for ${request}`);
    return new Response(
      answered.data === undefined ? null : JSON.stringify(answered.data),
      { status: answered.status },
    );
  };
  const connection = connect("https://github.com/acme/widgets.git", {
    credential: () => token,
    relationshipSections,
    fetch,
  });
  return { requests, connection };
}

const page = (nodes: unknown[]) => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});

const reference = (nameWithOwner: string, number: number, state = "OPEN") => ({
  number,
  state,
  repository: { nameWithOwner },
});

// An open issue node as GitHub's GraphQL API answers it. Its body names a
// parent and a blocker that no native link has.
function issueNode(number: number, details: Record<string, unknown> = {}) {
  return {
    number,
    fullDatabaseId: String(1000 + number),
    id: `I_${number}`,
    url: `https://github.com/acme/widgets/issues/${number}`,
    state: "OPEN",
    title: `Issue ${number}`,
    body: "### Parent\n\n#90\n\n### Blocked by\n\n#91\n",
    createdAt: "2026-10-01T00:00:00Z",
    lastEditedAt: null,
    author: { __typename: "User", login: "owner" },
    labels: page([{ name: "ready-for-agent" }]),
    parent: null,
    subIssues: page([]),
    blockedBy: page([]),
    timelineItems: { nodes: [] },
    ...details,
  };
}

function labeled(id: number, actor: unknown, at: string, label = labels.ready) {
  return {
    id,
    event: "labeled",
    label: { name: label },
    actor,
    created_at: at,
  };
}

const user = (login: string) => ({ login, type: "User" });

function restComment(comment: Comment) {
  return {
    id: comment.id,
    node_id: comment.nodeId,
    html_url: comment.url,
    user: comment.author && {
      login: comment.author.login,
      type: comment.author.bot ? "Bot" : "User",
    },
    body: comment.body,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

async function briefIssues(
  comments: Comment[] | number,
  details: Record<string, unknown> = {},
  eventId = 42,
  role = "admin",
  deletion: string | null | number = null,
  categorized = true,
  histories: Record<string, string[] | number | null> = {},
) {
  const { connection } = github((request, body) => {
    if (request === "FactoryCommentEdits") {
      const comment =
        typeof comments === "number"
          ? undefined
          : comments.find((comment) => comment.nodeId === body.variables.id);
      assert.ok(comment);
      const history = histories[comment.nodeId!] ?? [comment.body];
      const offset = Number(body.variables.after ?? 0);
      return typeof history === "number"
        ? { status: history, data: { message: "History unavailable" } }
        : {
            status: 200,
            data: {
              data: {
                node: {
                  body: comment.body,
                  updatedAt: comment.updatedAt,
                  lastEditedAt:
                    comment.nodeId! in histories ||
                    comment.updatedAt !== comment.createdAt
                      ? comment.updatedAt
                      : null,
                  includesCreatedEdit: histories[comment.nodeId!] !== null,
                  userContentEdits: {
                    // One revision per API page, so a superseding Brief in
                    // an older edit cannot be missed after the first page.
                    nodes: history
                      .slice(offset, offset + 1)
                      .map((diff) => ({ diff, deletedAt: null })),
                    pageInfo: {
                      hasNextPage: offset + 1 < history.length,
                      endCursor: String(offset + 1),
                    },
                  },
                },
              },
            },
          };
    }
    if (request === "FactoryCommentDeletions")
      return typeof deletion === "number"
        ? {
            status: deletion,
            data: { message: "Deletion history unavailable" },
          }
        : {
            status: 200,
            data: {
              data: {
                repository: {
                  issue: {
                    timelineItems: {
                      nodes: deletion === null ? [] : [{ createdAt: deletion }],
                    },
                  },
                },
              },
            },
          };
    if (request === "PosternIssues")
      return {
        status: 200,
        data: {
          data: {
            repository: {
              issues: page([
                issueNode(1, {
                  labels: page([{ name: labels.ready }, { name: "bug" }]),
                  ...details,
                }),
              ]),
            },
          },
        },
      };
    if (request.endsWith("/events"))
      return {
        status: 200,
        data: [
          ...(categorized
            ? [labeled(40, user("owner"), "2026-10-01T00:00:00Z", "bug")]
            : []),
          labeled(eventId, user("owner"), "2026-10-05T00:00:00Z"),
          ...(categorized
            ? [
                {
                  ...labeled(44, user("owner"), "2026-10-06T00:00:00Z", "bug"),
                  event: "unlabeled",
                },
              ]
            : []),
        ],
      };
    if (request.endsWith("/permission"))
      return {
        status: 200,
        data: { permission: role, role_name: role },
      };
    if (request.endsWith("/comments"))
      return typeof comments === "number"
        ? { status: comments, data: { message: "Comments unavailable" } }
        : { status: 200, data: comments.map(restComment) };
  });
  return repositoryPlatform(connection, labels).readIssues();
}

const policy = {
  ready: labels.ready,
  authorizedRoles: ["admin"],
  neverAuthorize: [],
};

test("an edited Agent Brief holds pickup despite its old approval and ready label", async () => {
  const issues = await briefIssues([
    {
      ...briefComment,
      body: briefComment.body.replace("Keep pickup", "Change pickup"),
      updatedAt: "2026-10-06T00:00:00Z",
    },
    approvalComment,
  ]);
  assert.match(
    readinessExclusion(issues[0], issues, policy)?.reason ?? "eligible",
    /current Agent Brief/,
  );
});

test("approval binds the current Brief text, identity, edit time, reviewer and readiness event", async (t) => {
  const changedApproval = (from: string, to: string) => ({
    ...approvalComment,
    body: approvalComment.body.replace(from, to),
  });
  for (const [name, comments, eventId] of [
    [
      "text edited before the label",
      [
        { ...briefComment, body: briefComment.body + "Changed.\n" },
        approvalComment,
      ],
    ],
    [
      "edit time changed with the same text",
      [{ ...briefComment, updatedAt: "2026-10-04T00:00:00Z" }, approvalComment],
    ],
    [
      "newest Brief replaces an approved one",
      [
        { ...briefComment, id: 12, nodeId: "IC_12" },
        approvalComment,
        briefComment,
      ],
    ],
    ["deletion cannot select the intake", [approvalComment]],
    [
      "deletion cannot select an older Brief",
      [{ ...briefComment, id: 9, nodeId: "IC_9" }, approvalComment],
    ],
    ["approval absent", [briefComment]],
    [
      "approval unreadable",
      [
        briefComment,
        {
          ...approvalComment,
          body: approvalComment.body.replace('"approved"', "broken JSON"),
        },
      ],
    ],
    [
      "revision awaiting review",
      [briefComment, changedApproval('"approved"', '"awaiting-review"')],
    ],
    [
      "different label",
      [
        briefComment,
        changedApproval(
          '"label":"ready-for-agent"',
          '"label":"ready-for-human"',
        ),
      ],
    ],
    [
      "different reviewer",
      [
        briefComment,
        changedApproval('"reviewer":"owner"', '"reviewer":"casey"'),
      ],
    ],
    ["different readiness event", [briefComment, approvalComment], 43],
    [
      "approval-like human discussion",
      [
        briefComment,
        { ...approvalComment, author: { login: "owner", bot: false } },
      ],
    ],
    [
      "approval-like bot discussion",
      [
        briefComment,
        { ...approvalComment, author: { login: "other[bot]", bot: true } },
      ],
    ],
    [
      "unmarked validator account",
      [
        briefComment,
        {
          ...approvalComment,
          author: { login: "github-actions[bot]", bot: null },
        },
      ],
    ],
    [
      "newer validator feedback replaces approval",
      [
        briefComment,
        { ...changedApproval('"approved"', '"awaiting-review"'), id: 12 },
        approvalComment,
      ],
    ],
  ] as const)
    await t.test(name, async () => {
      const issues = await briefIssues([...comments], {}, eventId);
      assert.match(
        readinessExclusion(issues[0], issues, policy)?.reason ?? "eligible",
        /current Agent Brief/,
      );
    });
});

test("the reviewed Brief is eligible; discussion, title edits and untrusted markers change no contract", async () => {
  const discussion = {
    ...briefComment,
    id: 12,
    nodeId: "IC_12",
    updatedAt: "2026-10-06T00:00:00Z",
  };
  const comments = [
    briefComment,
    approvalComment,
    ...[
      "Ordinary discussion",
      "```md\n## Agent Brief\n```",
      "> ## Agent Brief",
      "<!--\n## Agent Brief\n-->",
      "<h2>Agent Brief</h2>",
    ].map((body, index) => ({
      ...discussion,
      id: 12 + index,
      nodeId: `IC_${12 + index}`,
      body,
    })),
    {
      ...approvalComment,
      id: 20,
      nodeId: "IC_20",
      author: { login: "other[bot]", bot: true },
      body: "<!-- repo-canon:issue-contract-feedback -->\ninvalid",
    },
  ];
  const issues = await briefIssues(comments, { title: "New title" });
  assert.equal(readinessExclusion(issues[0], issues, policy), null);
});

test("comment read failures wait with an actionable reason", async () => {
  for (const status of [403, 502]) {
    const issues = await briefIssues(status);
    const hold = readinessExclusion(issues[0], issues, policy);
    assert.equal(hold?.waiting, true);
    assert.match(hold!.reason, /could not be read.*restore comment access/);
  }
});

test("replacement Brief selection follows the validator's Markdown heading forms", async () => {
  for (const heading of [
    "# Agent Brief",
    "### **AGENT** `BRIEF`",
    "Agent Brief\n---",
    "## Agent <span>Brief</span>",
  ]) {
    const replacement = {
      ...briefComment,
      id: 12,
      nodeId: "IC_12",
      body: heading + "\n\nReplacement work.",
    };
    const issues = await briefIssues([
      replacement,
      briefComment,
      approvalComment,
    ]);
    assert.match(
      readinessExclusion(issues[0], issues, policy)!.reason,
      /not bound to the current Agent Brief/,
      heading,
    );
  }
});

test("fresh review of the actual edited Brief restores eligibility without bypassing the current role", async () => {
  const comments = [
    { ...briefComment, updatedAt: "2026-10-04T00:00:00Z" },
    {
      ...approvalComment,
      body: approvalComment.body.replaceAll(
        "e4a84a2dd9caf78e1d4dbf78e73f2a81004dc935cca474dbbc65aee038195c37",
        "04b85db999bfe31b6deb0e33630ac3558e3168c30d4ed53a8ab0a6dfc04e7758",
      ),
    },
  ];
  const issues = await briefIssues(comments);
  assert.equal(readinessExclusion(issues[0], issues, policy), null);
  const demoted = await briefIssues(comments, {}, 42, "read");
  assert.match(
    readinessExclusion(demoted[0], demoted, policy)!.reason,
    /role read is not authorized/,
  );
  const replacement = await briefIssues([
    {
      ...briefComment,
      id: 12,
      nodeId: "IC_12",
      updatedAt: "2026-10-04T00:00:00Z",
    },
    {
      ...approvalComment,
      body: approvalComment.body.replaceAll(
        "e4a84a2dd9caf78e1d4dbf78e73f2a81004dc935cca474dbbc65aee038195c37",
        "7a09a6067627e4fff97cdb28b650e95db8b8cdd3122bfefc58fec0ad5fafca65",
      ),
    },
    briefComment,
  ]);
  assert.equal(readinessExclusion(replacement[0], replacement, policy), null);
});

test("Wayfinder contracts retain their readiness behavior without Brief evidence", async () => {
  for (const label of [
    "wayfinder:map",
    "wayfinder:research",
    "wayfinder:prototype",
    "wayfinder:grilling",
    "wayfinder:task",
  ]) {
    const issues = await briefIssues(502, {
      labels: page([{ name: labels.ready }, { name: "bug" }, { name: label }]),
    });
    assert.equal(readinessExclusion(issues[0], issues, policy), null);
  }
});

test("deleting an unrecorded replacement cannot revive an older approved Brief", async () => {
  // Brief 12 was posted and deleted before validator cleanup. Only Brief 10
  // and its still-matching old approval survive in the comments endpoint.
  const issues = await briefIssues(
    [briefComment, approvalComment],
    {},
    42,
    "admin",
    "2026-10-06T00:00:00Z",
  );
  assert.match(
    readinessExclusion(issues[0], issues, policy)?.reason ?? "eligible",
    /deleted comment/,
  );
});

test("removing the category label cannot bypass current Brief protection", async () => {
  const issues = await briefIssues(
    [
      { ...briefComment, body: briefComment.body + "Changed scope.\n" },
      approvalComment,
    ],
    { labels: page([{ name: labels.ready }]) },
  );
  assert.match(
    readinessExclusion(issues[0], issues, policy)?.reason ?? "eligible",
    /current Agent Brief/,
  );
});

test("deletion evidence must be readable and strictly older than the reviewed readiness", async () => {
  for (const deletion of [
    "2026-10-05T00:00:00Z",
    "2026-10-06T00:00:00Z",
    502,
    "malformed",
  ]) {
    const issues = await briefIssues(
      [briefComment, approvalComment],
      {},
      42,
      "admin",
      deletion,
    );
    const hold = readinessExclusion(issues[0], issues, policy);
    assert.ok(hold);
    assert.equal(hold.waiting, deletion === 502 || deletion === "malformed");
  }
  const reviewedAfterDeletion = await briefIssues(
    [briefComment, approvalComment],
    {},
    42,
    "admin",
    "2026-10-04T00:00:00Z",
  );
  assert.equal(
    readinessExclusion(reviewedAfterDeletion[0], reviewedAfterDeletion, policy),
    null,
  );
});

test("a deleted Brief stays held after category removal while direct contracts need no comment access", async () => {
  const directLabels = { labels: page([{ name: labels.ready }]) };
  const deleted = await briefIssues([approvalComment], directLabels);
  assert.match(
    readinessExclusion(deleted[0], deleted, policy)!.reason,
    /current Agent Brief is missing/,
  );
  const direct = await briefIssues(403, directLabels, 42, "admin", 403, false);
  assert.equal(readinessExclusion(direct[0], direct, policy), null);
});

test("editing away a replacement heading cannot restore old approval, while ordinary edits remain discussion", async () => {
  const replacement = {
    ...briefComment,
    id: 12,
    nodeId: "IC_12",
    body: "## Notes\n\nChanged discussion.",
    updatedAt: "2026-10-06T00:00:00Z",
  };
  for (const original of [
    "## Agent Brief\n\nReplacement work.",
    "Ordinary discussion.",
  ]) {
    const issues = await briefIssues(
      [briefComment, approvalComment, replacement],
      {},
      42,
      "admin",
      null,
      true,
      {
        IC_12: [replacement.body, original],
      },
    );
    const hold = readinessExclusion(issues[0], issues, policy);
    if (original.includes("Agent Brief"))
      assert.match(hold!.reason, /heading was edited away/);
    else assert.equal(hold, null);
  }
  for (const history of [
    502,
    null,
    ["Incomplete history without the current revision"],
  ]) {
    const issues = await briefIssues(
      [briefComment, approvalComment, replacement],
      {},
      42,
      "admin",
      null,
      true,
      { IC_12: history },
    );
    assert.equal(readinessExclusion(issues[0], issues, policy)?.waiting, true);
  }
});

test("a replacement edited in its creation second still needs native edit evidence", async () => {
  const comment = {
    ...briefComment,
    id: 12,
    nodeId: "IC_12",
    body: "Ordinary-looking discussion.",
    createdAt: "2026-10-06T00:00:00Z",
    updatedAt: "2026-10-06T00:00:00Z",
  };
  const comments = [briefComment, approvalComment, comment];
  const edited = await briefIssues(comments, {}, 42, "admin", null, true, {
    IC_12: [comment.body, "## Agent Brief\n\nReplacement work."],
  });
  assert.match(
    readinessExclusion(edited[0], edited, policy)!.reason,
    /heading was edited away/,
  );
  const unedited = await briefIssues(comments);
  assert.equal(readinessExclusion(unedited[0], unedited, policy), null);
});

// A comment GitHub's REST API created on the issue.
const created = (issue: number) => ({
  status: 201,
  data: {
    id: 1,
    node_id: "IC_1",
    html_url: `https://github.com/acme/widgets/issues/${issue}#issuecomment-1`,
    user: user("factory"),
    body: "comment",
    created_at: "2026-10-09T12:00:00Z",
    updated_at: "2026-10-09T12:00:00Z",
  },
});

test("open issues reach the core with their readiness, links and times, and without their bodies", async () => {
  const { connection, requests } = github((request) => {
    if (request === "PosternIssues")
      return {
        status: 200,
        data: {
          data: {
            repository: {
              issues: page([
                issueNode(1, {
                  lastEditedAt: "2026-10-02T00:00:00Z",
                  subIssues: page([
                    reference("acme/widgets", 2),
                    reference("acme/gadgets", 6, "CLOSED"),
                  ]),
                  timelineItems: {
                    nodes: [{ createdAt: "2026-10-03T00:00:00Z" }],
                  },
                }),
                issueNode(2, {
                  parent: reference("Acme/Widgets", 1),
                  blockedBy: page([
                    reference("acme/widgets", 3, "CLOSED"),
                    reference("acme/gadgets", 7),
                  ]),
                }),
                issueNode(3, { labels: page([]) }),
                issueNode(4),
                issueNode(5),
                issueNode(8),
                issueNode(9),
              ]),
            },
          },
        },
      };
    const events = {
      1: [
        labeled(1, user("owner"), "2026-10-01T00:00:00Z"),
        {
          id: 2,
          event: "unlabeled",
          label: { name: labels.ready },
          actor: user("owner"),
          created_at: "2026-10-04T00:00:00Z",
        },
        labeled(3, user("owner"), "2026-10-05T00:00:00Z"),
        labeled(4, user("casey"), "2026-10-06T00:00:00Z", "question"),
      ],
      2: [labeled(5, user("casey"), "2026-10-05T00:00:00Z")],
      4: [
        labeled(
          6,
          { login: "release-bot[bot]", type: "Bot" },
          "2026-10-05T00:00:00Z",
        ),
      ],
      5: [labeled(7, null, "2026-10-05T00:00:00Z")],
      8: [labeled(8, user("morgan"), "2026-10-05T00:00:00Z")],
      9: [
        {
          id: 9,
          event: "commented",
          actor: user("owner"),
          created_at: "2026-10-05T00:00:00Z",
        },
      ],
    } as Record<string, unknown[]>;
    const issue = /^GET \/repos\/acme\/widgets\/issues\/(\d+)\/events$/.exec(
      request,
    );
    if (issue) return { status: 200, data: events[issue[1]] };
    const role = /\/collaborators\/(\w+)\/permission$/.exec(request);
    if (role?.[1] === "owner")
      return { status: 200, data: { permission: "admin", role_name: "admin" } };
    if (role?.[1] === "casey")
      return { status: 200, data: { permission: "none", role_name: "" } };
    if (role?.[1] === "morgan")
      return { status: 502, data: { message: "Server Error" } };
  });
  const issues = await repositoryPlatform(connection, labels).readIssues();
  assert.deepEqual(issues, [
    {
      number: 1,
      createdAt: "2026-10-01T00:00:00Z",
      labels: [labels.ready],
      ready: {
        at: "2026-10-05T00:00:00Z",
        actor: { kind: "user", login: "owner", role: "admin" },
      },
      editedAt: "2026-10-02T00:00:00Z",
      contractHold: null,
      nativeParent: null,
      latestLink: { ticket: null, at: "2026-10-03T00:00:00Z" },
      subIssues: [
        { number: 2, state: "open" },
        { number: "acme/gadgets#6", state: "closed" },
      ],
      blockedBy: [],
    },
    {
      number: 2,
      createdAt: "2026-10-01T00:00:00Z",
      labels: [labels.ready],
      ready: {
        at: "2026-10-05T00:00:00Z",
        actor: { kind: "user", login: "casey", role: null },
      },
      editedAt: null,
      contractHold: null,
      nativeParent: 1,
      latestLink: null,
      subIssues: [],
      blockedBy: [
        { number: 3, state: "closed" },
        { number: "acme/gadgets#7", state: "open" },
      ],
    },
    ...[
      [3, [], null],
      [4, [labels.ready], { kind: "bot", login: "release-bot[bot]" }],
      [5, [labels.ready], { kind: "unknown" }],
      [8, [labels.ready], { kind: "unreadable", login: "morgan" }],
      [9, [labels.ready], undefined],
    ].map(([number, issueLabels, actor]) => ({
      number,
      createdAt: "2026-10-01T00:00:00Z",
      labels: issueLabels,
      ready:
        actor === null || actor === undefined
          ? null
          : { at: "2026-10-05T00:00:00Z", actor },
      editedAt: null,
      contractHold: null,
      nativeParent: null,
      latestLink: null,
      subIssues: [],
      blockedBy: [],
    })),
  ]);
  // Only ready issues' label changes are read, and each role once.
  assert.deepEqual(
    requests.filter((request) => request !== "PosternIssues"),
    [
      "GET /repos/acme/widgets/issues/1/events",
      "GET /repos/acme/widgets/collaborators/owner/permission",
      "GET /repos/acme/widgets/issues/2/events",
      "GET /repos/acme/widgets/collaborators/casey/permission",
      "GET /repos/acme/widgets/issues/4/events",
      "GET /repos/acme/widgets/issues/5/events",
      "GET /repos/acme/widgets/issues/8/events",
      "GET /repos/acme/widgets/collaborators/morgan/permission",
      "GET /repos/acme/widgets/issues/9/events",
    ],
  );
});

test("existing state labels are left as they are, and another refusal fails the pass", async () => {
  const existing = github(() => ({
    status: 422,
    data: {
      message: "Validation Failed",
      errors: [{ code: "already_exists" }],
    },
  }));
  await repositoryPlatform(existing.connection, labels).createStateLabels();
  assert.deepEqual(existing.requests, [
    "POST /repos/acme/widgets/labels",
    "POST /repos/acme/widgets/labels",
    "POST /repos/acme/widgets/labels",
    "POST /repos/acme/widgets/labels",
  ]);
  const forbidden = github(() => ({
    status: 403,
    data: { message: "Resource not accessible by integration" },
  }));
  await assert.rejects(
    repositoryPlatform(forbidden.connection, labels).createStateLabels(),
    { name: "PlatformError", reason: "forbidden" },
  );
});

test("removing a label the issue lacks succeeds, and a new state label is added before old ones are removed", async () => {
  const { connection, requests } = github((request) =>
    request.endsWith("/comments")
      ? created(4)
      : request.endsWith("factory%3Apaused")
        ? { status: 404, data: { message: "Label does not exist" } }
        : { status: 200, data: [] },
  );
  await repositoryPlatform(connection, labels).fail(4, "failed");
  assert.deepEqual(requests, [
    "POST /repos/acme/widgets/issues/4/labels",
    "DELETE /repos/acme/widgets/issues/4/labels/factory%3Arunning",
    "DELETE /repos/acme/widgets/issues/4/labels/factory%3Apaused",
    "POST /repos/acme/widgets/issues/4/comments",
  ]);
});

test("a closing issue gets its comment, then closes", async () => {
  const { connection, requests } = github((request) =>
    request.endsWith("/comments") ? created(1) : { status: 200, data: {} },
  );
  await repositoryPlatform(connection, labels).close(1, [2, "acme/gadgets#6"]);
  assert.deepEqual(requests, [
    "POST /repos/acme/widgets/issues/1/comments",
    "GET /repos/acme/widgets/issues/1",
    "PATCH /repos/acme/widgets/issues/1",
  ]);
});

test("a run's pull request is its repository's own, opened since its first attempt, from a closing reference or its branch", async () => {
  const pull = (number: number, state: string, details = {}) => ({
    number,
    fullDatabaseId: String(2000 + number),
    id: `PR_${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    state,
    title: "Change",
    body: "",
    createdAt: "2026-10-09T12:00:00Z",
    author: { __typename: "User", login: "factory" },
    headRefName: "factory/issue-4",
    headRefOid: "a".repeat(40),
    baseRefName: "main",
    isCrossRepository: false,
    repository: { nameWithOwner: "acme/widgets" },
    ...details,
  });
  const answers = (closing: unknown[], branch: unknown[], viewerStatus = 200) =>
    github((request, body) => {
      if (request === "GET /user")
        return {
          status: viewerStatus,
          data:
            viewerStatus === 200
              ? { login: "factory", type: "User" }
              : { message: "Resource not accessible by integration" },
        };
      if (request === "PosternClosingPullRequests") {
        assert.equal(body.variables.number, 4);
        return {
          status: 200,
          data: {
            data: {
              repository: {
                issue: { closedByPullRequestsReferences: page(closing) },
              },
            },
          },
        };
      }
      if (request === "PosternPullRequestsByHead") {
        assert.equal(body.variables.branch, "factory/issue-4");
        return {
          status: 200,
          data: { data: { repository: { pullRequests: page(branch) } } },
        };
      }
    });
  const state = (closing: unknown[], branch: unknown[], since?: string) =>
    repositoryPlatform(
      answers(closing, branch).connection,
      labels,
    ).pullRequestState(4, since);
  const observed = async (
    closing: unknown[],
    branch: unknown[],
    viewerStatus = 200,
  ) =>
    repositoryPlatform(
      answers(closing, branch, viewerStatus).connection,
      labels,
    ).pullRequestObservation(4);
  const candidate = {
    number: 2,
    headCommit: "a".repeat(40),
    baseBranch: "main",
    createdAt: "2026-10-09T12:00:00Z",
  };
  assert.deepEqual(
    await observed(
      [
        pull(1, "OPEN", {
          headRefName: "human",
          author: { __typename: "User", login: "person" },
        }),
      ],
      [pull(2, "OPEN")],
    ),
    { state: "open", mergeCandidate: candidate },
    "count owned PRs, not all closing candidates",
  );
  assert.deepEqual(
    await observed([pull(2, "OPEN")], [pull(2, "OPEN")]),
    { state: "open", mergeCandidate: candidate },
    "deduplicate candidates",
  );
  assert.deepEqual(
    await observed([pull(2, "OPEN", { headRefName: "other" })], []),
    { state: "open", mergeCandidate: candidate },
    "verified factory author qualifies",
  );
  for (const author of ["person", "arbitrary[bot]"])
    assert.deepEqual(
      await observed(
        [
          pull(2, "OPEN", {
            headRefName: "other",
            author: { __typename: "Bot", login: author },
          }),
        ],
        [],
      ),
      { state: "open" },
    );
  assert.deepEqual(
    await observed([], [pull(2, "OPEN"), pull(3, "OPEN")]),
    { state: "open" },
    "two owned open PRs are ambiguous",
  );
  assert.deepEqual(
    await observed(
      [
        pull(1, "OPEN", {
          headRefName: "human",
          author: { __typename: "User", login: "person" },
        }),
      ],
      [pull(2, "OPEN")],
      403,
    ),
    { state: "open", mergeCandidate: candidate },
    "installation-token viewer failure preserves branch ownership",
  );
  assert.deepEqual(
    await observed([pull(2, "OPEN", { headRefName: "other" })], [], 403),
    { state: "open" },
    "unreadable identity grants no author ownership",
  );
  assert.equal(await state([], []), "none");
  assert.equal(await state([pull(1, "CLOSED")], [pull(2, "MERGED")]), "merged");
  assert.equal(await state([pull(1, "CLOSED")], [pull(2, "OPEN")]), "open");
  assert.equal(await state([pull(1, "CLOSED")], []), "closed");
  assert.equal(
    await state([pull(1, "OPEN", { isCrossRepository: true })], []),
    "none",
  );
  assert.equal(
    await state([pull(1, "OPEN")], [], "2026-10-09T12:00:01Z"),
    "none",
  );
});

test("closed claims include needs-input-only issues across every page with configured labels", async () => {
  const configured = {
    ...labels,
    running: "worker:active",
    paused: "worker:paused",
    needsInput: "worker:question",
  };
  const { connection } = github((request, body) => {
    assert.equal(request, "PosternIssues");
    assert.deepEqual(body.variables.states, ["CLOSED"]);
    const numbers = {
      [configured.running]: [3, 4],
      [configured.paused]: [4, 5],
      [configured.needsInput]: [6, 7],
    }[body.variables.labels[0] as string]!;
    const nodes = numbers.map((number) =>
      issueNode(number, { state: "CLOSED" }),
    );
    // Each label's first page holds one issue, and its second the next.
    return {
      status: 200,
      data: {
        data: {
          repository: {
            issues:
              body.variables.after === null
                ? {
                    nodes: [nodes[0]],
                    pageInfo: { hasNextPage: true, endCursor: "next" },
                  }
                : page([nodes[1]]),
          },
        },
      },
    };
  });
  assert.deepEqual(
    await repositoryPlatform(connection, configured).readClosedClaims(),
    [3, 4, 5, 6, 7],
  );
});

// A connection to one issue whose label writes succeed until the write
// numbered `failAt`, counting from 0, which fails.
function failing(issueLabels: string[], failAt: number) {
  const writes: string[] = [];
  const fail = () => {
    if (writes.length === failAt + 1)
      throw new PlatformError("unavailable", "GitHub answered with 502");
  };
  const issueTracker: Partial<IssueTracker> = {
    async addLabels(_number, names) {
      writes.push(`add ${names.join(" ")}`);
      fail();
      issueLabels.push(...names);
    },
    async removeLabel(_number, label) {
      writes.push(`remove ${label}`);
      fail();
      if (!issueLabels.includes(label))
        throw new PlatformError("notFound", "Label does not exist");
      issueLabels.splice(issueLabels.indexOf(label), 1);
    },
    async createComment() {
      writes.push("comment");
      fail();
      return {} as never;
    },
  };
  const connection = {
    repository: {
      platform: "github",
      host: "github.com",
      path: "acme/widgets",
    },
    issueTracker,
  } as unknown as Connection;
  return { platform: repositoryPlatform(connection, labels), writes };
}

test("a state transition that fails part way leaves its claimed issue a state label", async () => {
  const state = [labels.running, labels.paused, labels.failed];
  for (const [transition, before, after] of [
    ["fail", [labels.running], [labels.failed]],
    ["fail", [labels.paused], [labels.failed]],
    ["pause", [labels.running], [labels.paused]],
    ["unpause", [labels.paused], [labels.running]],
  ] as const) {
    const complete = failing([labels.ready, ...before], Infinity);
    await complete.platform[transition](4, "comment");
    const steps = complete.writes.length;
    for (let failAt = 0; failAt < steps; failAt++) {
      const issueLabels = [labels.ready, ...before];
      const { platform, writes } = failing(issueLabels, failAt);
      await assert.rejects(platform[transition](4, "comment"), {
        reason: "unavailable",
      });
      assert.ok(
        issueLabels.some((label) => state.includes(label)),
        `${transition} from ${before} failing at ${writes.at(-1)} keeps a state label: ${issueLabels}`,
      );
    }
    const issueLabels = [labels.ready, ...before];
    await failing(issueLabels, Infinity).platform[transition](4, "comment");
    assert.deepEqual(issueLabels, [labels.ready, ...after], transition);
  }
});

test("closed-issue cleanup preserves unrelated labels and can resume after any failed removal", async () => {
  const unrelated = [
    labels.ready,
    labels.failed,
    "model:gpt-6.1-sol",
    "factory:skip",
  ];
  for (const active of [
    [labels.running],
    [labels.needsInput],
    [labels.running, labels.needsInput, labels.paused],
    [labels.paused],
    [],
  ]) {
    for (let failAt = 0; failAt < 3; failAt++) {
      const issueLabels = [...unrelated, ...active];
      await assert.rejects(
        failing(issueLabels, failAt).platform.releaseClosed(4),
        {
          reason: "unavailable",
        },
      );
      const recovered = failing(issueLabels, Infinity).platform;
      await recovered.releaseClosed(4);
      await recovered.releaseClosed(4);
      assert.deepEqual(issueLabels, unrelated);
    }
  }
});
