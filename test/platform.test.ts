import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connect,
  PlatformError,
  type ConnectionWithLinkAdditions,
  type IssueTracker,
  type Comment,
} from "@lutzseverino/postern";
import { relationshipSections, repositoryPlatform } from "../src/platform.ts";
import { readinessExclusion } from "../src/readiness.ts";
import {
  briefComment,
  contractResult,
  recordedLine,
  resultComment,
  resultState,
} from "./contract-result-fixture.ts";

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
const configuration = { labels, contractResult };

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

// One ready triaged request, issue 1, with `comments`, or a comment read
// failing with that status, as the validator's result is read from them. The
// owner labelled it `bug` on October 1 and applied readiness in event 42 on
// October 5; `events` follow those. `deletion` is the latest comment
// deletion, or the status that read fails with.
async function resultIssues(
  comments: Comment[] | number,
  {
    details = {},
    events = [],
    deletion = null,
    role = "admin",
  }: {
    details?: Readonly<Record<string, unknown>>;
    events?: readonly unknown[];
    deletion?: string | null | number;
    role?: string;
  } = {},
) {
  const { connection } = github((request) => {
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
          labeled(40, user("owner"), "2026-10-01T00:00:00Z", "bug"),
          labeled(42, user("owner"), "2026-10-05T00:00:00Z"),
          ...events,
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
  return repositoryPlatform(connection, configuration).readIssues();
}

const policy = {
  ready: labels.ready,
  authorizedRoles: ["admin"],
  neverAuthorize: [],
};

const held = async (...args: Parameters<typeof resultIssues>) =>
  (await resultIssues(...args))[0].contractHold;

const later = "2026-10-06T00:00:00Z";
const refused = (reason: RegExp) => ({ reason, waiting: false });

function assertHold(
  actual: { reason: string; waiting: boolean } | null,
  expected: { reason: RegExp; waiting: boolean },
  message?: string,
) {
  assert.ok(actual, message);
  assert.match(actual.reason, expected.reason, message);
  assert.equal(actual.waiting, expected.waiting, message);
}

test("a current result approving the ready-label event lets readiness count, for a Brief or an issue body", async () => {
  const issues = await resultIssues([briefComment, resultComment()]);
  assert.equal(issues[0].contractHold, null);
  assert.equal(readinessExclusion(issues[0], issues, policy), null);
  // Platform logins ignore case.
  assert.equal(
    await held([
      briefComment,
      resultComment(undefined, {
        author: { login: "GitHub-Actions[bot]", bot: true },
      }),
    ]),
    null,
  );
  // A directly authored ticket's body, never edited or edited before review.
  for (const editedAt of [null, "2026-10-04T00:00:00Z"])
    assert.equal(
      await held(
        [
          resultComment(
            resultState({
              kind: "implementation ticket",
              source: { type: "issue-body", editedAt },
            }),
          ),
        ],
        { details: { lastEditedAt: editedAt } },
      ),
      null,
      `body edited at ${editedAt}`,
    );
});

test("a missing result holds with a hold comment; only the configured author's marked line is a result", async () => {
  const missing = refused(
    /^is refused: no contract result from @github-actions\[bot\] was found on the issue; remove and re-apply ready-for-agent once the issue-contract validator has evaluated the issue$/,
  );
  for (const [name, comments] of [
    ["no comments", []],
    ["a Brief alone", [briefComment]],
    [
      "a person's copy",
      [
        briefComment,
        resultComment(undefined, { author: { login: "owner", bot: false } }),
      ],
    ],
    [
      "another bot's copy",
      [
        briefComment,
        resultComment(undefined, {
          author: { login: "other[bot]", bot: true },
        }),
      ],
    ],
    [
      "the feedback marker without a state line",
      [
        briefComment,
        {
          ...resultComment(),
          body: "<!-- repo-canon:issue-contract-feedback -->\nApproved.",
        },
      ],
    ],
    [
      "a state line inside other text",
      [
        briefComment,
        {
          ...resultComment(),
          body: `Quoted: ${resultComment().body.split("\n")[1]}`,
        },
      ],
    ],
  ] as const)
    assertHold(await held([...comments]), missing, name);
  const issues = await resultIssues([]);
  assert.equal(readinessExclusion(issues[0], issues, policy)?.key, "readiness");
});

test("an unknown format version or an unreadable result holds with a hold comment", async () => {
  for (const [state, reason] of [
    [
      // The earlier line without a format, which Scriptorium's own
      // validator still posts.
      {
        status: "approved",
        revision: "sha256:0",
        label: "ready-for-agent",
        reviewer: "owner",
        reviewEventId: "42",
        sourceInvalidation: null,
      },
      /^is refused: the latest contract result from @github-actions\[bot\] has no format version, and this factory reads only repo-canon\/issue-contract-state\/v1; update the factory or the repository's issue-contract validator so they share a result format$/,
    ],
    [
      resultState({ format: "repo-canon/issue-contract-state/v2" }),
      /has format repo-canon\/issue-contract-state\/v2, and this factory reads only repo-canon\/issue-contract-state\/v1/,
    ],
    ['{"format":', /result from @github-actions\[bot\] is unreadable/],
    ["null", /is unreadable/],
    ["[]", /is unreadable/],
  ] as const) {
    const issues = await resultIssues([briefComment, resultComment(state)]);
    assertHold(issues[0].contractHold, refused(reason), String(reason));
    assert.equal(
      readinessExclusion(issues[0], issues, policy)?.key,
      "readiness",
    );
  }
});

test("a current result that does not approve the ready-label event holds with a hold comment", async () => {
  // The recorded result, which approves nothing.
  assertHold(
    await held([
      briefComment,
      resultComment(
        recordedLine.slice(
          "<!-- repo-canon:issue-contract-state ".length,
          -" -->".length,
        ),
      ),
    ]),
    refused(
      /^is refused: the validator's latest contract result, awaiting-review, does not approve the current ready-for-agent event; review the current contract, then remove and re-apply ready-for-agent/,
    ),
  );
  for (const fields of [
    { status: "needs-attention" },
    { status: "no-contract" },
    { label: "ready-for-human" },
    { reviewEventId: "43" },
    { reviewEventId: 42 },
    { reviewEventId: "opened:1" },
  ])
    assertHold(
      await held([briefComment, resultComment(resultState(fields))]),
      refused(/does not approve the current ready-for-agent event/),
      JSON.stringify(fields),
    );
  // The latest marked comment by the author is the result, not an earlier
  // approval.
  assertHold(
    await held([
      briefComment,
      resultComment(),
      resultComment(resultState({ status: "awaiting-review" }), {
        id: 12,
        nodeId: "IC_12",
      }),
    ]),
    refused(/, awaiting-review, does not approve/),
  );
});

test("a result older than a comment, edit, deletion or label change waits for the validator's next result", async () => {
  const waits = {
    reason:
      /^waits: the issue changed after the validator's latest contract result at 2026-10-05T00:00:01Z; the validator's next result decides it$/,
    waiting: true,
  };
  const comment = {
    ...briefComment,
    id: 12,
    nodeId: "IC_12",
    body: "A question.",
    createdAt: later,
    updatedAt: later,
  };
  const removed = (id: number, label: string, at = later) => ({
    ...labeled(id, user("owner"), at, label),
    event: "unlabeled",
  });
  for (const [name, comments, options] of [
    ["a newer comment", [briefComment, resultComment(), comment], {}],
    [
      "an older comment edited since",
      [
        briefComment,
        resultComment(),
        { ...comment, createdAt: "2026-10-04T00:00:00Z" },
      ],
      {},
    ],
    [
      "a newer Brief edit",
      [{ ...briefComment, updatedAt: later }, resultComment()],
      {},
    ],
    ["a newer deletion", [briefComment, resultComment()], { deletion: later }],
    [
      "a newer body edit",
      [briefComment, resultComment()],
      { details: { lastEditedAt: later } },
    ],
    [
      "a removed category label",
      [briefComment, resultComment()],
      { events: [removed(44, "bug")] },
    ],
    [
      "re-applied readiness",
      [briefComment, resultComment()],
      {
        events: [removed(44, labels.ready), labeled(45, user("owner"), later)],
      },
    ],
    [
      "a model label",
      [briefComment, resultComment()],
      { events: [labeled(44, user("owner"), later, "model:gpt-5.5")] },
    ],
  ] as const) {
    const issues = await resultIssues([...comments], options);
    assertHold(issues[0].contractHold, waits, name);
    // A wait is log-only: it has no hold comment.
    assert.equal(
      readinessExclusion(issues[0], issues, policy)?.key,
      undefined,
      name,
    );
  }
  // The validator writes its result after its own label writes, so a change
  // in the result's second is not newer.
  assert.equal(
    await held(
      [
        briefComment,
        resultComment(),
        { ...comment, updatedAt: "2026-10-05T00:00:01Z" },
      ],
      {
        events: [removed(43, "needs-triage", "2026-10-05T00:00:01Z")],
      },
    ),
    null,
  );
});

test("a triaged request whose body is edited after readiness runs once the validator posts a newer approving result", async () => {
  const edited = { details: { lastEditedAt: later } };
  assert.equal(
    (await held([briefComment, resultComment()], edited))?.waiting,
    true,
  );
  assert.equal(
    await held(
      [
        briefComment,
        resultComment(undefined, { updatedAt: "2026-10-07T00:00:00Z" }),
      ],
      edited,
    ),
    null,
  );
  // A removed category's newer result needs attention and approves nothing.
  assertHold(
    await held(
      [
        briefComment,
        resultComment(resultState({ status: "needs-attention" }), {
          updatedAt: "2026-10-07T00:00:00Z",
        }),
      ],
      {
        events: [
          {
            ...labeled(44, user("owner"), later, "bug"),
            event: "unlabeled",
          },
        ],
      },
    ),
    refused(/, needs-attention, does not approve/),
  );
});

test("the factory's own hold comments and configured label writes do not make the result stale", async () => {
  const hold = (body: string, at = later): Comment => ({
    ...briefComment,
    id: 13,
    nodeId: "IC_13",
    author: { login: "factory[bot]", bot: true },
    body,
    createdAt: at,
    updatedAt: at,
  });
  const factoryLabels = [
    labeled(44, { login: "factory[bot]", type: "Bot" }, later, labels.running),
    {
      ...labeled(
        45,
        { login: "factory[bot]", type: "Bot" },
        later,
        labels.paused,
      ),
      event: "unlabeled",
    },
    labeled(46, user("owner"), later, labels.failed),
    labeled(47, user("owner"), later, labels.needsInput),
  ];
  for (const comment of [
    hold(
      "<!-- scriptorium:hold:readiness -->\nThe factory is holding this issue: its readiness is refused: a reason.",
    ),
    hold(
      "<!-- scriptorium:hold:model-label -->\nResolved: this reason no longer holds the issue.",
    ),
  ])
    assert.equal(
      await held([briefComment, resultComment(), comment], {
        events: factoryLabels,
      }),
      null,
    );
  // Anything else under a hold marker is a change the validator evaluates.
  for (const body of [
    "<!-- scriptorium:hold:readiness -->\nThe factory is holding this issue: a reason.\n\n## Agent Brief",
    "<!-- scriptorium:hold:readiness -->\n## Agent Brief",
    "Note\n<!-- scriptorium:hold:readiness -->\nResolved: this reason no longer holds the issue.",
  ])
    assert.equal(
      (await held([briefComment, resultComment(), hold(body)]))?.waiting,
      true,
      body,
    );
});

test("the contract source the result names must be present and unedited", async () => {
  const waits =
    /^waits: the issue changed after the validator's latest contract result/;
  for (const [name, comments, options] of [
    ["a deleted Brief", [resultComment()], {}],
    [
      "a Brief edited before the result",
      [{ ...briefComment, updatedAt: "2026-10-03T00:00:00Z" }, resultComment()],
      {},
    ],
    [
      "a body edited before the result",
      [
        resultComment(
          resultState({ source: { type: "issue-body", editedAt: null } }),
        ),
      ],
      { details: { lastEditedAt: "2026-10-04T00:00:00Z" } },
    ],
  ] as const)
    assertHold(
      await held([...comments], options),
      { reason: waits, waiting: true },
      name,
    );
  for (const source of [
    null,
    { type: "comment", id: 10, editedAt: briefComment.updatedAt },
    { type: "comment", id: "10" },
    { type: "pull-request", editedAt: null },
  ])
    assertHold(
      await held([briefComment, resultComment(resultState({ source }))]),
      refused(/names no readable contract source/),
      JSON.stringify(source),
    );
});

test("the host's role policy still applies to an approved result, naming the refused role", async () => {
  const issues = await resultIssues([briefComment, resultComment()], {
    role: "write",
  });
  assert.equal(issues[0].contractHold, null);
  const exclusion = readinessExclusion(issues[0], issues, policy);
  assert.match(
    exclusion!.reason,
    /ready-for-agent was applied by @owner, whose repository role write is not authorized/,
  );
  assert.equal(exclusion!.key, "readiness");
});

test("unreadable comments or deletion history wait with an actionable reason", async () => {
  for (const [comments, deletion] of [
    [502, null],
    [[briefComment, resultComment()], 502],
  ] as const)
    assertHold(
      await held(typeof comments === "number" ? comments : [...comments], {
        deletion,
      }),
      {
        reason:
          /^waits: the issue-contract validator's result or the issue's comment history could not be read this pass; restore comment access and retry$/,
        waiting: true,
      },
    );
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
    if (request === "PosternSubIssueLinkAdditions")
      return {
        status: 200,
        data: {
          data: {
            repository: {
              issue: {
                timelineItems: page([
                  {
                    createdAt: "2026-10-03T00:00:00Z",
                    actor: { __typename: "User", login: "casey" },
                    subIssue: reference("Acme/Widgets", 2),
                  },
                  {
                    createdAt: "2026-10-06T00:00:00Z",
                    actor: { __typename: "User", login: "owner" },
                    subIssue: reference("acme/gadgets", 6, "CLOSED"),
                  },
                  {
                    createdAt: "2026-10-07T00:00:00Z",
                    actor: { __typename: "User", login: "casey" },
                    subIssue: reference("acme/widgets", 2),
                  },
                  {
                    createdAt: "2026-10-07T12:00:00Z",
                    actor: null,
                    subIssue: null,
                  },
                  {
                    createdAt: "2026-10-08T00:00:00Z",
                    actor: { __typename: "Bot", login: "release-bot[bot]" },
                    subIssue: null,
                  },
                  {
                    createdAt: "2026-10-09T00:00:00Z",
                    actor: { __typename: "User", login: "morgan" },
                    subIssue: null,
                  },
                ]),
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
    // Each ready issue's current result approves its readiness.
    const commented =
      /^GET \/repos\/acme\/widgets\/issues\/(\d+)\/comments$/.exec(request);
    if (commented) {
      const [eventId, editedAt] = (
        {
          1: [3, "2026-10-02T00:00:00Z"],
          2: [5, null],
          4: [6, null],
          5: [7, null],
          8: [8, null],
        } as Record<string, [number, string | null]>
      )[commented[1]];
      return {
        status: 200,
        data: [
          restComment(
            resultComment(
              resultState({
                source: { type: "issue-body", editedAt },
                reviewEventId: String(eventId),
              }),
              { updatedAt: "2026-10-10T00:00:00Z" },
            ),
          ),
        ],
      };
    }
    if (request === "FactoryCommentDeletions")
      return {
        status: 200,
        data: {
          data: { repository: { issue: { timelineItems: { nodes: [] } } } },
        },
      };
    const role = /\/collaborators\/(\w+)\/permission$/.exec(request);
    if (role?.[1] === "owner")
      return { status: 200, data: { permission: "admin", role_name: "admin" } };
    if (role?.[1] === "casey")
      return { status: 200, data: { permission: "none", role_name: "" } };
    if (role?.[1] === "morgan")
      return { status: 502, data: { message: "Server Error" } };
  });
  const issues = await repositoryPlatform(
    connection,
    configuration,
  ).readIssues();
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
      linkAdditions: [
        {
          ticket: 2,
          at: "2026-10-03T00:00:00Z",
          actor: { kind: "user", login: "casey", role: null },
        },
        {
          ticket: "acme/gadgets#6",
          at: "2026-10-06T00:00:00Z",
          actor: { kind: "user", login: "owner", role: "admin" },
        },
        {
          ticket: 2,
          at: "2026-10-07T00:00:00Z",
          actor: { kind: "user", login: "casey", role: null },
        },
        {
          ticket: null,
          at: "2026-10-07T12:00:00Z",
          actor: { kind: "unknown" },
        },
        {
          ticket: null,
          at: "2026-10-08T00:00:00Z",
          actor: { kind: "bot", login: "release-bot[bot]" },
        },
        {
          ticket: null,
          at: "2026-10-09T00:00:00Z",
          actor: { kind: "unreadable", login: "morgan" },
        },
      ],
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
      linkAdditions: null,
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
      linkAdditions: null,
      subIssues: [],
      blockedBy: [],
    })),
  ]);
  // Only ready issues' label changes and results are read, and each role
  // once.
  assert.deepEqual(
    requests.filter((request) => request !== "PosternIssues"),
    [
      "GET /repos/acme/widgets/issues/1/events",
      "GET /repos/acme/widgets/collaborators/owner/permission",
      "GET /repos/acme/widgets/issues/1/comments",
      "FactoryCommentDeletions",
      "PosternSubIssueLinkAdditions",
      "GET /repos/acme/widgets/collaborators/casey/permission",
      "GET /repos/acme/widgets/collaborators/morgan/permission",
      "GET /repos/acme/widgets/issues/2/events",
      "GET /repos/acme/widgets/issues/2/comments",
      "FactoryCommentDeletions",
      "GET /repos/acme/widgets/issues/4/events",
      "GET /repos/acme/widgets/issues/4/comments",
      "FactoryCommentDeletions",
      "GET /repos/acme/widgets/issues/5/events",
      "GET /repos/acme/widgets/issues/5/comments",
      "FactoryCommentDeletions",
      "GET /repos/acme/widgets/issues/8/events",
      "GET /repos/acme/widgets/issues/8/comments",
      "FactoryCommentDeletions",
      "GET /repos/acme/widgets/issues/9/events",
    ],
  );
});
test("link history distinguishes unsupported, empty, unknown-time and failed reads", async () => {
  const setup = () =>
    github((request) => {
      if (request === "PosternIssues")
        return {
          status: 200,
          data: {
            data: {
              repository: {
                issues: page([
                  issueNode(1, {
                    subIssues: page([reference("acme/widgets", 2)]),
                    timelineItems: {
                      nodes: [{ createdAt: "2026-10-06T00:00:00Z" }],
                    },
                  }),
                ]),
              },
            },
          },
        };
      if (request.endsWith("/events"))
        return {
          status: 200,
          data: [labeled(1, user("owner"), "2026-10-05T00:00:00Z")],
        };
      if (request.endsWith("/permission"))
        return {
          status: 200,
          data: { permission: "admin", role_name: "admin" },
        };
    }).connection;
  const unsupported = setup();
  const { subIssueLinkAdditions: _history, ...capabilities } =
    unsupported.issueTracker.capabilities;
  const legacy = repositoryPlatform(
    {
      ...unsupported,
      issueTracker: { ...unsupported.issueTracker, capabilities },
    },
    configuration,
  );
  const [fallback] = await legacy.readIssues();
  assert.equal(fallback.linkAdditions, null);
  assert.deepEqual(fallback.latestLink, {
    ticket: null,
    at: "2026-10-06T00:00:00Z",
  });

  const original = setup();
  const connection = {
    ...original,
    issueTracker: { ...original.issueTracker },
  };
  connection.issueTracker.subIssueLinkAdditions = async () => [];
  assert.deepEqual(
    (await repositoryPlatform(connection, configuration).readIssues())[0]
      .linkAdditions,
    [],
  );
  connection.issueTracker.subIssueLinkAdditions = async () => [
    { subIssue: null, actor: null, time: null },
  ];
  assert.deepEqual(
    (await repositoryPlatform(connection, configuration).readIssues())[0]
      .linkAdditions,
    [{ ticket: null, actor: { kind: "unknown" }, at: null }],
  );
  connection.issueTracker.subIssueLinkAdditions = async () => {
    throw new PlatformError("unavailable", "history unavailable");
  };
  await assert.rejects(
    repositoryPlatform(connection, configuration).readIssues(),
    {
      reason: "unavailable",
    },
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
  await repositoryPlatform(
    existing.connection,
    configuration,
  ).createStateLabels();
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
    repositoryPlatform(forbidden.connection, configuration).createStateLabels(),
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
  await repositoryPlatform(connection, configuration).fail(4, "failed");
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
  await repositoryPlatform(connection, configuration).close(1, [
    2,
    "acme/gadgets#6",
  ]);
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
      configuration,
    ).pullRequestState(4, since);
  const observed = async (
    closing: unknown[],
    branch: unknown[],
    viewerStatus = 200,
  ) => {
    const { pullRequests: context, ...observation } = await repositoryPlatform(
      answers(closing, branch, viewerStatus).connection,
      configuration,
    ).pullRequestObservation(4);
    assert.ok(Array.isArray(context));
    return observation;
  };
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
    { state: "open", ownedPullRequests: [2], mergeCandidate: candidate },
    "count owned PRs, not all closing candidates",
  );
  assert.deepEqual(
    await observed([pull(2, "OPEN")], [pull(2, "OPEN")]),
    { state: "open", ownedPullRequests: [2], mergeCandidate: candidate },
    "deduplicate candidates",
  );
  assert.deepEqual(
    await observed([pull(2, "OPEN", { headRefName: "other" })], []),
    { state: "open", ownedPullRequests: [2], mergeCandidate: candidate },
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
      { state: "open", ownedPullRequests: [] },
    );
  assert.deepEqual(
    await observed([], [pull(2, "OPEN"), pull(3, "OPEN")]),
    { state: "open", ownedPullRequests: [2, 3] },
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
    { state: "open", ownedPullRequests: [2], mergeCandidate: candidate },
    "installation-token viewer failure preserves branch ownership",
  );
  assert.deepEqual(
    await observed([pull(2, "OPEN", { headRefName: "other" })], [], 403),
    { state: "open", ownedPullRequests: [] },
    "unreadable identity grants no author ownership",
  );
  assert.deepEqual(await observed([pull(2, "MERGED")], []), {
    state: "merged",
    ownedPullRequests: [],
    closesIssue: true,
  });
  assert.deepEqual(await observed([], [pull(2, "MERGED")]), {
    state: "merged",
    ownedPullRequests: [],
  });
  assert.deepEqual(
    await observed([pull(2, "MERGED", { isCrossRepository: true })], []),
    { state: "none", ownedPullRequests: [] },
  );
  const context = await repositoryPlatform(
    answers([], [pull(2, "CLOSED")]).connection,
    configuration,
  ).pullRequestObservation(4);
  assert.deepEqual(context.pullRequests, [
    {
      number: 2,
      headBranch: "factory/issue-4",
      state: "closed",
      createdAt: "2026-10-09T12:00:00Z",
    },
  ]);
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
    await repositoryPlatform(connection, {
      labels: configured,
      contractResult,
    }).readClosedClaims(),
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
  } as unknown as ConnectionWithLinkAdditions;
  return { platform: repositoryPlatform(connection, configuration), writes };
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

test("release holds read all open labelled PR numbers through authenticated pages", async () => {
  const { connection, requests } = github((request, body) => {
    assert.equal(request, "FactoryReleaseHold");
    assert.deepEqual(body.variables, {
      owner: "acme",
      name: "widgets",
      label: "release-hold",
      after: requests.length === 1 ? null : "next",
    });
    assert.match(body.query, /states: OPEN/);
    assert.match(body.query, /labels: \[\$label\]/);
    return {
      status: 200,
      data: {
        data: {
          repository: {
            pullRequests: {
              totalCount: 2,
              nodes: [{ number: requests.length === 1 ? 40 : 41 }],
              pageInfo: {
                hasNextPage: requests.length === 1,
                endCursor: requests.length === 1 ? "next" : null,
              },
            },
          },
        },
      },
    };
  });
  assert.deepEqual(
    await repositoryPlatform(connection, configuration).readReleaseHold(),
    [],
  );
  assert.equal(requests.length, 0);
  assert.deepEqual(
    await repositoryPlatform(connection, {
      labels: {
        ...labels,
        releaseHold: "release-hold",
      },
      contractResult,
    }).readReleaseHold(),
    [40, 41],
  );
});

test("unreadable or incomplete release holds never imply no hold", async () => {
  for (const response of [
    { status: 503, data: {} },
    { status: 200, data: { errors: [{ message: "unavailable" }] } },
    { status: 200, data: { data: { repository: null } } },
    ...[
      { totalCount: 1, nodes: [], pageInfo: { hasNextPage: false } },
      {
        totalCount: 1,
        nodes: [{ number: "40" }],
        pageInfo: { hasNextPage: false },
      },
      {
        totalCount: 1,
        nodes: [{ number: 40 }],
        pageInfo: { hasNextPage: true, endCursor: null },
      },
    ].map((pullRequests) => ({
      status: 200,
      data: { data: { repository: { pullRequests } } },
    })),
  ]) {
    const { connection } = github(() => response);
    await assert.rejects(
      repositoryPlatform(connection, {
        labels: {
          ...labels,
          releaseHold: "release-hold",
        },
        contractResult,
      }).readReleaseHold(),
    );
  }
});

test("a factory hold reads every open labelled issue and PR through authenticated pages", async () => {
  const answered: Record<string, number[][]> = {
    FactoryHoldIssues: [[12], [7, 30]],
    FactoryHoldPullRequests: [[30, 41]],
  };
  const { connection, requests } = github((request, body) => {
    const pages = answered[request];
    assert.ok(pages, `no ${request} read`);
    const kind = request === "FactoryHoldIssues" ? "issues" : "pullRequests";
    assert.match(body.query, new RegExp(`${kind}\\(first: 100`));
    assert.match(body.query, /states: OPEN/);
    assert.match(body.query, /labels: \[\$label\]/);
    const index = requests.filter((name) => name === request).length - 1;
    assert.deepEqual(body.variables, {
      owner: "acme",
      name: "widgets",
      label: "factory:hold",
      after: index === 0 ? null : `next-${index}`,
    });
    const more = index < pages.length - 1;
    return {
      status: 200,
      data: {
        data: {
          repository: {
            [kind]: {
              totalCount: pages.flat().length,
              nodes: pages[index].map((number) => ({ number })),
              pageInfo: {
                hasNextPage: more,
                endCursor: more ? `next-${index + 1}` : null,
              },
            },
          },
        },
      },
    };
  });
  assert.deepEqual(
    await repositoryPlatform(connection, configuration).readHold(),
    [],
  );
  assert.equal(requests.length, 0);
  assert.deepEqual(
    await repositoryPlatform(connection, {
      labels: {
        ...labels,
        releaseHold: "release-hold",
        hold: "factory:hold",
      },
      contractResult,
    }).readHold(),
    [7, 12, 30, 41],
  );
  assert.deepEqual(requests, [
    "FactoryHoldIssues",
    "FactoryHoldIssues",
    "FactoryHoldPullRequests",
  ]);
});

test("an unreadable or incomplete factory hold never implies no hold", async () => {
  const valid = {
    totalCount: 0,
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  for (const failing of ["FactoryHoldIssues", "FactoryHoldPullRequests"])
    for (const broken of [
      { status: 503, data: {} },
      { status: 200, data: { errors: [{ message: "unavailable" }] } },
      { status: 200, data: { data: { repository: null } } },
      ...[
        { totalCount: 1, nodes: [], pageInfo: { hasNextPage: false } },
        {
          totalCount: 1,
          nodes: [{ number: "40" }],
          pageInfo: { hasNextPage: false },
        },
        {
          totalCount: 1,
          nodes: [{ number: 40 }],
          pageInfo: { hasNextPage: true, endCursor: null },
        },
      ].map((connection) => ({
        status: 200,
        data: {
          data: {
            repository: {
              [failing === "FactoryHoldIssues" ? "issues" : "pullRequests"]:
                connection,
            },
          },
        },
      })),
    ]) {
      const { connection } = github((request) =>
        request === failing
          ? broken
          : {
              status: 200,
              data: {
                data: {
                  repository: {
                    [request === "FactoryHoldIssues"
                      ? "issues"
                      : "pullRequests"]: valid,
                  },
                },
              },
            },
      );
      await assert.rejects(
        repositoryPlatform(connection, {
          labels: {
            ...labels,
            hold: "factory:hold",
          },
          contractResult,
        }).readHold(),
      );
    }
});
