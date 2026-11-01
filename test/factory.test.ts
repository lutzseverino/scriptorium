import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideFactory,
  factoryHoldReason,
  type Claim,
  type Decision,
  type Issue,
  type Repository,
  type Run,
  type Settings,
  type Snapshot,
  type Usage,
  type UsageHold,
} from "../src/factory.ts";
import { createRegistry } from "../src/providers.ts";
import type { Actor } from "../src/readiness.ts";
import { fakePorts } from "./fakes.ts";

// The factory's decision core, driven by snapshots of the host's
// repositories, the runs the host knows, provider usage, and host settings.
const now = "2026-10-09T12:00:00Z";
const widgets = "acme/widgets";
const gadgets = "acme/gadgets";

const registry = createRegistry(
  {
    "claude-code": { credential: "/etc/factory/claude-token" },
    codex: { credential: "/etc/factory/codex-auth.json" },
  },
  fakePorts().ports,
);

// The owner, whose admin role the host authorizes.
const owner: Actor = { kind: "user", login: "owner", role: "admin" };

// An issue the owner labelled when it was created, and never edited.
function issue(
  number: number,
  labels = ["ready-for-agent"],
  details: Partial<Issue> = {},
): Issue {
  const createdAt = `2026-10-0${Math.min(number, 9)}T00:00:00Z`;
  return {
    number,
    createdAt,
    labels,
    ready: { at: createdAt, actor: owner },
    editedAt: null,
    contractHold: null,
    nativeParent: null,
    latestLink: null,
    linkAdditions: null,
    subIssues: [],
    blockedBy: [],
    ...details,
  };
}

function repository(
  name: string,
  issues: Issue[],
  details: Partial<Repository> = {},
): Repository {
  return {
    name,
    configuration: {
      version: 2,
      labels: {
        ready: "ready-for-agent",
        running: "factory:running",
        failed: "factory:failed",
        needsInput: "factory:needs-input",
        paused: "factory:paused",
      },
      contractResult: {
        marker: "repo-canon:issue-contract-state",
        author: "github-actions[bot]",
      },
      modelLabelPrefix: "model:",
      skill: "implement",
      arguments: "#{issue}",
    },
    authorization: {
      authorizedRoles: ["admin", "maintain"],
      neverAuthorize: [],
    },
    paused: null,
    issues,
    claims: [],
    ...details,
  };
}

// A snapshot of one repository, acme/widgets, unless `repositories` names
// several. A usage given as a number was read at `now`.
function snapshot({
  issues = [],
  runs = [],
  claims = [],
  repositories,
  usage = {},
  holds = {},
  owners = {},
  settings = {},
  authorization,
}: {
  issues?: Issue[];
  runs?: Run[];
  claims?: Claim[];
  repositories?: Repository[];
  usage?: Record<string, number | Usage | null>;
  holds?: Record<string, UsageHold | null>;
  owners?: Snapshot["owners"];
  settings?: Partial<Settings>;
  authorization?: Repository["authorization"];
} = {}): Snapshot {
  return {
    now,
    repositories: repositories ?? [
      repository(widgets, issues, {
        claims,
        ...(authorization && { authorization }),
      }),
    ],
    runs,
    usage: Object.fromEntries(
      Object.entries(usage).map(([provider, reading]) => [
        provider,
        typeof reading === "number" ? { used: reading, at: now } : reading,
      ]),
    ),
    holds,
    owners,
    settings: {
      defaultModel: "claude-sonnet-5-5",
      retryModel: "claude-opus-5-5@xhigh",
      caps: { "claude-code": 3, codex: 2 },
      drainThreshold: 80,
      pauseThreshold: null,
      timeLimitMinutes: 240,
      ...settings,
    },
  };
}

function log(issueNumber: number, repositoryName = widgets) {
  return `/srv/factory/repositories/${repositoryName}/logs/issue-${issueNumber}-attempt-1.log`;
}

function run(issueNumber: number, details: Partial<Run> = {}): Run {
  return {
    repository: widgets,
    issue: issueNumber,
    provider: "claude-code",
    model: "claude-sonnet-5-5",
    effort: "high",
    attempt: 1,
    startedAt: "2026-10-09T11:00:00Z",
    log: log(issueNumber, details.repository),
    ended: null,
    ...details,
  };
}

function decide(input: Parameters<typeof snapshot>[0]) {
  return decideFactory(snapshot(input), registry);
}

function at(issueNumber: number, repositoryName = widgets) {
  return { repository: repositoryName, issue: issueNumber };
}

function launches(decisions: Decision[]) {
  return decisions.filter((decision) => decision.kind === "launch");
}

function launched(decisions: Decision[]) {
  return launches(decisions).map(
    (decision) => `${decision.repository}#${decision.issue}`,
  );
}

function skipOf(decisions: Decision[], number: number, name = widgets) {
  const skip = decisions.find(
    (decision) =>
      decision.kind === "skip" &&
      decision.issue === number &&
      decision.repository === name,
  );
  return skip?.kind === "skip" ? skip.reason : undefined;
}

const claimed = ["ready-for-agent", "factory:running"];
const none = { timedOut: false, pullRequest: "none" } as const;

test("a ready issue runs directly on the host's default model", () => {
  assert.deepEqual(decide({ issues: [issue(4)] }), [
    { kind: "claim", ...at(4) },
    {
      kind: "launch",
      ...at(4),
      provider: "claude-code",
      model: "claude-sonnet-5-5",
      effort: "high",
      attempt: 1,
    },
  ]);
});

test("only issues carrying ready-for-agent reach the frontier", () => {
  assert.deepEqual(
    decide({ issues: [issue(4, ["needs-triage"]), issue(5, [])] }),
    [],
  );
});

test("a configured skip label prevents new pickup until it is removed", () => {
  const skipped = repository(widgets, [
    issue(4, ["ready-for-agent", "manual-delivery"]),
  ]);
  skipped.configuration.labels.skip = "manual-delivery";
  const decisions = decide({
    repositories: [
      skipped,
      repository(gadgets, [issue(5, ["ready-for-agent", "manual-delivery"])]),
    ],
  });
  assert.deepEqual(
    decisions.filter((decision) => decision.issue === 4),
    [
      {
        kind: "skip",
        ...at(4),
        reason: "labelled `manual-delivery`; delivered outside the factory",
      },
    ],
  );
  assert.deepEqual(launched(decisions), ["acme/gadgets#5"]);

  skipped.issues[0].labels = ["ready-for-agent"];
  assert.deepEqual(
    decide({ repositories: [skipped] }).map(({ kind }) => kind),
    ["claim", "launch"],
  );
});

test("claimed, failed and blocked issues are skipped with their reasons", () => {
  const decisions = decide({
    issues: [
      issue(4, claimed),
      issue(5, ["ready-for-agent", "factory:failed"]),
      issue(6, ["ready-for-agent"], {
        blockedBy: [
          { number: 2, state: "open" },
          { number: 3, state: "closed" },
          { number: "acme/gadgets#8", state: "open" },
        ],
      }),
      issue(7, ["ready-for-agent"], {
        blockedBy: [{ number: 3, state: "closed" }],
      }),
    ],
  });
  assert.equal(skipOf(decisions, 4), "claimed by a running factory run");
  assert.equal(
    skipOf(decisions, 5),
    "labelled factory:failed; remove the label to run it again",
  );
  assert.equal(skipOf(decisions, 6), "blocked by #2, acme/gadgets#8");
  assert.deepEqual(launched(decisions), ["acme/widgets#7"]);
});

// Readiness counts only when its label's latest actor holds an authorized
// role now and it is newer than the body's last edit.
const reapply =
  "a person with the admin or maintain role must remove and re-apply ready-for-agent";

function readyBy(actor: Actor, at = "2026-10-09T10:00:00Z") {
  return { ready: { at, actor } };
}

test("readiness from a user holding an authorized role releases the issue", () => {
  const decisions = decide({
    issues: [
      issue(4, undefined, readyBy(owner)),
      issue(5, undefined, readyBy({ ...owner, role: "maintain" })),
    ],
  });
  assert.deepEqual(launched(decisions), ["acme/widgets#4", "acme/widgets#5"]);
});

test("readiness from a role the host doesn't authorize is refused", () => {
  for (const role of ["write", "triage", "read", "custom-reviewer"]) {
    const decisions = decide({
      issues: [
        issue(4, undefined, readyBy({ ...owner, login: "casey", role })),
      ],
    });
    assert.deepEqual(launches(decisions), [], role);
    assert.equal(
      skipOf(decisions, 4),
      `its readiness is refused: ready-for-agent was applied by @casey, whose repository role ${role} is not authorized; ${reapply}`,
    );
  }
  const widened = decide({
    issues: [issue(4, undefined, readyBy({ ...owner, role: "triage" }))],
    authorization: { authorizedRoles: ["triage"], neverAuthorize: [] },
  });
  assert.deepEqual(launched(widened), ["acme/widgets#4"]);
});

test("readiness from a user who holds no repository role is refused", () => {
  const decisions = decide({
    issues: [
      issue(4, undefined, readyBy({ ...owner, login: "casey", role: null })),
    ],
  });
  assert.deepEqual(launches(decisions), []);
  assert.equal(
    skipOf(decisions, 4),
    `its readiness is refused: ready-for-agent was applied by @casey, who holds no repository role; ${reapply}`,
  );
});

test("readiness from an account the host never lets authorize is refused, whatever its role", () => {
  const decisions = decide({
    issues: [
      issue(4, undefined, readyBy({ ...owner, login: "Release-Helper" })),
      issue(
        5,
        undefined,
        readyBy({ kind: "unreadable", login: "release-helper" }),
      ),
      issue(6, undefined, readyBy(owner)),
    ],
    authorization: {
      authorizedRoles: ["admin", "maintain"],
      neverAuthorize: ["release-helper"],
    },
  });
  assert.deepEqual(launched(decisions), ["acme/widgets#6"]);
  for (const [number, login] of [
    [4, "Release-Helper"],
    [5, "release-helper"],
  ] as const)
    assert.equal(
      skipOf(decisions, number),
      `its readiness is refused: ready-for-agent was applied by @${login}, an account the host configuration never lets authorize; ${reapply}`,
    );
});

test("readiness from a bot, an app or an account that is not a user never authorizes", () => {
  const decisions = decide({
    issues: [
      issue(4, undefined, readyBy({ kind: "bot", login: "factory-app" })),
      issue(5, undefined, readyBy({ kind: "unknown" })),
      issue(6, undefined, { ready: null }),
    ],
  });
  assert.deepEqual(launches(decisions), []);
  assert.equal(
    skipOf(decisions, 4),
    `its readiness is refused: ready-for-agent was applied by factory-app, a bot or app, which never authorizes; ${reapply}`,
  );
  assert.equal(
    skipOf(decisions, 5),
    `its readiness is refused: ready-for-agent was applied by an account that is not a user, which never authorizes; ${reapply}`,
  );
  assert.equal(
    skipOf(decisions, 6),
    "its readiness is refused: no event applying ready-for-agent was found; remove and re-apply ready-for-agent",
  );
});

test("a failed role lookup holds the issue for that pass only", () => {
  const unread = decide({
    issues: [
      issue(4, undefined, readyBy({ kind: "unreadable", login: "owner" })),
    ],
  });
  assert.deepEqual(launches(unread), []);
  assert.equal(
    skipOf(unread, 4),
    "its readiness waits: the repository role of @owner, who applied ready-for-agent, could not be read this pass",
  );
  assert.deepEqual(launched(decide({ issues: [issue(4)] })), [
    "acme/widgets#4",
  ]);
});

// Whether a body edit cancels a running issue's readiness is the validator's
// decision, which reaches the core as its contract hold.
test("a body edit after readiness leaves the decision to the contract result", () => {
  const readyAt = "2026-10-09T10:00:00Z";
  for (const editedAt of ["2026-10-09T10:00:01Z", readyAt, null])
    assert.deepEqual(
      launched(
        decide({
          issues: [
            issue(4, undefined, { ...readyBy(owner, readyAt), editedAt }),
          ],
        }),
      ),
      ["acme/widgets#4"],
      `edited at ${editedAt}`,
    );
});

test("a contract result hold gates pickup, retry, child release and parent closure", () => {
  for (const waiting of [false, true]) {
    const contractHold = {
      reason: `${waiting ? "waits" : "is refused"}: the validator's contract result needs attention`,
      waiting,
    };
    assert.deepEqual(
      launches(decide({ issues: [issue(4, undefined, { contractHold })] })),
      [],
    );
    const retry = decide({
      issues: [issue(4, claimed, { contractHold })],
      runs: [run(4, { ended: none })],
    });
    assert.ok(
      retry.some((decision) => decision.kind === (waiting ? "skip" : "fail")),
    );
    assert.deepEqual(launches(retry), []);
    const children = decide({
      issues: [parent(released, { contractHold }), ...tickets()],
    });
    assert.deepEqual(launches(children), []);
    assert.match(
      skipOf(children, 5)!,
      /sub-issue of #3, whose readiness.*contract result needs attention/,
    );
    const closing = decide({
      issues: [
        parent(released, {
          contractHold,
          subIssues: [{ number: 5, state: "closed" }],
        }),
      ],
    });
    assert.ok(closing.every((decision) => decision.kind !== "close"));
  }
});

// A parent's readiness releases its tickets: it counts only when it was
// applied after the latest of its tickets was linked.
const released = "2026-10-09T10:06:00Z";

function parent(readyAt: string, details: Partial<Issue> = {}) {
  return issue(3, ["ready-for-agent"], {
    ready: { at: readyAt, actor: owner },
    latestLink: { ticket: 6, at: "2026-10-09T10:05:00Z" },
    subIssues: [
      { number: 5, state: "open" },
      { number: 6, state: "open" },
      { number: 4, state: "closed" },
    ],
    ...details,
  });
}

function tickets(labels = ["ready-for-agent"]) {
  return [
    issue(5, labels, { nativeParent: 3 }),
    issue(6, labels, { nativeParent: 3 }),
  ];
}

test("a ready parent closes once every native sub-issue is closed", () => {
  assert.deepEqual(
    decide({
      issues: [
        parent(released, {
          subIssues: [
            { number: 5, state: "closed" },
            { number: "acme/gadgets#6", state: "closed" },
          ],
        }),
      ],
    }),
    [{ kind: "close", ...at(3), tickets: [5, "acme/gadgets#6"] }],
  );
});

test("a finished parent waits for its local and cross-repository blockers to close", () => {
  const finished = parent(released, {
    subIssues: [{ number: 5, state: "closed" }],
    blockedBy: [
      { number: 1, state: "closed" },
      { number: 2, state: "open" },
      { number: "acme/gadgets#8", state: "open" },
    ],
  });

  for (const blocker of finished.blockedBy.slice(1)) {
    const decisions = decide({ issues: [finished] });
    assert.equal(
      decisions.some((decision) => decision.kind === "close"),
      false,
    );
    assert.deepEqual(launches(decisions), []);
    blocker.state = "closed";
  }

  assert.deepEqual(decide({ issues: [finished] }), [
    { kind: "close", ...at(3), tickets: [5] },
  ]);
});

test("closing a parent takes precedence over settling its earlier run or claim", () => {
  for (const state of [
    { runs: [run(3, { ended: none })] },
    { runs: [run(3, { attempt: 2, ended: { ...none, timedOut: true } })] },
    { runs: [run(3)] },
    { claims: [{ issue: 3, pullRequest: "none" as const }] },
  ])
    assert.deepEqual(
      decide({
        issues: [
          parent(released, { subIssues: [{ number: 5, state: "closed" }] }),
        ],
        ...state,
      }),
      [{ kind: "close", ...at(3), tickets: [5] }],
    );
});

test("parents stay open without readiness or with an open ticket", () => {
  const decisions = decide({
    issues: [
      parent(released, {
        labels: ["wayfinder:map"],
        subIssues: [{ number: 5, state: "closed" }],
      }),
      parent(released, {
        number: 7,
        subIssues: [{ number: "acme/gadgets#8", state: "open" }],
      }),
    ],
  });
  assert.equal(
    decisions.some((decision) => decision.kind === "close"),
    false,
  );
  assert.deepEqual(launches(decisions), []);
});

test("a finished parent stays open while its readiness is refused or unread", () => {
  const finished = {
    subIssues: [
      { number: 5, state: "closed" as const },
      { number: "acme/gadgets#6", state: "closed" as const },
    ],
  };
  for (const [details, reason] of [
    [
      readyBy({ kind: "bot", login: "factory-app" }, released),
      `is refused: ready-for-agent was applied by factory-app, a bot or app, which never authorizes; ${reapply}`,
    ],
    [
      readyBy({ ...owner, login: "casey", role: "write" }, released),
      `is refused: ready-for-agent was applied by @casey, whose repository role write is not authorized; ${reapply}`,
    ],
    [
      { editedAt: released },
      `is refused: ready-for-agent was applied at ${released}, not after the body's last edit at ${released}; review the edit, then remove and re-apply ready-for-agent`,
    ],
    [
      readyBy({ kind: "unreadable", login: "owner" }, released),
      "waits: the repository role of @owner, who applied ready-for-agent, could not be read this pass",
    ],
  ] as const) {
    const decisions = decide({
      issues: [parent(released, { ...finished, ...details })],
    });
    assert.deepEqual(
      decisions,
      [
        {
          kind: "skip",
          ...at(3),
          reason: `its readiness ${reason}`,
          ...(!reason.startsWith("waits:") && { hold: "readiness" }),
        },
      ],
      reason,
    );
  }
});

test("closing any ready parent does not require other pickup gates", () => {
  assert.deepEqual(
    decide({
      issues: [
        issue(3, ["ready-for-agent", "model:unusable"], {
          latestLink: { ticket: 5, at: released },
          subIssues: [{ number: 5, state: "closed" }],
        }),
      ],
      settings: { caps: {} },
    }),
    [{ kind: "close", ...at(3), tickets: [5] }],
  );
});

test("any issue with native sub-issues is a parent that never launches", () => {
  const decisions = decide({
    issues: [
      parent(released),
      issue(7, ["ready-for-agent", "wayfinder:map"], {
        subIssues: [{ number: 8, state: "open" }],
      }),
      issue(9, ["ready-for-agent"], {
        nativeParent: 3,
        subIssues: [{ number: 10, state: "open" }],
      }),
    ],
  });
  assert.deepEqual(launches(decisions), []);
  for (const number of [3, 7, 9])
    assert.equal(
      skipOf(decisions, number),
      "an issue with sub-issues never runs; its readiness releases its tickets",
    );
});

test("a ready sub-issue runs once its parent is ready after its latest ticket link", () => {
  const decisions = decide({
    issues: [
      parent(released),
      ...tickets(),
      issue(7, ["needs-triage"], { nativeParent: 3 }),
    ],
  });
  assert.deepEqual(launched(decisions), ["acme/widgets#5", "acme/widgets#6"]);
});

test("authorized sub-issue links keep a parent's readiness valid", () => {
  const decisions = decide({
    issues: [
      parent(released, {
        latestLink: { ticket: 6, at: released },
        linkAdditions: [
          { ticket: 5, at: released, actor: owner },
          {
            ticket: 6,
            at: "2026-10-09T10:07:00Z",
            actor: { ...owner, role: "maintain" },
          },
        ],
      }),
      ...tickets(),
    ],
  });
  assert.deepEqual(launched(decisions), ["acme/widgets#5", "acme/widgets#6"]);
});

test("any unauthorized addition since readiness holds a parent despite later authorized links", () => {
  for (const actor of [
    { kind: "user", login: "casey", role: "write" },
    { kind: "user", login: "casey", role: null },
    { kind: "bot", login: "factory[bot]" },
    { kind: "unknown" },
    { kind: "unreadable", login: "casey" },
    { kind: "user", login: "EXCLUDED", role: "admin" },
  ] satisfies Actor[]) {
    for (const at of [released, "2026-10-09T10:07:00Z"]) {
      const decisions = decide({
        authorization: {
          authorizedRoles: ["admin", "maintain"],
          neverAuthorize: ["excluded"],
        },
        issues: [
          parent(released, {
            linkAdditions: [
              {
                ticket: 5,
                at: "2026-10-09T10:05:00Z",
                actor: { kind: "unknown" },
              },
              { ticket: null, at, actor },
              { ticket: 5, at: "2026-10-09T10:08:00Z", actor: owner },
              { ticket: 5, at: "2026-10-09T10:09:00Z", actor: owner },
            ],
          }),
          ...tickets(),
        ],
      });
      assert.deepEqual(launches(decisions), [], `${actor.kind} at ${at}`);
      assert.match(skipOf(decisions, 5)!, /sub-issue of #3, whose readiness/);
      const hold = decisions.find(
        (decision) => decision.kind === "skip" && decision.issue === 5,
      );
      assert.ok(hold?.kind === "skip");
      assert.equal(
        hold.hold,
        actor.kind === "unreadable" ? undefined : "parent-readiness",
      );
    }
  }
});

test("an unknown link time holds a parent even for an authorized actor", () => {
  const decisions = decide({
    issues: [
      parent(released, {
        linkAdditions: [{ ticket: 5, at: null, actor: owner }],
      }),
      ...tickets(),
    ],
  });
  assert.deepEqual(launches(decisions), []);
  assert.match(skipOf(decisions, 5)!, /ticket link has no known time/);
});

test("complete link history supersedes latest-link time and ignores only additions before readiness", () => {
  for (const linkAdditions of [
    [],
    [{ ticket: 5, at: "2026-10-09T10:05:59Z", actor: { kind: "unknown" } }],
    [{ ticket: null, at: released, actor: owner }],
  ] satisfies NonNullable<Issue["linkAdditions"]>[]) {
    const decisions = decide({
      issues: [
        parent(released, {
          latestLink: { ticket: 6, at: released },
          linkAdditions,
        }),
        ...tickets(),
      ],
    });
    assert.deepEqual(launched(decisions), ["acme/widgets#5", "acme/widgets#6"]);
  }
});

test("a sub-issue waits while its parent is not ready for agent", () => {
  for (const labels of [[], ["needs-triage"]]) {
    const decisions = decide({
      issues: [parent(released, { labels }), ...tickets()],
    });
    assert.deepEqual(launches(decisions), []);
    for (const number of [5, 6])
      assert.equal(
        skipOf(decisions, number),
        "sub-issue of #3, which is not ready; apply ready-for-agent to #3 once its tickets are published",
      );
  }
});

test("a ticket stays held until its parent's readiness is re-applied after its latest link", () => {
  for (const readyAt of ["2026-10-09T10:02:00Z", "2026-10-09T10:05:00Z"]) {
    const decisions = decide({ issues: [parent(readyAt), ...tickets()] });
    assert.deepEqual(launches(decisions), [], `readiness at ${readyAt}`);
    for (const number of [5, 6])
      assert.equal(
        skipOf(decisions, number),
        "sub-issue of #3, whose readiness predates its latest ticket #6; remove and re-apply ready-for-agent on #3 once its tickets are published",
      );
  }
});

test("a ticket waits while its parent's readiness is refused or unread", () => {
  const onParent = "remove and re-apply ready-for-agent on #3";
  for (const [details, reason] of [
    [
      readyBy({ kind: "bot", login: "factory-app" }, released),
      `whose readiness is refused: ready-for-agent was applied by factory-app, a bot or app, which never authorizes; a person with the admin or maintain role must ${onParent}`,
    ],
    [
      readyBy({ ...owner, login: "casey", role: "triage" }, released),
      `whose readiness is refused: ready-for-agent was applied by @casey, whose repository role triage is not authorized; a person with the admin or maintain role must ${onParent}`,
    ],
    [
      { editedAt: "2026-10-09T10:07:00Z" },
      `whose readiness is refused: ready-for-agent was applied at ${released}, not after the body's last edit at 2026-10-09T10:07:00Z; review the edit, then ${onParent}`,
    ],
    [
      readyBy({ kind: "unreadable", login: "owner" }, released),
      "whose readiness waits: the repository role of @owner, who applied ready-for-agent, could not be read this pass",
    ],
  ] as const) {
    const decisions = decide({
      issues: [parent(released, details), ...tickets()],
    });
    assert.deepEqual(launches(decisions), [], reason);
    for (const number of [5, 6])
      assert.equal(skipOf(decisions, number), `sub-issue of #3, ${reason}`);
  }
});

test("a parent's body edit before its readiness doesn't hold its tickets", () => {
  const decisions = decide({
    issues: [
      parent(released, { editedAt: "2026-10-09T10:05:59Z" }),
      ...tickets(),
    ],
  });
  assert.deepEqual(launched(decisions), ["acme/widgets#5", "acme/widgets#6"]);
});

test("a sub-issue waits while its parent has an open native blocker", () => {
  const blocked = decide({
    issues: [
      parent(released, {
        blockedBy: [
          { number: 1, state: "open" },
          { number: 2, state: "closed" },
        ],
      }),
      ...tickets(),
    ],
  });
  assert.deepEqual(launches(blocked), []);
  assert.equal(
    skipOf(blocked, 5),
    "sub-issue of #3, which is blocked by #1; it waits until #3's blockers close",
  );
  const unblocked = decide({
    issues: [
      parent(released, { blockedBy: [{ number: 1, state: "closed" }] }),
      ...tickets(),
    ],
  });
  assert.deepEqual(launched(unblocked), ["acme/widgets#5", "acme/widgets#6"]);
});

test("a sub-issue of a closed parent or one in another repository runs directly", () => {
  for (const nativeParent of [4, "acme/gadgets#3"]) {
    const decisions = decide({
      issues: [
        parent(released, { labels: [] }),
        issue(7, ["ready-for-agent"], { nativeParent }),
      ],
    });
    assert.deepEqual(
      launched(decisions),
      ["acme/widgets#7"],
      `native parent ${nativeParent}`,
    );
  }
});

test("the oldest ready issue launches first", () => {
  const decisions = decide({
    issues: [
      issue(9, undefined, { createdAt: "2026-10-03T00:00:00Z" }),
      issue(2, undefined, { createdAt: "2026-10-05T00:00:00Z" }),
      issue(5, undefined, { createdAt: "2026-10-01T00:00:00Z" }),
    ],
  });
  assert.deepEqual(launched(decisions), [
    "acme/widgets#5",
    "acme/widgets#9",
    "acme/widgets#2",
  ]);
});

test("model labels resolve through the provider registry under the model: prefix", () => {
  const decisions = decide({
    issues: [
      issue(1, ["ready-for-agent", "model:claude-opus-5-5"]),
      issue(2, ["ready-for-agent", "model:gpt-5.5@xhigh"]),
      issue(3, ["ready-for-agent", "model:codex/o5@low"]),
      issue(4, ["ready-for-agent", "model:claude-code/opus@max"]),
    ],
  });
  assert.deepEqual(
    launches(decisions).map(({ issue, provider, model, effort }) => ({
      issue,
      provider,
      model,
      effort,
    })),
    [
      {
        issue: 1,
        provider: "claude-code",
        model: "claude-opus-5-5",
        effort: "high",
      },
      { issue: 2, provider: "codex", model: "gpt-5.5", effort: "xhigh" },
      { issue: 3, provider: "codex", model: "o5", effort: "low" },
      { issue: 4, provider: "claude-code", model: "opus", effort: "max" },
    ],
  );
});

test("the host's default model may name its provider and effort", () => {
  const [, launch] = decide({
    issues: [issue(4)],
    settings: { defaultModel: "codex/o5@medium" },
  });
  assert.equal(launch.kind, "launch");
  assert.deepEqual(
    { provider: launch.provider, model: launch.model, effort: launch.effort },
    { provider: "codex", model: "o5", effort: "medium" },
  );
});

test("an unusable model label skips the issue with a correction", () => {
  const decisions = decide({
    issues: [
      issue(1, ["ready-for-agent", "model:gemini-3"]),
      issue(2, ["ready-for-agent", "model:cursor/composer-2"]),
      issue(3, ["ready-for-agent", "model:gpt-5.5@max"]),
      issue(4, ["ready-for-agent", "model:gpt-5.5", "model:claude-opus-5-5"]),
      issue(5, ["ready-for-agent", "model:codex/"]),
    ],
  });
  assert.deepEqual(launches(decisions), []);
  assert.equal(
    skipOf(decisions, 1),
    "model gemini-3 names no provider; name it model:<provider>/gemini-3, choose claude-code or codex",
  );
  assert.equal(
    skipOf(decisions, 2),
    "provider cursor is not configured on this host; choose claude-code or codex",
  );
  assert.equal(
    skipOf(decisions, 3),
    'effort "max" is not one codex accepts: low, medium, high, xhigh',
  );
  assert.equal(
    skipOf(decisions, 4),
    "several model labels: model:gpt-5.5, model:claude-opus-5-5",
  );
  assert.equal(skipOf(decisions, 5), "model codex/ names no model");
});

test("a provider launches only while fewer agents than its cap run there", () => {
  const decisions = decide({
    issues: [
      issue(1, claimed),
      issue(4),
      issue(5),
      issue(6, ["ready-for-agent", "model:gpt-5.5"]),
    ],
    runs: [run(1)],
    settings: { caps: { "claude-code": 2, codex: 1 } },
  });
  assert.deepEqual(launched(decisions), ["acme/widgets#4", "acme/widgets#6"]);
  assert.equal(
    skipOf(decisions, 5),
    "claude-code already runs its cap of 2 agents",
  );
  assert.ok(
    !decisions.some(
      (decision) => decision.kind === "claim" && decision.issue === 5,
    ),
  );
});

test("a provider without a cap launches nothing", () => {
  const decisions = decide({
    issues: [issue(4, ["ready-for-agent", "model:gpt-5.5"])],
    settings: { caps: { "claude-code": 2 } },
  });
  assert.equal(skipOf(decisions, 4), "the host sets no cap for codex");
});

test("a provider launches only while its usage is below the threshold", () => {
  const decisions = decide({
    issues: [issue(4), issue(5, ["ready-for-agent", "model:gpt-5.5"])],
    usage: { "claude-code": 80, codex: 79.5 },
  });
  assert.deepEqual(launched(decisions), ["acme/widgets#5"]);
  assert.equal(
    skipOf(decisions, 4),
    "claude-code usage 80% is at or above the 80% drain threshold",
  );
});

test("an unreadable usage reading gates by count only", () => {
  const decisions = decide({
    issues: [issue(4), issue(5)],
    usage: { "claude-code": null },
    settings: { caps: { "claude-code": 1 } },
  });
  assert.deepEqual(launched(decisions), ["acme/widgets#4"]);
  assert.equal(
    skipOf(decisions, 5),
    "claude-code already runs its cap of 1 agent",
  );
});

test("caps count running sandboxes across every repository", () => {
  const decisions = decideFactory(
    snapshot({
      repositories: [
        repository(widgets, [issue(4)]),
        repository(gadgets, [issue(1, claimed), issue(2, claimed)]),
      ],
      runs: [run(1, { repository: gadgets }), run(2, { repository: gadgets })],
      settings: { caps: { "claude-code": 2, codex: 1 } },
    }),
    registry,
  );
  assert.deepEqual(launches(decisions), []);
  assert.equal(
    skipOf(decisions, 4),
    "claude-code already runs its cap of 2 agents",
  );
});

test("a claim awaiting merge or an ended run takes no cap slot", () => {
  const decisions = decideFactory(
    snapshot({
      repositories: [
        repository(widgets, [issue(4), issue(5)]),
        repository(gadgets, [issue(1, claimed), issue(2, claimed)], {
          claims: [{ issue: 2, pullRequest: "open" }],
        }),
      ],
      runs: [
        run(1, {
          repository: gadgets,
          ended: { timedOut: false, pullRequest: "open" },
        }),
      ],
      settings: { caps: { "claude-code": 1, codex: 1 } },
    }),
    registry,
  );
  assert.deepEqual(launched(decisions), ["acme/widgets#4"]);
  assert.equal(
    skipOf(decisions, 5),
    "claude-code already runs its cap of 1 agent",
  );
});

test("pickup is one oldest-first queue across repositories", () => {
  const decisions = decideFactory(
    snapshot({
      repositories: [
        repository(widgets, [
          issue(7, undefined, { createdAt: "2026-10-03T00:00:00Z" }),
          issue(2, undefined, { createdAt: "2026-10-01T00:00:00Z" }),
        ]),
        repository(gadgets, [
          issue(9, undefined, { createdAt: "2026-10-02T00:00:00Z" }),
          issue(3, undefined, { createdAt: "2026-10-03T00:00:00Z" }),
        ]),
      ],
      settings: { caps: { "claude-code": 3, codex: 1 } },
    }),
    registry,
  );
  assert.deepEqual(launched(decisions), [
    "acme/widgets#2",
    "acme/gadgets#9",
    "acme/gadgets#3",
  ]);
  assert.equal(
    skipOf(decisions, 7),
    "claude-code already runs its cap of 3 agents",
  );
});

test("the same issue number in two repositories is two issues", () => {
  const decisions = decideFactory(
    snapshot({
      repositories: [
        repository(widgets, [issue(4)]),
        repository(gadgets, [issue(4, claimed)]),
      ],
      runs: [run(4, { repository: gadgets, ended: none })],
    }),
    registry,
  );
  assert.deepEqual(
    decisions.map(({ kind, repository, issue }) => ({
      kind,
      repository,
      issue,
    })),
    [
      { kind: "launch", ...at(4, gadgets) },
      { kind: "claim", ...at(4) },
      { kind: "launch", ...at(4) },
    ],
  );
  const [retry] = decisions;
  assert.equal(retry.kind === "launch" && retry.attempt, 2);
});

test("a paused repository claims and launches nothing while its runs keep settling", () => {
  const decisions = decideFactory(
    snapshot({
      repositories: [
        repository(
          gadgets,
          [issue(1), issue(2, claimed), issue(3, claimed), issue(5, claimed)],
          {
            paused: "it has no .factory/Dockerfile",
            claims: [{ issue: 6, pullRequest: "merged" }],
          },
        ),
        repository(widgets, [issue(4, undefined, { createdAt: now })]),
      ],
      runs: [
        run(2, { repository: gadgets, ended: none }),
        run(3, {
          repository: gadgets,
          ended: { timedOut: false, pullRequest: "open" },
        }),
        run(5, { repository: gadgets, startedAt: "2026-10-09T07:00:00Z" }),
      ],
      settings: { caps: { "claude-code": 2, codex: 1 } },
    }),
    registry,
  );
  assert.deepEqual(decisions, [
    {
      kind: "keep",
      ...at(3, gadgets),
    },
    {
      kind: "stop",
      ...at(5, gadgets),
      reason: "exceeded the time limit of 240 minutes",
    },
    { kind: "release", ...at(6, gadgets) },
    {
      kind: "skip",
      ...at(1, gadgets),
      reason: "acme/gadgets is paused: it has no .factory/Dockerfile",
      hold: "repository-configuration",
    },
    {
      kind: "skip",
      ...at(2, gadgets),
      reason:
        "retry waits: acme/gadgets is paused: it has no .factory/Dockerfile",
      hold: "repository-configuration",
    },
    {
      kind: "skip",
      ...at(3, gadgets),
      reason: "claimed by a running factory run",
    },
    {
      kind: "skip",
      ...at(5, gadgets),
      reason: "claimed by a running factory run",
    },
    { kind: "claim", ...at(4) },
    {
      kind: "launch",
      ...at(4),
      provider: "claude-code",
      model: "claude-sonnet-5-5",
      effort: "high",
      attempt: 1,
    },
  ]);
});

test("a running sandbox of a repository this pass could not read still counts and stops", () => {
  const decisions = decideFactory(
    snapshot({
      repositories: [repository(widgets, [issue(4)])],
      runs: [
        run(1, { repository: gadgets, startedAt: "2026-10-09T07:00:00Z" }),
      ],
      settings: { caps: { "claude-code": 1, codex: 1 } },
    }),
    registry,
  );
  assert.deepEqual(decisions, [
    {
      kind: "stop",
      ...at(1, gadgets),
      reason: "exceeded the time limit of 240 minutes",
    },
    {
      kind: "skip",
      ...at(4),
      reason: "claude-code already runs its cap of 1 agent",
    },
  ]);
});

for (const attempt of [1, 2] as const)
  for (const timedOut of [false, true])
    for (const pullRequest of ["none", "closed"] as const)
      test(`attempt ${attempt} needing input releases its claim with ${pullRequest} pull request, timed out: ${timedOut}`, () => {
        assert.deepEqual(
          decide({
            issues: [issue(4, [...claimed, "factory:needs-input"])],
            runs: [
              run(4, {
                attempt,
                ended: {
                  timedOut,
                  pullRequest,
                  unpushedChanges: [".github/workflows/ci.yml"],
                },
              }),
            ],
          }),
          [
            { kind: "release", ...at(4) },
            {
              kind: "skip",
              ...at(4),
              reason:
                "labelled factory:needs-input; answer the question and remove the label to run it again",
            },
          ],
        );
      });

test("an ended run's open pull request keeps its claim unless it needs input", () => {
  for (const attempt of [1, 2] as const)
    for (const ending of [
      { timedOut: false },
      { timedOut: true },
      { timedOut: false, orphaned: true as const },
    ])
      for (const needsInput of [false, true]) {
        const decisions = decide({
          issues: [
            issue(
              4,
              needsInput ? [...claimed, "factory:needs-input"] : claimed,
            ),
          ],
          runs: [
            run(4, { attempt, ended: { ...ending, pullRequest: "open" } }),
          ],
        });
        assert.deepEqual(decisions[0], {
          kind: needsInput ? "release" : "keep",
          ...at(4),
        });
        assert.deepEqual(launches(decisions), []);
      }
});

test("a run over the time limit is stopped", () => {
  const decisions = decide({
    issues: [issue(4, claimed), issue(5, claimed)],
    runs: [
      run(4, { startedAt: "2026-10-09T07:59:59Z" }),
      run(5, { startedAt: "2026-10-09T08:00:00Z" }),
    ],
  });
  assert.deepEqual(
    decisions.filter((decision) => decision.kind === "stop"),
    [
      {
        kind: "stop",
        ...at(4),
        reason: "exceeded the time limit of 240 minutes",
      },
    ],
  );
});

test("a failed first run retries once on the host's retry model, keeping its claim", () => {
  assert.deepEqual(
    decide({
      issues: [issue(4, [...claimed, "model:gpt-5.5"])],
      runs: [run(4, { provider: "codex", model: "gpt-5.5", ended: none })],
    }),
    [
      {
        kind: "launch",
        ...at(4),
        provider: "claude-code",
        model: "claude-opus-5-5",
        effort: "xhigh",
        attempt: 2,
        retry: {
          failure: "the run ended without an open pull request",
          log: log(4),
        },
      },
    ],
  );
});

test("a retry waits for its provider's gate", () => {
  const decisions = decide({
    issues: [issue(4, claimed)],
    runs: [run(4, { ended: none })],
    usage: { "claude-code": 95 },
  });
  assert.deepEqual(launches(decisions), []);
  assert.deepEqual(decisions[0], {
    kind: "skip",
    ...at(4),
    reason:
      "retry waits: claude-code usage 95% is at or above the 80% drain threshold",
  });
});

test("a run that ends without an open pull request fails once retried or unretryable", () => {
  const retried = decide({
    issues: [issue(4, claimed)],
    runs: [run(4, { attempt: 2, ended: none })],
  });
  assert.deepEqual(retried[0], {
    kind: "fail",
    ...at(4),
    failure: "the run ended without an open pull request",
    log: log(4),
  });
  const unretryable = decide({
    issues: [issue(4, claimed)],
    runs: [run(4, { ended: none })],
    settings: { retryModel: "gemini-3" },
  });
  assert.equal(unretryable[0].kind, "fail");
});

test("a retried run that exceeded the time limit fails without an open pull request", () => {
  const [decision] = decide({
    issues: [issue(4, claimed)],
    runs: [run(4, { attempt: 2, ended: { ...none, timedOut: true } })],
  });
  assert.deepEqual(decision, {
    kind: "fail",
    ...at(4),
    failure: "the run exceeded the time limit of 240 minutes",
    log: log(4),
  });
});

test("a run that opened its pull request keeps the claim until it merges", () => {
  assert.deepEqual(
    decide({
      issues: [issue(4, claimed)],
      runs: [
        run(4, { ended: { timedOut: false, pullRequest: "open" } }),
        run(5, { ended: { timedOut: false, pullRequest: "merged" } }),
      ],
    }),
    [
      { kind: "keep", ...at(4) },
      { kind: "release", ...at(5) },
      { kind: "skip", ...at(4), reason: "claimed by a running factory run" },
    ],
  );
});

test("an issue whose run is still on the host is not launched twice", () => {
  const decisions = decide({ issues: [issue(4)], runs: [run(4)] });
  assert.deepEqual(launches(decisions), []);
  assert.equal(
    skipOf(decisions, 4),
    "a factory run for it is still on the host",
  );
});

test("a claim no run holds stays while its pull request is open and is released once it merges", () => {
  assert.deepEqual(
    decide({
      issues: [issue(4, claimed)],
      claims: [
        { issue: 4, pullRequest: "open" },
        { issue: 5, pullRequest: "merged" },
      ],
    }),
    [
      { kind: "keep", ...at(4) },
      { kind: "release", ...at(5) },
      { kind: "skip", ...at(4), reason: "claimed by a running factory run" },
    ],
  );
});

test("a needs-input claim left by an earlier factory process releases unless merged", () => {
  for (const pullRequest of ["none", "closed", "merged", "open"] as const)
    assert.deepEqual(
      decide({
        issues: [issue(4, [...claimed, "factory:needs-input"])],
        claims: [{ issue: 4, pullRequest }],
      }).filter(({ kind }) => kind !== "skip"),
      pullRequest === "merged"
        ? [
            {
              kind: "fail",
              ...at(4),
              failure:
                "its pull request merged without closing the issue; close the issue if that finished it",
              log: null,
            },
          ]
        : [{ kind: "release", ...at(4) }],
    );
});

test("an orphaned claim without an interrupted record retries its failed first attempt", () => {
  const decisions = decide({
    issues: [issue(6, claimed), issue(7, claimed)],
    claims: [
      { issue: 6, pullRequest: "closed" },
      { issue: 7, pullRequest: "none" },
    ],
  });
  assert.deepEqual(launches(decisions), [
    {
      kind: "launch",
      ...at(6),
      provider: "claude-code",
      model: "claude-opus-5-5",
      effort: "xhigh",
      attempt: 2,
      retry: { failure: "its pull request closed without merging", log: "" },
    },
    {
      kind: "launch",
      ...at(7),
      provider: "claude-code",
      model: "claude-opus-5-5",
      effort: "xhigh",
      attempt: 2,
      retry: {
        failure: "no factory run or open pull request holds its claim",
        log: "",
      },
    },
  ]);
});

test("a pull request that merged without closing its issue fails it without a retry", () => {
  const failure =
    "its pull request merged without closing the issue; close the issue if that finished it";
  const fromRun = decide({
    issues: [issue(4, claimed)],
    runs: [run(4, { ended: { timedOut: false, pullRequest: "merged" } })],
  });
  assert.deepEqual(launches(fromRun), []);
  assert.deepEqual(fromRun[0], {
    kind: "fail",
    ...at(4),
    failure,
    log: log(4),
  });
  const fromClaim = decide({
    issues: [issue(6, claimed)],
    claims: [{ issue: 6, pullRequest: "merged" }],
  });
  assert.deepEqual(fromClaim[0], {
    kind: "fail",
    ...at(6),
    failure,
    log: null,
  });
});

test("a retry takes its turn in oldest-first order", () => {
  const decisions = decide({
    issues: [issue(4, claimed), issue(2)],
    runs: [run(4, { ended: none })],
    settings: { caps: { "claude-code": 1 } },
  });
  assert.deepEqual(
    launches(decisions).map(({ issue, attempt }) => ({ issue, attempt })),
    [{ issue: 2, attempt: 1 }],
  );
  assert.equal(
    skipOf(decisions, 4),
    "retry waits: claude-code already runs its cap of 1 agent",
  );
});

test("a retry whose issue is no longer eligible fails it instead", () => {
  const decisions = decide({
    issues: [
      issue(4, ["factory:running"]),
      issue(5, claimed, { blockedBy: [{ number: 2, state: "open" }] }),
      issue(6, [...claimed, "factory:failed"]),
      issue(7, claimed, { nativeParent: 8 }),
      issue(8, [], { subIssues: [{ number: 7, state: "open" }] }),
    ],
    runs: [
      run(4, { ended: none }),
      run(5, { ended: none }),
      run(6, { ended: none }),
      run(7, { ended: none }),
      run(9, { ended: none }),
    ],
  });
  const failed = "the run ended without an open pull request";
  assert.deepEqual(launches(decisions), []);
  assert.deepEqual(
    decisions.map((decision) => ({
      kind: decision.kind,
      issue: decision.issue,
      failure: decision.kind === "fail" ? decision.failure : undefined,
    })),
    [
      { kind: "release", issue: 9, failure: undefined },
      {
        kind: "fail",
        issue: 4,
        failure: `${failed}, and its retry did not launch: it no longer carries ready-for-agent`,
      },
      {
        kind: "fail",
        issue: 5,
        failure: `${failed}, and its retry did not launch: blocked by #2`,
      },
      {
        kind: "fail",
        issue: 6,
        failure: `${failed}, and its retry did not launch: labelled factory:failed; remove the label to run it again`,
      },
      {
        kind: "fail",
        issue: 7,
        failure: `${failed}, and its retry did not launch: sub-issue of #8, which is not ready; apply ready-for-agent to #8 once its tickets are published`,
      },
    ],
  );
});

test("a retry that meets a stale contract result waits, and launches once a newer result approves", () => {
  const stale = {
    reason:
      "waits: the issue changed after the validator's latest contract result at 2026-10-09T11:00:00Z; the validator's next result decides it",
    waiting: true,
  };
  assert.deepEqual(
    decide({
      issues: [issue(4, claimed, { contractHold: stale })],
      runs: [run(4, { ended: none })],
    }),
    [
      {
        kind: "skip",
        ...at(4),
        reason: `retry waits: its readiness ${stale.reason}`,
      },
    ],
  );
  assert.deepEqual(
    launched(
      decide({
        issues: [issue(4, claimed, { editedAt: "2026-10-09T11:30:00Z" })],
        runs: [run(4, { ended: none })],
      }),
    ),
    ["acme/widgets#4"],
  );
});

const interrupted = { interrupted: true } as const;

test("an interrupted run relaunches as the same attempt on its branch without a new claim", () => {
  const retry = {
    failure: "the run ended without an open pull request",
    log: log(4),
  };
  assert.deepEqual(
    decide({
      issues: [issue(4, claimed), issue(5, claimed)],
      runs: [
        run(4, {
          provider: "codex",
          model: "gpt-5.5",
          effort: "low",
          attempt: 2,
          retry,
          ended: interrupted,
        }),
        run(5, { ended: interrupted }),
      ],
    }),
    [
      {
        kind: "launch",
        ...at(4),
        provider: "codex",
        model: "gpt-5.5",
        effort: "low",
        attempt: 2,
        retry,
        relaunch: true,
      },
      {
        kind: "launch",
        ...at(5),
        provider: "claude-code",
        model: "claude-sonnet-5-5",
        effort: "high",
        attempt: 1,
        relaunch: true,
      },
    ],
  );
});

test("an interrupted run continues whatever would now hold its pickup", () => {
  const decisions = decide({
    issues: [
      issue(4, ["factory:running"]),
      issue(5, claimed, { blockedBy: [{ number: 2, state: "open" }] }),
      issue(7, claimed, { nativeParent: 8 }),
      issue(8, [], { subIssues: [{ number: 7, state: "open" }] }),
    ],
    runs: [4, 5, 7].map((number) => run(number, { ended: interrupted })),
  });
  assert.deepEqual(
    launches(decisions).map(({ issue, attempt, relaunch }) => ({
      issue,
      attempt,
      relaunch,
    })),
    [4, 5, 7].map((issue) => ({ issue, attempt: 1, relaunch: true })),
  );
});

test("an interrupted run takes its issue's turn and waits for its gate and its repository", () => {
  const capped = decide({
    issues: [issue(4, claimed), issue(2)],
    runs: [run(4, { ended: interrupted })],
    settings: { caps: { "claude-code": 1 } },
  });
  assert.deepEqual(launched(capped), [`${widgets}#2`]);
  assert.equal(
    skipOf(capped, 4),
    "relaunch waits: claude-code already runs its cap of 1 agent",
  );
  const paused = decideFactory(
    snapshot({
      repositories: [
        repository(widgets, [issue(4, claimed)], {
          paused: "it has no .factory/Dockerfile",
        }),
      ],
      runs: [run(4, { ended: interrupted })],
    }),
    registry,
  );
  assert.deepEqual(paused, [
    {
      kind: "skip",
      ...at(4),
      reason:
        "relaunch waits: acme/widgets is paused: it has no .factory/Dockerfile",
      hold: "repository-configuration",
    },
  ]);
});

test("an interrupted run takes no cap slot until it relaunches", () => {
  assert.deepEqual(
    launched(
      decide({
        issues: [issue(2), issue(4, claimed)],
        runs: [run(4, { ended: interrupted })],
        settings: { caps: { "claude-code": 2 } },
      }),
    ),
    [`${widgets}#2`, `${widgets}#4`],
  );
});

test("an interrupted run releases its claim once its issue closed or needs input", () => {
  assert.deepEqual(
    decide({
      issues: [issue(5, [...claimed, "factory:needs-input"])],
      runs: [
        run(4, { ended: interrupted }),
        run(5, { attempt: 2, ended: interrupted }),
      ],
    }).filter(({ kind }) => kind !== "skip"),
    [
      { kind: "release", ...at(5) },
      { kind: "release", ...at(4) },
    ],
  );
});

test("closing a parent takes precedence over relaunching its interrupted run", () => {
  assert.deepEqual(
    decide({
      issues: [
        issue(3, claimed, { subIssues: [{ number: 9, state: "closed" }] }),
      ],
      runs: [run(3, { ended: interrupted })],
    }),
    [{ kind: "close", ...at(3), tickets: [9] }],
  );
});

// A pause half an hour before `now`, whose reset is later that day.
const limit = {
  cause: "usage limit",
  reset: "12:50pm (UTC)",
  at: "2026-10-09T11:30:00.000Z",
  until: "2026-10-09T12:50:00.000Z",
} as const;
const pausing = { paused: limit, commented: false };
const pausedRun = { paused: limit, commented: true };
const pausedLabels = ["ready-for-agent", "factory:paused"];

test("adding the skip label leaves running work, outcomes, retries and resumes unchanged", () => {
  for (const ended of [
    null,
    none,
    { timedOut: false, pullRequest: "open" } as const,
    { interrupted: true } as const,
    pausing,
    pausedRun,
  ]) {
    const labels = ended && "paused" in ended ? pausedLabels : claimed;
    const current = repository(widgets, [issue(4, [...labels])]);
    current.configuration.labels.skip = "manual-delivery";
    const input = {
      repositories: [current],
      runs: [run(4, { ended })],
      usage: { "claude-code": 10 },
    };
    const before = decide(input);
    current.issues[0].labels.push("manual-delivery");
    const after = decide(input);
    // A running issue's pickup skip can change wording; its run decisions
    // must stay the same, including eventual retry and relaunch decisions.
    assert.deepEqual(
      after.filter(({ kind }) => kind !== "skip"),
      before.filter(({ kind }) => kind !== "skip"),
      JSON.stringify(ended),
    );
  }
});

test("a run that ended on its provider's usage limit pauses its issue once, without a retry or a cap slot", () => {
  const retry = {
    failure: "the run ended without an open pull request",
    log: log(4),
  };
  assert.deepEqual(
    decide({
      issues: [issue(2), issue(4, claimed), issue(5, claimed)],
      runs: [
        run(4, { attempt: 2, retry, ended: pausing }),
        run(5, {
          ended: { paused: { ...limit, reset: null }, commented: false },
        }),
      ],
      settings: { caps: { "claude-code": 1 } },
    }),
    [
      { kind: "claim", ...at(2) },
      {
        kind: "launch",
        ...at(2),
        provider: "claude-code",
        model: "claude-sonnet-5-5",
        effort: "high",
        attempt: 1,
      },
      { kind: "pause", ...at(4), pause: limit },
      { kind: "pause", ...at(5), pause: { ...limit, reset: null } },
    ],
  );
});

test("a paused run resumes as the same attempt only once its provider's usage reads below the threshold", () => {
  const retry = {
    failure: "the run ended without an open pull request",
    log: log(4),
  };
  const paused = (
    usage: Record<string, number | null>,
    reset: string | null = limit.reset,
  ) =>
    decide({
      issues: [issue(4, pausedLabels)],
      runs: [
        run(4, {
          provider: "codex",
          model: "gpt-5.5",
          effort: "low",
          attempt: 2,
          retry,
          ended: { paused: { ...limit, reset }, commented: true },
        }),
      ],
      usage,
    });
  assert.equal(
    skipOf(paused({}), 4),
    "relaunch waits: codex hit its usage limit (resets 12:50pm (UTC)); its usage is unreadable, so it waits until 2026-10-09T12:50:00.000Z at most",
  );
  assert.equal(
    skipOf(paused({ codex: null }, null), 4),
    "relaunch waits: codex hit its usage limit; its usage is unreadable, so it waits until 2026-10-09T12:50:00.000Z at most",
  );
  assert.equal(
    skipOf(paused({ codex: 80 }), 4),
    "relaunch waits: codex hit its usage limit (resets 12:50pm (UTC)); usage 80% is at or above the 80% drain threshold",
  );
  assert.deepEqual(paused({ codex: 79 }), [
    { kind: "unpause", ...at(4) },
    {
      kind: "launch",
      ...at(4),
      provider: "codex",
      model: "gpt-5.5",
      effort: "low",
      attempt: 2,
      retry,
      relaunch: true,
    },
  ]);
});

// Whether a run launches, for each usage: below, at and above the 80%
// threshold, and unknown.
const usages = [79, 80, 95, null] as const;

test("a fresh launch is held only by known usage at or above the threshold", () => {
  for (const used of usages)
    assert.equal(
      launched(decide({ issues: [issue(4)], usage: { "claude-code": used } }))
        .length,
      used === null || used < 80 ? 1 : 0,
      String(used),
    );
});

test("a paused run waits on unknown usage only until its deadline, and on high usage past it", () => {
  const decideAt = (time: string, usage: Snapshot["usage"]) =>
    decideFactory(
      {
        ...snapshot({
          issues: [issue(4, pausedLabels)],
          runs: [run(4, { ended: pausedRun })],
        }),
        now: time,
        usage,
      },
      registry,
    );
  const before = "2026-10-09T12:49:59.999Z";
  const deadline = limit.until;
  const after = "2026-10-10T09:00:00.000Z";
  for (const time of [before, deadline, after])
    for (const used of usages) {
      // Read at the pass itself, after the pause.
      const usage = {
        "claude-code": used === null ? null : { used, at: time },
      };
      const relaunched = launched(decideAt(time, usage)).length === 1;
      const expected = used === null ? time !== before : used < 80;
      assert.equal(relaunched, expected, `${used} at ${time}`);
    }
  assert.equal(
    skipOf(decideAt(after, { "claude-code": { used: 95, at: after } }), 4),
    "relaunch waits: claude-code hit its usage limit (resets 12:50pm (UTC)); usage 95% is at or above the 80% drain threshold",
  );
});

test("a low reading from before the pause cannot release it early, while a high one still holds it", () => {
  const decideAt = (time: string, used: number) =>
    decideFactory(
      {
        ...snapshot({
          issues: [issue(4, pausedLabels)],
          runs: [run(4, { ended: pausedRun })],
        }),
        now: time,
        usage: { "claude-code": { used, at: "2026-10-09T11:29:00.000Z" } },
      },
      registry,
    );
  assert.equal(
    skipOf(decideAt(now, 10), 4),
    "relaunch waits: claude-code hit its usage limit (resets 12:50pm (UTC)); its usage was last read before the pause, so it waits until 2026-10-09T12:50:00.000Z at most",
  );
  assert.equal(launched(decideAt(limit.until, 10)).length, 1);
  assert.match(
    skipOf(decideAt(limit.until, 90), 4)!,
    /usage 90% is at or above the 80% drain threshold$/,
  );
  // A fresh launch counts the same reading as its provider's usage.
  assert.equal(
    launched(
      decide({
        issues: [issue(5)],
        usage: { "claude-code": { used: 10, at: "2026-10-09T11:29:00.000Z" } },
      }),
    ).length,
    1,
  );
});

test("a paused run also waits for its provider's cap and its repository", () => {
  const capped = decide({
    issues: [issue(4, pausedLabels)],
    runs: [run(3), run(4, { ended: pausedRun })],
    usage: { "claude-code": 10 },
    settings: { caps: { "claude-code": 1 } },
  });
  assert.equal(
    skipOf(capped, 4),
    "relaunch waits: claude-code already runs its cap of 1 agent",
  );
  const repositoryPaused = decideFactory(
    snapshot({
      repositories: [
        repository(widgets, [issue(4, pausedLabels)], {
          paused: "it has no .factory/Dockerfile",
        }),
      ],
      runs: [run(4, { ended: pausedRun })],
      usage: { "claude-code": 10 },
    }),
    registry,
  );
  assert.deepEqual(repositoryPaused, [
    {
      kind: "skip",
      ...at(4),
      reason:
        "relaunch waits: acme/widgets is paused: it has no .factory/Dockerfile",
      hold: "repository-configuration",
    },
  ]);
});

test("a paused run continues whatever would now hold its pickup", () => {
  assert.deepEqual(
    decide({
      issues: [
        issue(4, ["factory:paused"], {
          blockedBy: [{ number: 2, state: "open" }],
        }),
      ],
      runs: [run(4, { ended: pausedRun })],
      usage: { "claude-code": 10 },
    }).map(({ kind }) => kind),
    ["unpause", "launch"],
  );
});

test("a paused run releases its claim once its issue closed or needs input, told or not", () => {
  for (const ended of [pausing, pausedRun])
    assert.deepEqual(
      decide({
        issues: [issue(5, [...pausedLabels, "factory:needs-input"])],
        runs: [run(4, { ended }), run(5, { ended })],
        usage: { "claude-code": 10 },
      }).filter(({ kind }) => kind !== "skip"),
      [
        { kind: "release", ...at(5) },
        { kind: "release", ...at(4) },
      ],
    );
});

test("closing a parent takes precedence over its paused run", () => {
  assert.deepEqual(
    decide({
      issues: [
        issue(3, pausedLabels, { subIssues: [{ number: 9, state: "closed" }] }),
      ],
      runs: [run(3, { ended: pausing })],
    }),
    [{ kind: "close", ...at(3), tickets: [9] }],
  );
});

test("an open paused-labelled issue is never picked up as a fresh attempt", () => {
  assert.equal(
    skipOf(decide({ issues: [issue(4, pausedLabels)] }), 4),
    "labelled factory:paused; the factory resumes its run by itself",
  );
});

test("a paused-labelled claim no run holds settles as an orphaned claim under the running label", () => {
  const settle = (pullRequest: Claim["pullRequest"]) =>
    decide({
      issues: [issue(4, pausedLabels)],
      claims: [{ issue: 4, pullRequest }],
    }).filter(({ kind }) => kind !== "skip");
  assert.deepEqual(settle("none"), [
    { kind: "unpause", ...at(4) },
    {
      kind: "launch",
      ...at(4),
      provider: "claude-code",
      model: "claude-opus-5-5",
      effort: "xhigh",
      attempt: 2,
      retry: {
        failure: "no factory run or open pull request holds its claim",
        log: "",
      },
    },
  ]);
  assert.deepEqual(settle("open"), [
    { kind: "unpause", ...at(4) },
    { kind: "keep", ...at(4) },
  ]);
  assert.deepEqual(settle("merged"), [
    {
      kind: "fail",
      ...at(4),
      failure:
        "its pull request merged without closing the issue; close the issue if that finished it",
      log: null,
    },
  ]);
  assert.deepEqual(
    decide({ issues: [], claims: [{ issue: 4, pullRequest: "none" }] }),
    [{ kind: "release", ...at(4) }],
  );
});

test("unpushable changes fail either attempt without a retry", () => {
  for (const attempt of [1, 2] as const)
    assert.deepEqual(
      decide({
        issues: [issue(4, claimed)],
        runs: [
          run(4, {
            attempt,
            ended: { ...none, unpushedChanges: [".github/workflows/ci.yml"] },
          }),
        ],
      }).filter((decision) => decision.kind !== "skip"),
      [
        {
          kind: "fail",
          ...at(4),
          failure:
            "the run's branch changes paths the factory's GitHub App can't push",
          unpushedChanges: [".github/workflows/ci.yml"],
          log: log(4),
        },
      ],
    );
});

test("timeouts with unpushable commits fail at once without retry", () => {
  const decisions = decide({
    issues: [issue(4, claimed)],
    runs: [
      run(4, {
        ended: {
          timedOut: true,
          pullRequest: "none",
          unpushedChanges: [".github/workflows/ci.yml"],
        },
      }),
    ],
  });
  assert.deepEqual(decisions[0], {
    kind: "fail",
    ...at(4),
    failure:
      "the run's branch changes paths the factory's GitHub App can't push",
    unpushedChanges: [".github/workflows/ci.yml"],
    log: log(4),
  });
  assert.deepEqual(launches(decisions), []);
});

test("each repository uses its own labels and model label prefix", () => {
  const decisions = decide({
    repositories: [
      repository(
        widgets,
        [
          issue(1, ["queued", "agent:gpt-5.5"]),
          issue(2, ["queued", "broken"]),
          issue(3, ["queued", "question"]),
          issue(4, ["ready-for-agent"]),
        ],
        {
          configuration: {
            version: 2,
            labels: {
              ready: "queued",
              running: "working",
              failed: "broken",
              needsInput: "question",
              paused: "waiting",
            },
            contractResult: {
              marker: "repo-canon:issue-contract-state",
              author: "github-actions[bot]",
            },
            modelLabelPrefix: "agent:",
            skill: "ship",
            arguments: "#{issue}",
          },
        },
      ),
    ],
  });
  assert.deepEqual(launches(decisions), [
    {
      kind: "launch",
      ...at(1),
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
      attempt: 1,
    },
  ]);
  assert.equal(
    skipOf(decisions, 2),
    "labelled broken; remove the label to run it again",
  );
  assert.equal(
    skipOf(decisions, 3),
    "labelled question; answer the question and remove the label to run it again",
  );
  assert.equal(skipOf(decisions, 4), undefined);
});

test("a closed issue is done regardless of timeout, unpushable commits or pull request history", () => {
  for (const pullRequest of ["none", "closed", "merged", "open"] as const) {
    const decision = { kind: "release", ...at(4) };
    for (const timedOut of [false, true])
      assert.deepEqual(
        decide({
          runs: [
            run(4, {
              ended: {
                timedOut,
                pullRequest,
                unpushedChanges: [".github/workflows/ci.yml"],
              },
            }),
          ],
        }),
        [decision],
      );
    assert.deepEqual(
      decide({
        claims: [
          {
            issue: 4,
            pullRequest,
            unpushedChanges: [".github/workflows/ci.yml"],
          },
        ],
      }),
      [decision],
    );
  }
});

test("a merged pull request with an open issue fails before needs input or unpushable commits", () => {
  const issues = [issue(4, [...claimed, "factory:needs-input"])];
  const unpushedChanges = [".github/workflows/ci.yml"];
  const failure =
    "its pull request merged without closing the issue; close the issue if that finished it";
  for (const timedOut of [false, true]) {
    const decisions = decide({
      issues,
      runs: [
        run(4, { ended: { timedOut, pullRequest: "merged", unpushedChanges } }),
      ],
    });
    assert.deepEqual(decisions[0], {
      kind: "fail",
      ...at(4),
      failure,
      log: log(4),
    });
    assert.deepEqual(launches(decisions), []);
  }
  assert.deepEqual(
    decide({
      issues,
      claims: [{ issue: 4, pullRequest: "merged", unpushedChanges }],
    })[0],
    { kind: "fail", ...at(4), failure, log: null },
  );
});

test("an orphaned claim with unpushable commits fails without retry", () => {
  const decisions = decide({
    issues: [issue(4, claimed)],
    claims: [
      {
        issue: 4,
        pullRequest: "none",
        unpushedChanges: [".github/workflows/ci.yml"],
      },
    ],
  });
  assert.deepEqual(decisions[0], {
    kind: "fail",
    ...at(4),
    failure:
      "the run's branch changes paths the factory's GitHub App can't push",
    log: null,
    unpushedChanges: [".github/workflows/ci.yml"],
  });
  assert.deepEqual(launches(decisions), []);
});

test("an orphaned second attempt fails without a third attempt", () => {
  const decisions = decide({
    issues: [issue(4, claimed)],
    runs: [run(4, { attempt: 2, ended: { ...none, orphaned: true } })],
  });
  assert.deepEqual(decisions[0], {
    kind: "fail",
    ...at(4),
    failure: "no factory run or open pull request holds its claim",
    log: log(4),
  });
  assert.deepEqual(launches(decisions), []);
});

test("after needs input is removed pickup starts a fresh attempt 1", () => {
  const waiting = issue(4, [...claimed, "factory:needs-input"]);
  const released = decide({
    issues: [waiting],
    claims: [{ issue: 4, pullRequest: "none" }],
  });
  assert.deepEqual(released[0], { kind: "release", ...at(4) });
  // The release removes the running label; the owner's answer removes needs input.
  waiting.labels = waiting.labels.filter(
    (label) => !["factory:running", "factory:needs-input"].includes(label),
  );
  assert.deepEqual(decide({ issues: [waiting] }), [
    { kind: "claim", ...at(4) },
    {
      kind: "launch",
      ...at(4),
      provider: "claude-code",
      model: "claude-sonnet-5-5",
      effort: "high",
      attempt: 1,
    },
  ]);
});

test("a failed first attempt waits for an unreadable readiness role, including its parent's, then retries", () => {
  for (const orphaned of [false, true])
    for (const parent of [false, true]) {
      const waiting = issue(4, claimed);
      const issues = parent
        ? [
            waiting,
            issue(3, undefined, { subIssues: [{ number: 4, state: "open" }] }),
          ]
        : [waiting];
      if (parent) waiting.nativeParent = 3;
      const authorizing = parent ? issues[1] : waiting;
      authorizing.ready = {
        at: now,
        actor: { kind: "unreadable", login: "owner" },
      };
      const claims: Claim[] = [{ issue: 4, pullRequest: "none" }];
      const observed = orphaned
        ? { issues, claims }
        : { issues, runs: [run(4, { ended: none })] };
      const decisions = decide(observed);
      assert.equal(
        decisions.some(({ kind }) => kind === "fail"),
        false,
      );
      assert.deepEqual(launches(decisions), []);
      assert.match(skipOf(decisions, 4)!, /^retry waits: .*readiness waits:/);
      authorizing.ready.actor = owner;
      assert.equal(launches(decide(observed))[0].attempt, 2);
    }
});

// The drain and pause thresholds, as the owner's host sets them.
const thresholds = { drainThreshold: 90, pauseThreshold: 95 } as const;
const thresholdPause = {
  cause: "pause threshold",
  reset: "2026-10-09T15:00:00.000Z",
  at: "2026-10-09T11:30:00.000Z",
  until: "2026-10-09T15:00:00.000Z",
} as const;

test("at 89, 90, 94 and 95 percent, new claims stop at the drain threshold and running work at the pause threshold", () => {
  const retry = (used: number) =>
    decide({
      issues: [issue(4, claimed)],
      runs: [run(4, { ended: none })],
      usage: { "claude-code": used },
      settings: thresholds,
    });
  const relaunch = (used: number) =>
    decide({
      issues: [issue(4, claimed)],
      runs: [run(4, { ended: interrupted })],
      usage: { "claude-code": used },
      settings: thresholds,
    });
  const running = (used: number) =>
    decide({
      issues: [issue(4, claimed)],
      runs: [run(4)],
      usage: { "claude-code": { used, at: now, reset: thresholdPause.reset } },
      settings: thresholds,
    });
  const resumed = (used: number) =>
    decide({
      issues: [issue(4, pausedLabels)],
      runs: [run(4, { ended: { paused: thresholdPause, commented: true } })],
      usage: { "claude-code": used },
      settings: thresholds,
    });
  const outcomes = [89, 90, 94, 95].map((used) => ({
    used,
    claim: launched(
      decide({
        issues: [issue(5)],
        usage: { "claude-code": used },
        settings: thresholds,
      }),
    ).length,
    retry: launches(retry(used)).length,
    relaunch: launches(relaunch(used)).length,
    stopped: running(used).filter(({ kind }) => kind === "stop").length,
    resumed: launches(resumed(used)).length,
  }));
  assert.deepEqual(outcomes, [
    { used: 89, claim: 1, retry: 1, relaunch: 1, stopped: 0, resumed: 1 },
    { used: 90, claim: 0, retry: 0, relaunch: 1, stopped: 0, resumed: 0 },
    { used: 94, claim: 0, retry: 0, relaunch: 1, stopped: 0, resumed: 0 },
    { used: 95, claim: 0, retry: 0, relaunch: 0, stopped: 1, resumed: 0 },
  ]);
  assert.equal(
    skipOf(
      decide({
        issues: [issue(5)],
        usage: { "claude-code": 90 },
        settings: thresholds,
      }),
      5,
    ),
    "claude-code usage 90% is at or above the 90% drain threshold",
  );
  assert.equal(
    skipOf(retry(94), 4),
    "retry waits: claude-code usage 94% is at or above the 90% drain threshold",
  );
  assert.equal(
    skipOf(relaunch(95), 4),
    "relaunch waits: claude-code usage 95% is at or above the 95% pause threshold",
  );
  assert.equal(
    skipOf(resumed(90), 4),
    "relaunch waits: claude-code reached its pause threshold (resets 2026-10-09T15:00:00.000Z); usage 90% is at or above the 90% drain threshold",
  );
  // The stop fixes the run's pause at this pass, until the reading's reset.
  assert.deepEqual(
    running(95).filter(({ kind }) => kind !== "skip"),
    [
      {
        kind: "stop",
        ...at(4),
        reason: "claude-code usage 95% is at or above the 95% pause threshold",
        pause: {
          cause: "pause threshold",
          reset: "2026-10-09T15:00:00.000Z",
          at: "2026-10-09T12:00:00Z",
          until: "2026-10-09T15:00:00.000Z",
        },
      },
    ],
  );
});

test("a stop at the pause threshold without a reset waits the whole hold, and the time limit stops a run first", () => {
  const stops = decide({
    issues: [issue(4, claimed), issue(5, claimed)],
    runs: [run(4), run(5, { startedAt: "2026-10-09T07:59:00Z" })],
    usage: { "claude-code": 100 },
    settings: thresholds,
  }).filter(({ kind }) => kind !== "skip");
  assert.deepEqual(stops, [
    {
      kind: "stop",
      ...at(4),
      reason: "claude-code usage 100% is at or above the 95% pause threshold",
      pause: {
        cause: "pause threshold",
        reset: null,
        at: now,
        until: "2026-10-10T12:00:00.000Z",
      },
    },
    {
      kind: "stop",
      ...at(5),
      reason: "exceeded the time limit of 240 minutes",
    },
  ]);
});

test("a provider at its thresholds holds only its own work, across every repository", () => {
  const codexModel = "model:gpt-5.5";
  const decisions = decideFactory(
    snapshot({
      repositories: [
        repository(widgets, [
          issue(1),
          issue(2, ["ready-for-agent", codexModel]),
          issue(3, claimed),
        ]),
        repository(gadgets, [
          issue(4),
          issue(5, ["ready-for-agent", codexModel]),
          issue(6, claimed),
        ]),
      ],
      runs: [
        run(3),
        run(6, { repository: gadgets, provider: "codex", model: "gpt-5.5" }),
      ],
      usage: { "claude-code": 92, codex: 10 },
      settings: { ...thresholds, caps: { "claude-code": 3, codex: 3 } },
    }),
    registry,
  );
  assert.deepEqual(launched(decisions), ["acme/widgets#2", "acme/gadgets#5"]);
  assert.match(skipOf(decisions, 1)!, /^claude-code usage 92%/);
  assert.match(skipOf(decisions, 4, gadgets)!, /^claude-code usage 92%/);
  // The drain lets the running run continue; the pause threshold stops it, in
  // any repository, and leaves the other provider's run alone.
  assert.equal(
    decisions.some(({ kind }) => kind === "stop"),
    false,
  );
  const paused = decideFactory(
    snapshot({
      repositories: [
        repository(widgets, [issue(3, claimed)]),
        repository(gadgets, [issue(6, claimed), issue(7, claimed)]),
      ],
      runs: [
        run(3),
        run(6, { repository: gadgets }),
        run(7, { repository: gadgets, provider: "codex", model: "gpt-5.5" }),
      ],
      usage: { "claude-code": 97, codex: 10 },
      settings: thresholds,
    }),
    registry,
  );
  assert.deepEqual(
    paused
      .filter(({ kind }) => kind !== "skip")
      .map(
        (decision) =>
          `${decision.kind} ${decision.repository}#${decision.issue}`,
      ),
    ["stop acme/widgets#3", "stop acme/gadgets#6"],
  );
});

test("auto-resume admits new claims on a reading below the drain threshold while earlier runs still run", () => {
  const decisions = decide({
    issues: [issue(3, claimed), issue(4, claimed), issue(5)],
    runs: [run(3), run(4)],
    usage: { "claude-code": 89.9 },
    settings: thresholds,
  });
  assert.deepEqual(launched(decisions), ["acme/widgets#5"]);
});

test("thresholds set to null hold nothing, and a paused run then waits for its deadline alone", () => {
  const off = { drainThreshold: null, pauseThreshold: null };
  const decisions = decide({
    issues: [issue(3, claimed), issue(4, claimed), issue(5)],
    runs: [run(3), run(4, { ended: none })],
    usage: { "claude-code": 100 },
    settings: off,
  });
  assert.deepEqual(launched(decisions), ["acme/widgets#4", "acme/widgets#5"]);
  assert.equal(
    decisions.some(({ kind }) => kind === "stop"),
    false,
  );
  // A low reading since the pause releases nothing when no threshold is set.
  const pausedAt = (time: string) =>
    decideFactory(
      {
        ...snapshot({
          issues: [issue(4, pausedLabels)],
          runs: [run(4, { ended: pausedRun })],
          settings: off,
        }),
        now: time,
        usage: { "claude-code": { used: 0, at: time } },
      },
      registry,
    );
  assert.equal(
    skipOf(pausedAt(now), 4),
    "relaunch waits: claude-code hit its usage limit (resets 12:50pm (UTC)); the host sets no usage threshold, so it waits until 2026-10-09T12:50:00.000Z at most",
  );
  assert.equal(launched(pausedAt(limit.until)).length, 1);
});

test("without a drain threshold the pause threshold alone stops claims and runs, and is the reading a paused run waits below", () => {
  const pauseOnly = { drainThreshold: null, pauseThreshold: 95 };
  const at94 = decide({
    issues: [issue(3, claimed), issue(5)],
    runs: [run(3)],
    usage: { "claude-code": 94 },
    settings: pauseOnly,
  });
  assert.deepEqual(launched(at94), ["acme/widgets#5"]);
  assert.equal(
    at94.some(({ kind }) => kind === "stop"),
    false,
  );
  const at95 = decide({
    issues: [issue(3, claimed), issue(5)],
    runs: [run(3)],
    usage: { "claude-code": 95 },
    settings: pauseOnly,
  });
  assert.deepEqual(launched(at95), []);
  assert.equal(at95[0].kind, "stop");
  assert.equal(
    skipOf(at95, 5),
    "claude-code usage 95% is at or above the 95% pause threshold",
  );
  const resumed = decide({
    issues: [issue(4, pausedLabels)],
    runs: [run(4, { ended: { paused: thresholdPause, commented: true } })],
    usage: { "claude-code": 94 },
    settings: pauseOnly,
  });
  assert.equal(launches(resumed)[0]?.relaunch, true);
});

test("a usage hold keeps a high reading in force while usage is unknown, until its deadline", () => {
  const hold = {
    used: 92,
    at: "2026-10-09T11:00:00.000Z",
    since: "2026-10-09T10:00:00.000Z",
    until: "2026-10-09T15:00:00.000Z",
  };
  const decideAt = (time: string, holds: Snapshot["holds"]) =>
    decideFactory(
      {
        ...snapshot({
          issues: [issue(3, claimed), issue(4, claimed), issue(5)],
          runs: [run(3, { ended: interrupted }), run(4, { ended: none })],
          settings: thresholds,
        }),
        now: time,
        holds,
      },
      registry,
    );
  const held = decideAt("2026-10-09T14:59:59.999Z", { "claude-code": hold });
  // Running work continues; a new claim and a retry wait.
  assert.deepEqual(launched(held), ["acme/widgets#3"]);
  assert.equal(
    skipOf(held, 5),
    "claude-code usage is unknown, and its usage hold from 92% at 2026-10-09T11:00:00.000Z, at or above the 90% drain threshold, lasts until 2026-10-09T15:00:00.000Z at most",
  );
  assert.match(skipOf(held, 4)!, /^retry waits: claude-code usage is unknown/);
  // At its deadline the hold is over, and unknown usage gates by count only.
  assert.deepEqual(launched(decideAt(hold.until, { "claude-code": hold })), [
    "acme/widgets#3",
    "acme/widgets#4",
    "acme/widgets#5",
  ]);
  // A hold at the pause threshold also holds running work and stops it.
  const pauseHold = { ...hold, used: 96 };
  assert.deepEqual(launched(decideAt(now, { "claude-code": pauseHold })), []);
  const stopping = decideFactory(
    {
      ...snapshot({
        issues: [issue(3, claimed)],
        runs: [run(3)],
        settings: thresholds,
      }),
      holds: { "claude-code": pauseHold },
    },
    registry,
  );
  assert.deepEqual(
    stopping.filter(({ kind }) => kind !== "skip").map(({ kind }) => kind),
    ["stop"],
  );
  // A trusted reading takes precedence over the hold.
  assert.deepEqual(
    launched(
      decideFactory(
        {
          ...snapshot({
            issues: [issue(5)],
            usage: { "claude-code": 40 },
            settings: thresholds,
          }),
          holds: { "claude-code": hold },
        },
        registry,
      ),
    ),
    ["acme/widgets#5"],
  );
});

test("a usage hold holds a paused run past the pause's own deadline, until the hold ends", () => {
  const hold = {
    used: 92,
    at: "2026-10-09T11:00:00.000Z",
    since: "2026-10-09T11:00:00.000Z",
    until: "2026-10-09T18:00:00.000Z",
  };
  const decideAt = (time: string) =>
    decideFactory(
      {
        ...snapshot({
          issues: [issue(4, pausedLabels)],
          runs: [run(4, { ended: pausedRun })],
          settings: thresholds,
        }),
        now: time,
        holds: { "claude-code": hold },
      },
      registry,
    );
  assert.match(
    skipOf(decideAt(limit.until), 4)!,
    /^relaunch waits: claude-code hit its usage limit \(resets 12:50pm \(UTC\)\); usage is unknown, and its usage hold/,
  );
  assert.equal(launched(decideAt(hold.until)).length, 1);
});

// The owner's control of claude-code: its owner hold, set at 92%, and a
// reserve raise to 94%.
const ownerHold = { since: "2026-10-09T11:00:00.000Z", used: 92 };
const reserve = {
  drainThreshold: 94,
  since: "2026-10-09T11:30:00.000Z",
  until: "2026-10-09T15:00:00.000Z",
};

test("an owner hold holds its provider's new claims and retries through low and unknown usage, and nothing else", () => {
  for (const usage of [{ "claude-code": 10 }, { "claude-code": null }]) {
    const decisions = decide({
      issues: [
        issue(3, claimed),
        issue(4, claimed),
        issue(5, pausedLabels),
        issue(6),
        issue(7, ["ready-for-agent", "model:gpt-5.5"]),
      ],
      runs: [
        run(3, { ended: interrupted }),
        run(4, { ended: none }),
        run(5, {
          ended: {
            paused: { ...thresholdPause, until: "2026-10-09T11:45:00.000Z" },
            commented: true,
          },
        }),
      ],
      usage,
      owners: { "claude-code": { hold: ownerHold, reserve: null } },
      settings: thresholds,
    });
    // Running work and the paused run relaunch; other providers claim.
    assert.deepEqual(launched(decisions), [
      "acme/widgets#3",
      "acme/widgets#5",
      "acme/widgets#7",
    ]);
    const reason =
      "claude-code has an owner hold from 92% at 2026-10-09T11:00:00.000Z; only the owner's resume request lifts it";
    assert.equal(skipOf(decisions, 6), reason);
    assert.equal(skipOf(decisions, 4), `retry waits: ${reason}`);
  }
});

test("an owner hold never releases a paused run its usage still holds", () => {
  const decisions = decide({
    issues: [issue(5, pausedLabels)],
    runs: [run(5, { ended: { paused: thresholdPause, commented: true } })],
    usage: { "claude-code": 92 },
    owners: { "claude-code": { hold: ownerHold, reserve: null } },
    settings: thresholds,
  });
  assert.equal(
    skipOf(decisions, 5),
    `relaunch waits: claude-code reached its pause threshold (resets ${thresholdPause.reset}); usage 92% is at or above the 90% drain threshold`,
  );
});

test("a reserve raise lifts the drain threshold for new claims only, up to the raise", () => {
  const owners = { "claude-code": { hold: null, reserve } };
  const at = (used: number) =>
    decide({
      issues: [issue(4, claimed), issue(5, pausedLabels), issue(6)],
      runs: [
        run(4, { ended: none }),
        run(5, { ended: { paused: thresholdPause, commented: true } }),
      ],
      usage: { "claude-code": used },
      owners,
      settings: thresholds,
    });
  // At 92% the new claim and the retry launch, but the paused run still
  // waits for a reading below the configured drain threshold.
  const at92 = at(92);
  assert.deepEqual(launched(at92), ["acme/widgets#4", "acme/widgets#6"]);
  assert.match(
    skipOf(at92, 5)!,
    /usage 92% is at or above the 90% drain threshold$/,
  );
  const at94 = at(94);
  assert.deepEqual(launched(at94), []);
  assert.equal(
    skipOf(at94, 6),
    "claude-code usage 94% is at or above the 94% drain threshold, which the owner raised once from 90%",
  );
  // The pause threshold still stops running work.
  const running = decide({
    issues: [issue(4, claimed)],
    runs: [run(4)],
    usage: { "claude-code": 95 },
    owners,
    settings: thresholds,
  });
  assert.equal(running[0].kind, "stop");
});

test("a merge relaunch retains its attempt and model and uses a cap slot at the pause gate", () => {
  const mergeCandidate = {
    number: 40,
    headCommit: "a".repeat(40),
    baseBranch: "main",
    createdAt: now,
  };
  const ended = run(4, {
    provider: "codex",
    model: "gpt-5.5",
    effort: "medium",
    attempt: 2,
    ended: { timedOut: false, pullRequest: "open", mergeCandidate },
  });
  const input = {
    issues: [
      issue(4, ["factory:running", "model:claude-opus-5-5"]),
      issue(5, ["ready-for-agent", "model:codex/gpt-5.5"]),
    ],
    runs: [ended],
    usage: { codex: 85 },
    owners: { codex: { hold: { since: now, used: 85 }, reserve: null } },
    settings: {
      drainThreshold: 80,
      pauseThreshold: 95,
      caps: { codex: 1, "claude-code": 0 },
    },
  };
  assert.deepEqual(launches(decide(input)), [
    {
      kind: "launch",
      ...at(4),
      provider: "codex",
      model: "gpt-5.5",
      effort: "medium",
      attempt: 2,
      relaunch: true,
      mergeRelaunch: mergeCandidate,
    },
  ]);
  assert.deepEqual(launches(decide({ ...input, usage: { codex: 95 } })), []);
  assert.deepEqual(
    launches(
      decide({ ...input, runs: [ended, run(6, { provider: "codex" })] }),
    ),
    [],
  );
  for (const label of ["factory:needs-input", "factory:failed"])
    assert.deepEqual(
      launches(
        decide({ ...input, issues: [issue(4, ["factory:running", label])] }),
      ),
      [],
    );
  assert.deepEqual(
    launches(
      decide({
        ...input,
        repositories: [
          repository(widgets, input.issues, {
            paused: "invalid configuration",
          }),
        ],
      }),
    ),
    [],
  );
});

test("merge delivery respects skip and failed labels and unresolved models after interruption", () => {
  const mergeRelaunch = {
    number: 40,
    headCommit: "a".repeat(40),
    baseBranch: "main",
    createdAt: now,
  };
  for (const ending of ["ended", "interrupted", "paused"]) {
    const previous = run(4, {
      mergeRelaunch,
      ended:
        ending === "paused"
          ? {
              paused: {
                cause: "usage limit",
                reset: null,
                at: now,
                until: now,
              },
              commented: true,
            }
          : ending === "interrupted"
            ? { interrupted: true }
            : {
                timedOut: false,
                pullRequest: "open",
                mergeCandidate: mergeRelaunch,
              },
    });
    const repo = repository(widgets, [
      issue(4, ["factory:running", "owner:delivery"]),
    ]);
    repo.configuration.labels.skip = "owner:delivery";
    assert.deepEqual(
      launches(decide({ repositories: [repo], runs: [previous] })),
      [],
    );
    repo.issues[0].labels = ["factory:running", "factory:failed"];
    assert.deepEqual(
      launches(decide({ repositories: [repo], runs: [previous] })),
      [],
    );
    repo.issues[0].labels = ["factory:running"];
    assert.deepEqual(
      launches(
        decideFactory(snapshot({ repositories: [repo], runs: [previous] }), {
          ...registry,
          resolveModel: () => ({ error: "recorded model unavailable" }),
        }),
      ),
      [],
    );
  }
});

test("needs-input resumption and failed-label retry obey the existing pickup gates", () => {
  for (const inputResume of [
    undefined,
    {
      pullRequests: [
        {
          number: 40,
          headBranch: "factory/issue-4",
          state: "open" as const,
          createdAt: now,
        },
      ],
    },
  ]) {
    const claims: Claim[] = inputResume
      ? [{ issue: 4, pullRequest: "open", inputResume }]
      : [];
    const eligible = issue(4);
    assert.equal(
      launches(decide({ issues: [eligible], claims }))[0]?.attempt,
      1,
    );
    for (const held of [
      issue(4, ["ready-for-agent", "factory:failed"]),
      issue(4, ["ready-for-agent", "factory:needs-input"]),
      issue(4, []),
      issue(4, undefined, { blockedBy: [{ number: 2, state: "open" }] }),
      issue(4, undefined, {
        ready: {
          at: now,
          actor: { kind: "bot", login: "bot[bot]" },
        },
      }),
      issue(4, undefined, {
        contractHold: {
          reason: "readiness waits: revised contract",
          waiting: true,
        },
      }),
    ])
      assert.deepEqual(launches(decide({ issues: [held], claims })), []);
    assert.deepEqual(
      launches(
        decide({ issues: [eligible], claims, usage: { "claude-code": 80 } }),
      ),
      [],
    );
    assert.deepEqual(
      launches(
        decide({
          issues: [eligible],
          claims,
          settings: { caps: { "claude-code": 0, codex: 0 } },
        }),
      ),
      [],
    );
    const repo = repository(widgets, [eligible], {
      claims,
      paused: "configuration missing",
    });
    assert.deepEqual(launches(decide({ repositories: [repo] })), []);
    repo.paused = null;
    repo.configuration.labels.skip = "factory:skip";
    eligible.labels.push("factory:skip");
    assert.deepEqual(launches(decide({ repositories: [repo] })), []);
  }
});

test("a merged closing-reference PR completes runs and orphan claims without a replacement launch", () => {
  assert.equal(
    decide({
      issues: [issue(4)],
      runs: [
        run(4, {
          ended: { timedOut: false, pullRequest: "merged", closesIssue: true },
        }),
      ],
    })[0].kind,
    "complete",
  );
  const decisions = decide({
    issues: [issue(4)],
    claims: [{ issue: 4, pullRequest: "merged", closesIssue: true }],
  });
  assert.deepEqual(decisions, [{ kind: "complete", ...at(4) }]);
});

test("a failed needs-input continuation retains its PR context on the automatic retry", () => {
  const inputResume = {
    since: now,
    pullRequests: [
      {
        number: 40,
        headBranch: "factory/issue-4",
        state: "closed" as const,
        createdAt: now,
      },
    ],
  };
  const decisions = decide({
    issues: [issue(4, claimed)],
    runs: [
      run(4, {
        inputResume,
        ended: { timedOut: false, pullRequest: "closed" },
      }),
    ],
  });
  const retry = launches(decisions)[0];
  assert.equal(retry?.attempt, 2);
  assert.deepEqual(retry?.inputResume, inputResume);
});

test("actionable skips carry stable keys while blockers and transient roles stay log-only", () => {
  const cases: [Issue, Partial<Repository>, string | undefined][] = [
    [issue(1, undefined, { ready: null }), {}, "readiness"],
    [issue(1, undefined, { nativeParent: 2 }), {}, "parent-readiness"],
    [issue(1, ["ready-for-agent", "model:unknown"]), {}, "model-label"],
    [issue(1), { paused: "invalid configuration" }, "repository-configuration"],
    [
      issue(1, undefined, { blockedBy: [{ number: 3, state: "open" }] }),
      {},
      undefined,
    ],
    [
      issue(1, undefined, {
        ready: { at: now, actor: { kind: "unreadable", login: "owner" } },
      }),
      {},
      undefined,
    ],
    [
      issue(1, undefined, { nativeParent: 2 }),
      {
        issues: [
          issue(1, undefined, { nativeParent: 2 }),
          issue(2, undefined, {
            subIssues: [{ number: 1, state: "open" }],
            blockedBy: [{ number: 3, state: "open" }],
          }),
        ],
      },
      undefined,
    ],
  ];
  for (const [candidate, details, hold] of cases) {
    const parent = issue(2, [], { subIssues: [{ number: 1, state: "open" }] });
    const decisions = decide({
      repositories: [repository(widgets, [candidate, parent], details)],
    });
    const skipped = decisions.find(
      (decision) => decision.issue === 1 && decision.kind === "skip",
    );
    assert.ok(skipped?.kind === "skip");
    assert.equal(skipped.hold, hold, skipped.reason);
  }
});

test("unlisted labels hold pickup and retry without a fallback, and listed labels proceed", () => {
  const models = createRegistry(
    {
      "claude-code": { credential: "/unused" },
      codex: { credential: "/unused" },
    },
    fakePorts().ports,
    ["claude-sonnet-5-5", "claude-opus-5-5", "gpt-listed"],
  );
  for (const runs of [
    [],
    [run(1, { ended: { timedOut: false, pullRequest: "none" } })],
  ]) {
    for (const label of [
      "model:gpt-unlisted",
      "model:gpt-listed@low",
      "model:codex/gpt-listed@high",
    ]) {
      const decisions = decideFactory(
        snapshot({ issues: [issue(1, ["ready-for-agent", label])], runs }),
        models,
      );
      if (label === "model:gpt-unlisted") {
        assert.deepEqual(launches(decisions), []);
        assert.ok(
          decisions.some(
            (decision) =>
              decision.kind === "skip" && decision.hold === "model-label",
          ),
        );
      } else assert.equal(launches(decisions).length, 1);
    }
  }
});

test("interrupted, paused and merge relaunches hold a recorded model removed from the allowed list", () => {
  const models = createRegistry(
    { "claude-code": { credential: "/unused" } },
    fakePorts().ports,
    ["claude-opus-5-5"],
  );
  for (const ended of [
    { interrupted: true as const },
    {
      paused: {
        cause: "usage limit" as const,
        reset: null,
        at: now,
        until: now,
      },
      commented: true,
    },
    {
      timedOut: false,
      pullRequest: "open" as const,
      mergeCandidate: {
        number: 10,
        headCommit: "a".repeat(40),
        baseBranch: "main",
        createdAt: now,
      },
    },
  ]) {
    const decisions = decideFactory(
      snapshot({
        issues: [issue(1, ["ready-for-agent", "factory:running"])],
        runs: [run(1, { ended })],
        usage: { "claude-code": 0 },
        settings: { defaultModel: "claude-opus-5-5" },
      }),
      models,
    );
    assert.deepEqual(launches(decisions), []);
    assert.ok(
      decisions.some(
        (decision) =>
          decision.kind === "skip" && decision.hold === "model-label",
      ),
    );
  }
});

test("every relaunch holds an unlisted current label even when its recorded model is listed", () => {
  const models = createRegistry(
    {
      "claude-code": { credential: "/unused" },
      codex: { credential: "/unused" },
    },
    fakePorts().ports,
    ["claude-sonnet-5-5"],
  );
  for (const ended of [
    { interrupted: true as const },
    {
      paused: {
        cause: "usage limit" as const,
        reset: null,
        at: now,
        until: now,
      },
      commented: true,
    },
    {
      timedOut: false,
      pullRequest: "open" as const,
      mergeCandidate: {
        number: 10,
        headCommit: "b".repeat(40),
        baseBranch: "main",
        createdAt: now,
      },
    },
  ]) {
    const decisions = decideFactory(
      snapshot({
        issues: [
          issue(1, [
            "ready-for-agent",
            "factory:running",
            "model:codex/gpt-unlisted",
          ]),
        ],
        runs: [run(1, { ended })],
        usage: { "claude-code": 0 },
      }),
      models,
    );
    assert.deepEqual(launches(decisions), []);
    assert.ok(
      decisions.some(
        (decision) =>
          decision.kind === "skip" && decision.hold === "model-label",
      ),
    );
  }
});

test("a pending pause notice is delivered before the removed-model relaunch hold", () => {
  const models = createRegistry(
    { "claude-code": { credential: "/unused" } },
    fakePorts().ports,
    ["claude-opus-5-5"],
  );
  const paused = {
    paused: { cause: "usage limit" as const, reset: null, at: now, until: now },
    commented: false,
  };
  const input = snapshot({
    issues: [issue(1, ["ready-for-agent", "factory:running"])],
    runs: [run(1, { ended: paused })],
    settings: { defaultModel: "claude-opus-5-5" },
  });
  assert.deepEqual(decideFactory(input, models), [
    { kind: "pause", ...at(1), pause: paused.paused },
  ]);
  paused.commented = true;
  const decisions = decideFactory(input, models);
  assert.deepEqual(launches(decisions), []);
  assert.ok(
    decisions.some(
      (decision) => decision.kind === "skip" && decision.hold === "model-label",
    ),
  );
});

test("relaunch model and configuration reasons remain independently actionable under state labels", () => {
  const models = createRegistry(
    {
      "claude-code": { credential: "/unused" },
      codex: { credential: "/unused" },
    },
    fakePorts().ports,
    ["claude-sonnet-5-5"],
  );
  for (const ended of [
    { interrupted: true as const },
    {
      paused: {
        cause: "usage limit" as const,
        reset: null,
        at: now,
        until: now,
      },
      commented: true,
    },
    {
      timedOut: false,
      pullRequest: "open" as const,
      mergeCandidate: {
        number: 10,
        headCommit: "c".repeat(40),
        baseBranch: "main",
        createdAt: now,
      },
    },
  ]) {
    const candidate = issue(1, ["factory:running", "model:gpt-unlisted"]);
    const repo = repository(widgets, [candidate], {
      paused: "invalid configuration",
    });
    const input = snapshot({ repositories: [repo], runs: [run(1, { ended })] });
    const held = () =>
      decideFactory(input, models)
        .flatMap((decision) =>
          decision.kind === "skip" && decision.hold ? [decision.hold] : [],
        )
        .sort();
    assert.deepEqual(held(), ["model-label", "repository-configuration"]);
    candidate.labels = ["factory:running"];
    assert.deepEqual(held(), ["repository-configuration"]);
    assert.deepEqual(launches(decideFactory(input, models)), []);
  }
});

test("pending automatic and orphan retries retain all model and configuration holds", () => {
  const models = createRegistry(
    {
      "claude-code": { credential: "/unused" },
      codex: { credential: "/unused" },
    },
    fakePorts().ports,
    ["claude-sonnet-5-5", "claude-opus-5-5"],
  );
  for (const orphan of [false, true]) {
    const candidate = issue(1, [
      "ready-for-agent",
      "factory:running",
      "model:gpt-unlisted",
    ]);
    const repo = repository(widgets, [candidate], {
      paused: "invalid configuration",
      ...(orphan ? { claims: [{ issue: 1, pullRequest: "none" }] } : {}),
    });
    const input = snapshot({
      repositories: [repo],
      runs: orphan
        ? []
        : [run(1, { ended: { timedOut: false, pullRequest: "none" } })],
    });
    const held = () =>
      decideFactory(input, models)
        .flatMap((decision) =>
          decision.kind === "skip" && decision.hold ? [decision.hold] : [],
        )
        .sort();
    assert.deepEqual(held(), ["model-label", "repository-configuration"]);
    candidate.labels = ["ready-for-agent", "factory:running"];
    assert.deepEqual(held(), ["repository-configuration"]);
    assert.deepEqual(launches(decideFactory(input, models)), []);
  }
});

test("release holds gate only merge relaunches in their own repository and exclude the PR itself", () => {
  const target = {
    number: 40,
    headCommit: "a".repeat(40),
    baseBranch: "main",
    createdAt: now,
  };
  for (const hold of [[80, 81], null, [40], []]) {
    const repo = repository(widgets, [issue(4, claimed)], {
      releaseHold: hold,
      claims: [{ issue: 4, pullRequest: "open", mergeCandidate: target }],
    });
    const decisions = decide({
      repositories: [
        repo,
        repository("acme/gadgets", [issue(5)]),
        repository("acme/other", [issue(6, claimed)], {
          claims: [{ issue: 6, pullRequest: "open", mergeCandidate: target }],
        }),
      ],
    });
    assert.equal(
      launches(decisions).some((d) => d.issue === 4),
      hold !== null && !hold.some((n) => n !== 40),
    );
    assert.ok(launches(decisions).some((d) => d.issue === 5));
    assert.ok(launches(decisions).some((d) => d.issue === 6));
    if (hold === null || hold.includes(80))
      assert.match(skipOf(decisions, 4)!, /^relaunch waits: release hold/);
  }
});

test("a release hold permits pickup, retries, interrupted and paused relaunches and needs-input resumes", () => {
  const target = {
    number: 40,
    headCommit: "a".repeat(40),
    baseBranch: "main",
    createdAt: now,
  };
  const scenarios: { runs?: Run[]; claims?: Claim[]; labels?: string[] }[] = [
    {},
    { runs: [run(4, { ended: none })], labels: claimed },
    {
      runs: [run(4, { ended: { interrupted: true }, mergeRelaunch: target })],
      labels: claimed,
    },
    {
      runs: [
        run(4, {
          ended: {
            paused: {
              cause: "usage limit",
              reset: null,
              at: "2026-10-08T00:00:00Z",
              until: "2026-10-08T01:00:00Z",
            },
            commented: true,
          },
        }),
      ],
      labels: ["factory:paused"],
    },
    {
      claims: [
        { issue: 4, pullRequest: "open", inputResume: { pullRequests: [] } },
      ],
    },
  ];
  for (const scenario of scenarios) {
    const repo = repository(widgets, [issue(4, scenario.labels)], {
      releaseHold: [80],
      claims: scenario.claims ?? [],
    });
    assert.equal(
      launches(decide({ repositories: [repo], runs: scenario.runs })).length,
      1,
    );
  }
});

// A repository whose configuration names the factory hold label.
function holdingRepository(
  name: string,
  issues: Issue[],
  details: Partial<Repository> = {},
): Repository {
  const repo = repository(name, issues, details);
  repo.configuration.labels.hold = "factory:hold";
  return repo;
}

const holdsOf = (decisions: Decision[], number: number) =>
  decisions
    .flatMap((decision) =>
      decision.kind === "skip" && decision.issue === number && decision.hold
        ? [decision.hold]
        : [],
    )
    .sort();

test("a factory hold stops pickup, retries, interrupted and paused relaunches, needs-input resumes and merge relaunches in its own repository", () => {
  const target = {
    number: 40,
    headCommit: "a".repeat(40),
    baseBranch: "main",
    createdAt: now,
  };
  const scenarios: { runs?: Run[]; claims?: Claim[]; labels?: string[] }[] = [
    {},
    { runs: [run(4, { ended: none })], labels: claimed },
    { runs: [run(4, { ended: { interrupted: true } })], labels: claimed },
    {
      runs: [run(4, { ended: { interrupted: true }, mergeRelaunch: target })],
      labels: claimed,
    },
    {
      runs: [
        run(4, {
          ended: {
            paused: {
              cause: "usage limit",
              reset: null,
              at: "2026-10-08T00:00:00Z",
              until: "2026-10-08T01:00:00Z",
            },
            commented: true,
          },
        }),
      ],
      labels: ["factory:paused"],
    },
    {
      claims: [
        { issue: 4, pullRequest: "open", inputResume: { pullRequests: [] } },
      ],
    },
    {
      claims: [{ issue: 4, pullRequest: "open", mergeCandidate: target }],
      labels: claimed,
    },
  ];
  for (const scenario of scenarios)
    for (const hold of [[12], [12, 40], null]) {
      const repo = holdingRepository(widgets, [issue(4, scenario.labels)], {
        factoryHold: hold,
        claims: scenario.claims ?? [],
      });
      const decisions = decide({
        repositories: [repo, repository(gadgets, [issue(5)])],
        runs: scenario.runs,
      });
      assert.deepEqual(
        launches(decisions).map((d) => d.repository),
        [gadgets],
        JSON.stringify({ scenario, hold }),
      );
      assert.deepEqual(holdsOf(decisions, 4), ["factory-hold"]);
      assert.match(
        skipOf(decisions, 4)!,
        hold === null
          ? /factory hold state is unreadable; pickup and merging resume after a successful read confirms no open issue or PR carries `factory:hold`/
          : /factory hold \(#12(, #40 carry|\s+carries) `factory:hold`\); pickup and merging resume when the last labelled issue or PR closes or loses the label/,
      );
      // Clearing the hold resumes the same launch on the next pass.
      repo.factoryHold = [];
      assert.equal(
        launches(decide({ repositories: [repo], runs: scenario.runs })).length,
        1,
        JSON.stringify(scenario),
      );
    }
});

test("a merge relaunch whose target PR alone carries the factory hold launches", () => {
  const target = {
    number: 40,
    headCommit: "a".repeat(40),
    baseBranch: "main",
    createdAt: now,
  };
  for (const [hold, launched] of [
    [[40], true],
    [[], true],
    [[4, 40], false],
    [[40, 41], false],
    [null, false],
  ] as const)
    for (const runs of [
      [] as Run[],
      [run(4, { ended: { interrupted: true }, mergeRelaunch: target })],
    ]) {
      const repo = holdingRepository(widgets, [issue(4, claimed), issue(6)], {
        factoryHold: hold === null ? null : [...hold],
        claims: runs.length
          ? []
          : [{ issue: 4, pullRequest: "open", mergeCandidate: target }],
      });
      const decisions = decide({ repositories: [repo], runs });
      assert.equal(
        launches(decisions).some((d) => d.issue === 4),
        launched,
        JSON.stringify({ hold, runs: runs.length }),
      );
      assert.deepEqual(holdsOf(decisions, 4), launched ? [] : ["factory-hold"]);
      // Pickup stays held while any item carries the label, including the
      // merging PR itself.
      assert.equal(
        launches(decisions).some((d) => d.issue === 6),
        hold !== null && hold.length === 0,
      );
      if (!launched)
        assert.doesNotMatch(skipOf(decisions, 4)!, /#40(?!\d)(?!, #41)/);
    }
});

test("a factory hold lets existing runs settle and stop, and other gates keep their own holds", () => {
  const decisions = decide({
    repositories: [
      holdingRepository(
        widgets,
        [issue(2, claimed), issue(3, ["ready-for-agent", "model:unknown"])],
        { factoryHold: [9] },
      ),
    ],
    runs: [
      run(1, { ended: { timedOut: false, pullRequest: "merged" } }),
      run(2, { startedAt: "2026-10-09T00:00:00Z" }),
    ],
    settings: { timeLimitMinutes: 60 },
  });
  assert.deepEqual(
    decisions
      .filter((d) => d.kind !== "skip")
      .map((d) => `${d.kind}:${d.issue}`)
      .sort(),
    ["release:1", "stop:2"],
  );
  assert.deepEqual(launches(decisions), []);
  assert.deepEqual(holdsOf(decisions, 3), ["factory-hold", "model-label"]);
});

test("a merge relaunch blocked by another gate gets no factory-hold reason from its own label", () => {
  const target = {
    number: 40,
    headCommit: "a".repeat(40),
    baseBranch: "main",
    createdAt: now,
  };
  const repo = holdingRepository(widgets, [issue(4, claimed)], {
    factoryHold: [40],
    claims: [{ issue: 4, pullRequest: "open", mergeCandidate: target }],
  });
  const decisions = decide({
    repositories: [repo],
    settings: { caps: { "claude-code": 0, codex: 0 } },
  });
  assert.deepEqual(launches(decisions), []);
  assert.match(skipOf(decisions, 4)!, /cap of 0/);
  assert.deepEqual(holdsOf(decisions, 4), []);
});

test("a factory hold read without a configured label holds nothing", () => {
  const repo = repository(widgets, [issue(4)], { factoryHold: null });
  assert.equal(launches(decide({ repositories: [repo] })).length, 1);
});

test("the factory hold exempts exactly the PRs being merged, and holds nothing without a label", () => {
  assert.match(
    factoryHoldReason("factory:hold", [9, 40, 41], [40, 41])!,
    /^factory hold \(#9 carries `factory:hold`\)/,
  );
  assert.equal(factoryHoldReason("factory:hold", [40, 41], [40, 41]), null);
  assert.match(
    factoryHoldReason("factory:hold", null, [40])!,
    /^factory hold state is unreadable/,
  );
  assert.equal(factoryHoldReason(undefined, null, []), null);
});
