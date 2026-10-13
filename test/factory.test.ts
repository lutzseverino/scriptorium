import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideFactory,
  type Claim,
  type Decision,
  type Issue,
  type Repository,
  type Run,
  type Settings,
  type Snapshot,
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
    nativeParent: null,
    latestLink: null,
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
      version: 1,
      labels: {
        ready: "ready-for-agent",
        running: "factory:running",
        failed: "factory:failed",
        needsInput: "factory:needs-input",
      },
      modelLabelPrefix: "model:",
      prompt: "{skillPrefix}implement #{issue}",
    },
    paused: null,
    issues,
    claims: [],
    ...details,
  };
}

// A snapshot of one repository, acme/widgets, unless `repositories` names
// several.
function snapshot({
  issues = [],
  runs = [],
  claims = [],
  repositories,
  usage = {},
  settings = {},
}: {
  issues?: Issue[];
  runs?: Run[];
  claims?: Claim[];
  repositories?: Repository[];
  usage?: Snapshot["usage"];
  settings?: Partial<Settings>;
} = {}): Snapshot {
  return {
    now,
    repositories: repositories ?? [repository(widgets, issues, { claims })],
    runs,
    usage,
    settings: {
      defaultModel: "claude-sonnet-5-5",
      retryModel: "claude-opus-5-5@xhigh",
      caps: { "claude-code": 3, codex: 2 },
      usageThreshold: 80,
      timeLimitMinutes: 240,
      authorizedRoles: ["admin", "maintain"],
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

test("claimed, failed and blocked issues are skipped with their reasons", () => {
  const decisions = decide({
    issues: [
      issue(4, claimed),
      issue(5, ["ready-for-agent", "factory:failed"]),
      issue(6, ["ready-for-agent"], {
        blockedBy: [
          { number: 2, state: "open" },
          { number: 3, state: "closed" },
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
  assert.equal(skipOf(decisions, 6), "blocked by #2");
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
  for (const role of ["write", "triage", "read", "none", "custom-reviewer"]) {
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
    settings: { authorizedRoles: ["triage"] },
  });
  assert.deepEqual(launched(widened), ["acme/widgets#4"]);
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
    issues: [issue(4, undefined, readyBy({ ...owner, role: null }))],
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

test("readiness must be strictly newer than the body's last edit", () => {
  const readyAt = "2026-10-09T10:00:00Z";
  for (const editedAt of ["2026-10-09T10:00:01Z", readyAt]) {
    const decisions = decide({
      issues: [issue(4, undefined, { ...readyBy(owner, readyAt), editedAt })],
    });
    assert.deepEqual(launches(decisions), [], `edited at ${editedAt}`);
    assert.equal(
      skipOf(decisions, 4),
      `its readiness is refused: ready-for-agent was applied at ${readyAt}, not after the body's last edit at ${editedAt}; review the edit, then remove and re-apply ready-for-agent`,
    );
  }
  for (const editedAt of ["2026-10-09T09:59:59Z", null])
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
      readyBy({ ...owner, role: null }, released),
      "waits: the repository role of @owner, who applied ready-for-agent, could not be read this pass",
    ],
  ] as const) {
    const decisions = decide({
      issues: [parent(released, { ...finished, ...details })],
    });
    assert.deepEqual(
      decisions,
      [{ kind: "skip", ...at(3), reason: `its readiness ${reason}` }],
      reason,
    );
  }
});

test("closing any ready parent does not require pickup gates", () => {
  assert.deepEqual(
    decide({
      issues: [
        issue(3, ["ready-for-agent", "model:unusable"], {
          latestLink: { ticket: 5, at: released },
          subIssues: [{ number: 5, state: "closed" }],
          blockedBy: [{ number: 2, state: "open" }],
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
      readyBy({ ...owner, role: null }, released),
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
    "claude-code usage 80% is at or above the 80% threshold",
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
    },
    {
      kind: "skip",
      ...at(2, gadgets),
      reason:
        "retry waits: acme/gadgets is paused: it has no .factory/Dockerfile",
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
    for (const pullRequest of ["none", "closed", "merged-issue-open"] as const)
      test(`attempt ${attempt} needing input releases its claim with ${pullRequest} pull request, timed out: ${timedOut}`, () => {
        assert.deepEqual(
          decide({
            issues: [issue(4, [...claimed, "factory:needs-input"])],
            runs: [run(4, { attempt, ended: { timedOut, pullRequest } })],
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

test("an ended run's open pull request keeps its claim with or without a needs-input label", () => {
  for (const attempt of [1, 2] as const)
    for (const timedOut of [false, true])
      for (const needsInput of [false, true]) {
        const decisions = decide({
          issues: [
            issue(
              4,
              needsInput ? [...claimed, "factory:needs-input"] : claimed,
            ),
          ],
          runs: [run(4, { attempt, ended: { timedOut, pullRequest: "open" } })],
        });
        assert.deepEqual(decisions[0], { kind: "keep", ...at(4) });
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
      "retry waits: claude-code usage 95% is at or above the 80% threshold",
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
      { kind: "release", ...at(5) },
      { kind: "skip", ...at(4), reason: "claimed by a running factory run" },
    ],
  );
});

test("a needs-input claim left by an earlier factory process releases unless its pull request is open", () => {
  for (const pullRequest of [
    "none",
    "closed",
    "merged-issue-open",
    "open",
  ] as const)
    assert.deepEqual(
      decide({
        issues: [issue(4, [...claimed, "factory:needs-input"])],
        claims: [{ issue: 4, pullRequest }],
      }).filter(({ kind }) => kind !== "skip"),
      pullRequest === "open" ? [] : [{ kind: "release", ...at(4) }],
    );
});

test("a claim that neither a run nor an open pull request holds fails its issue", () => {
  const decisions = decide({
    issues: [issue(6, claimed), issue(7, claimed)],
    claims: [
      { issue: 6, pullRequest: "closed" },
      { issue: 7, pullRequest: "none" },
    ],
  });
  assert.deepEqual(decisions.slice(0, 2), [
    {
      kind: "fail",
      ...at(6),
      failure: "its pull request closed without merging",
      log: null,
    },
    {
      kind: "fail",
      ...at(7),
      failure: "no factory run or open pull request holds its claim",
      log: null,
    },
  ]);
});

test("a pull request that merged without closing its issue fails it without a retry", () => {
  const failure =
    "its pull request merged without closing the issue; close the issue if that finished it";
  const fromRun = decide({
    issues: [issue(4, claimed)],
    runs: [
      run(4, { ended: { timedOut: false, pullRequest: "merged-issue-open" } }),
    ],
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
    claims: [{ issue: 6, pullRequest: "merged-issue-open" }],
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
      {
        kind: "fail",
        issue: 9,
        failure: `${failed}, and its retry did not launch: its issue is no longer open`,
      },
    ],
  );
});

test("a retry fails once its body was edited after its readiness", () => {
  const editedAt = "2026-10-09T11:30:00Z";
  assert.deepEqual(
    decide({
      issues: [issue(4, claimed, { editedAt })],
      runs: [run(4, { ended: none })],
    }),
    [
      {
        kind: "fail",
        ...at(4),
        failure: `the run ended without an open pull request, and its retry did not launch: its readiness is refused: ready-for-agent was applied at 2026-10-04T00:00:00Z, not after the body's last edit at ${editedAt}; review the edit, then remove and re-apply ready-for-agent`,
        log: log(4),
      },
    ],
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

test("timeouts ignore unpushable changes and keep their retry", () => {
  const ended = {
    timedOut: true,
    pullRequest: "none" as const,
    unpushedChanges: [".github/workflows/ci.yml"],
  };
  const [retry] = decide({
    issues: [issue(4, claimed)],
    runs: [run(4, { ended })],
  });
  assert.equal(retry.kind === "launch" && retry.attempt, 2);
  const [failure] = decide({ runs: [run(4, { attempt: 2, ended })] });
  assert.equal(
    failure.kind === "fail" && failure.failure,
    "the run exceeded the time limit of 240 minutes",
  );
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
            version: 1,
            labels: {
              ready: "queued",
              running: "working",
              failed: "broken",
              needsInput: "question",
            },
            modelLabelPrefix: "agent:",
            prompt: "{skillPrefix}ship #{issue}",
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
