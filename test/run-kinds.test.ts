import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideFactory,
  type Claim,
  type Decision,
  type Issue,
  type Models,
  type Repository,
  type Run,
  type Continuation,
  type Settings,
  type Snapshot,
} from "../src/factory.ts";
import type { FactoryConfiguration } from "../src/factory-configuration.ts";
import { holdKeys } from "../src/hold-comments.ts";
import type { ModelPolicy } from "../src/model-policy.ts";
import type { MergeRelaunch } from "../src/platform.ts";
import type { Actor } from "../src/readiness.ts";

// Run kinds through the decision core, on a version 3 configuration and a
// host whose capabilities are placeholder providers and models.
const now = "2026-10-09T12:00:00Z";
const widgets = "acme/widgets";
const owner: Actor = { kind: "user", login: "owner", role: "admin" };

const capabilities = [
  "provider-a/model-impl",
  "provider-a/model-review",
  "provider-a/model-host",
  "provider-a/model-triage",
  "provider-b/model-host",
  "provider-b/model-retry",
  "provider-b/model-label",
];

// The host's resolver over those capabilities; a model outside them is an
// error, as an unconfigured provider or a model outside `models.allowed` is.
const models: Models = {
  resolveModel(value) {
    const [name, effort = "medium"] = value.split("@");
    if (!capabilities.includes(name))
      return { error: `model ${name} is outside this host's capabilities` };
    const [provider, model] = name.split("/");
    return { provider, model, effort };
  },
  resolveModelLabel(prefix, label) {
    return models.resolveModel(label.slice(prefix.length));
  },
};

const labels = {
  triage: "state:triage",
  reporter: "state:reporter",
  grill: "state:grill",
  owner: "state:owner",
  ready: "state:ready",
  ownerReview: "gate:owner-review",
  majorRelease: "gate:major-release",
  running: "factory:running",
  paused: "factory:paused",
  failed: "factory:failed",
  skip: "factory:skip",
  hold: "factory:hold",
  releaseHold: "factory:release-hold",
};

type Kinds = {
  triage?: boolean;
  review?: boolean;
  differentProvider?: boolean;
};

function configuration({
  triage = true,
  review = true,
  differentProvider,
}: Kinds = {}): FactoryConfiguration {
  return {
    version: 3,
    labels,
    contractResult: {
      marker: "repo-canon:issue-contract-state",
      author: "github-actions[bot]",
    },
    modelLabelPrefix: "model:",
    runKinds: {
      implement: { skill: "implement", arguments: "#{issue}" },
      ...(triage && { triage: { skill: "triage", arguments: "#{issue}" } }),
      ...(review && {
        review: {
          skill: "review",
          arguments: "#{pullRequest}",
          ...(differentProvider !== undefined && { differentProvider }),
        },
      }),
    },
  };
}

function issue(
  number: number,
  issueLabels: string[] = [labels.ready],
  details: Partial<Issue> = {},
): Issue {
  const createdAt = `2026-10-0${number}T00:00:00Z`;
  return {
    number,
    createdAt,
    labels: issueLabels,
    ready: issueLabels.includes(labels.ready)
      ? { at: createdAt, actor: owner }
      : null,
    triage: issueLabels.includes(labels.triage)
      ? { at: createdAt, actor: owner }
      : null,
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

const pr: MergeRelaunch = {
  number: 42,
  headCommit: "a".repeat(40),
  baseBranch: "main",
  createdAt: "2026-10-09T11:30:00Z",
};

function run(
  details: Partial<Omit<Run, "continuation">> & {
    continuation?: Partial<Continuation>;
  } = {},
): Run {
  const { continuation, ...rest } = details;
  return {
    repository: widgets,
    issue: 4,
    provider: "provider-a",
    model: "model-impl",
    effort: "medium",
    continuation: { attempt: 1, ...continuation },
    startedAt: "2026-10-09T11:00:00Z",
    log: "/srv/factory/logs/issue-4-attempt-1.log",
    ended: null,
    ...rest,
  };
}

// An ended run whose one open PR is `pr`, still a draft when `draft`.
function ended(
  details: Partial<Omit<Run, "continuation">> & {
    continuation?: Partial<Continuation>;
  } = {},
  draft = false,
): Run {
  return run({
    ended: {
      timedOut: false,
      pullRequest: "open",
      openPullRequest: { ...pr, ...(draft && { draft: true as const }) },
    },
    ...details,
  });
}

function decide({
  issues = [issue(4)],
  runs = [],
  claims = [],
  kinds,
  policy,
  settings = {},
  details = {},
  repositories,
  usage = {},
}: {
  issues?: Issue[];
  runs?: Run[];
  claims?: Claim[];
  kinds?: Kinds;
  policy?: ModelPolicy;
  settings?: Partial<Settings>;
  details?: Partial<Repository>;
  repositories?: Repository[];
  usage?: Snapshot["usage"];
} = {}): Decision[] {
  const snapshot: Snapshot = {
    now,
    repositories: repositories ?? [
      {
        name: widgets,
        configuration: configuration(kinds),
        authorization: { authorizedRoles: ["admin"], neverAuthorize: [] },
        paused: null,
        issues,
        claims,
        modelPolicy: policy ?? null,
        ...details,
      },
    ],
    runs,
    usage,
    holds: {},
    owners: {},
    settings: {
      defaultModel: "provider-a/model-impl",
      retryModel: "provider-b/model-retry",
      caps: { "provider-a": 2, "provider-b": 2 },
      drainThreshold: 80,
      pauseThreshold: null,
      timeLimitMinutes: 240,
      ...settings,
    },
  };
  return decideFactory(snapshot, models);
}

const at = { repository: widgets, issue: 4 };

function launchOf(decisions: Decision[]) {
  const launch = decisions.find((decision) => decision.kind === "launch");
  return launch?.kind === "launch" ? launch : undefined;
}

function skipOf(decisions: Decision[]) {
  const skip = decisions.find((decision) => decision.kind === "skip");
  return skip?.kind === "skip" ? skip : undefined;
}

// A version 3 issue's labels while a run holds it.
const claimed = [labels.ready, labels.running];

// Custom names prove pickup reads roles from each repository's configuration.
const priorityLabels = {
  ...labels,
  priorityHigh: "urgent",
  priorityNormal: "ordinary",
  priorityLow: "later",
};
const priorityConfiguration: FactoryConfiguration = {
  ...configuration(),
  labels: priorityLabels,
};
const launchedIssues = (decisions: Decision[]) =>
  decisions
    .filter((decision) => decision.kind === "launch")
    .map(({ repository, issue }) => `${repository}#${issue}`);

test("pickup orders high, normal and unlabelled, then low before issue age", () => {
  assert.deepEqual(
    launchedIssues(
      decide({
        issues: [
          issue(1, [labels.ready, "later"]),
          issue(2),
          issue(3, [labels.ready, "ordinary"]),
          issue(4, [labels.ready, "urgent"]),
        ],
        details: { configuration: priorityConfiguration },
        settings: { caps: { "provider-a": 4 } },
      }),
    ),
    [widgets + "#4", widgets + "#2", widgets + "#3", widgets + "#1"],
  );
});

test("priority takes the available cap slot without bypassing issue gates", () => {
  const decisions = decide({
    issues: [
      issue(1, [labels.ready, "later"]),
      issue(2),
      issue(3, [labels.ready, "urgent"], {
        blockedBy: [{ number: 1, state: "open" }],
      }),
      issue(4, ["urgent"]),
      issue(5, [labels.ready, "urgent"], { ready: null }),
      issue(6, [labels.ready, labels.skip, "urgent"]),
      issue(7, [labels.ready, "urgent"]),
    ],
    details: { configuration: priorityConfiguration },
    settings: { caps: { "provider-a": 1 } },
  });
  assert.deepEqual(launchedIssues(decisions), [widgets + "#7"]);
});

test("priority does not bypass repository or provider holds", () => {
  for (const details of [
    { paused: "repository configuration is unreadable" },
    { factoryHold: [42] },
  ]) {
    assert.deepEqual(
      launchedIssues(
        decide({
          issues: [issue(4, [labels.ready, "urgent"])],
          details: { configuration: priorityConfiguration, ...details },
        }),
      ),
      [],
    );
  }
  assert.deepEqual(
    launchedIssues(
      decide({
        issues: [issue(4, [labels.ready, "urgent"])],
        details: { configuration: priorityConfiguration },
        usage: { "provider-a": { used: 80, at: now } },
      }),
    ),
    [],
  );
});

test("priority is configured per repository and preserves age, repository and number ties", () => {
  const base: Repository = {
    name: widgets,
    configuration: priorityConfiguration,
    authorization: { authorizedRoles: ["admin"], neverAuthorize: [] },
    paused: null,
    issues: [],
    claims: [],
  };
  const sameAge = { createdAt: "2026-10-01T00:00:00Z" };
  assert.deepEqual(
    launchedIssues(
      decide({
        repositories: [
          {
            ...base,
            issues: [
              issue(2, [labels.ready, "urgent"], sameAge),
              issue(1, [labels.ready, "urgent"], sameAge),
              issue(3, [labels.ready, "urgent"], {
                createdAt: "2026-09-30T00:00:00Z",
              }),
              issue(4),
            ],
          },
          {
            ...base,
            name: "acme/gadgets",
            configuration: {
              ...configuration(),
              labels: { ...labels, priorityHigh: "important" },
            },
            issues: [
              issue(5, [labels.ready, "important"], sameAge),
              issue(6, [labels.ready, "urgent"], sameAge),
            ],
          },
        ],
        settings: { caps: { "provider-a": 6 } },
      }),
    ),
    [
      "acme/widgets#3",
      "acme/gadgets#5",
      "acme/widgets#1",
      "acme/widgets#2",
      "acme/gadgets#6",
      "acme/widgets#4",
    ],
  );
});

test("a person's triage label starts a claimed triage run on the host's triage default", () => {
  assert.deepEqual(
    decide({
      issues: [issue(4, [labels.triage])],
      settings: { triageModel: "provider-a/model-triage" },
    }),
    [
      { kind: "claim", ...at },
      {
        kind: "launch",
        ...at,
        continuation: {
          runKind: "triage",
          attempt: 1,
          trigger: {
            id: "label:2026-10-04T00:00:00Z",
            at: "2026-10-04T00:00:00Z",
          },
        },
        provider: "provider-a",
        model: "model-triage",
        effort: "medium",
        selection: "host-default",
      },
    ],
  );
  // Without a triage default, triage takes the host's default model.
  assert.equal(
    launchOf(decide({ issues: [issue(4, [labels.triage])] }))?.model,
    "model-impl",
  );
});

test("a triage label from a bot, or an untraceable one, never starts triage", () => {
  for (const triage of [
    { at: now, actor: { kind: "bot", login: "github-actions[bot]" } as Actor },
    null,
  ]) {
    const decisions = decide({
      issues: [issue(4, [labels.triage], { triage })],
    });
    assert.equal(launchOf(decisions), undefined);
    assert.match(
      skipOf(decisions)!.reason,
      /^triage waits: is refused|^triage waits: no event applying state:triage/,
    );
  }
});

test("without triage, a triage-labelled issue waits for a person's readiness", () => {
  assert.deepEqual(
    decide({ issues: [issue(4, [labels.triage])], kinds: { triage: false } }),
    [],
  );
});

test("a triage run releases its claim once its issue leaves triage, and fails if it never does", () => {
  const triage = run({
    continuation: { runKind: "triage" },
    ended: { timedOut: false, pullRequest: "none" },
  });
  assert.deepEqual(
    decide({
      issues: [issue(4, [labels.ready, labels.running])],
      runs: [triage],
    })[0],
    { kind: "release", ...at },
  );
  assert.deepEqual(
    decide({
      issues: [issue(4, [labels.grill, labels.running])],
      runs: [triage],
    }),
    [{ kind: "release", ...at }],
  );
  assert.deepEqual(
    decide({
      issues: [issue(4, [labels.triage, labels.running])],
      runs: [triage],
    })[0],
    {
      kind: "fail",
      ...at,
      failure:
        "the triage run ended with the issue still labelled state:triage",
      log: triage.log,
    },
  );
});

test("accepted readiness starts implement", () => {
  const launch = launchOf(decide());
  assert.equal(launch?.continuation.runKind, undefined);
  assert.equal(launch?.continuation.attempt, 1);
  assert.equal(launch?.selection, "host-default");
});

test("an implement run ending with a draft PR starts review on that PR, quietly keeping the claim", () => {
  assert.deepEqual(
    decide({
      issues: [issue(4, claimed)],
      runs: [ended({}, true)],
      settings: { reviewModel: "provider-b/model-host" },
    }),
    [
      { kind: "keep", ...at, quiet: true },
      {
        kind: "launch",
        ...at,
        continuation: {
          runKind: "review",
          attempt: 1,
          target: pr,
          handBacks: 0,
          implementedBy: "provider-a",
        },
        provider: "provider-b",
        model: "model-host",
        effort: "medium",
        selection: "host-default",
      },
    ],
  );
});

test("a review left a draft hands back to implement on the same PR, at most twice", () => {
  const review = (handBacks: number) =>
    ended(
      {
        continuation: { runKind: "review", handBacks },
        provider: "provider-b",
      },
      true,
    );
  for (const handBacks of [0, 1]) {
    const decisions = decide({
      issues: [issue(4, claimed)],
      runs: [review(handBacks)],
    });
    assert.deepEqual(decisions[0], { kind: "keep", ...at, quiet: true });
    const launch = launchOf(decisions)!;
    assert.equal(launch.continuation.runKind, undefined);
    assert.deepEqual(launch.continuation.target, pr);
    assert.equal(launch.continuation.handBacks, handBacks + 1);
    assert.equal(launch.continuation.attempt, 1);
  }
  const exhausted = review(2);
  assert.deepEqual(decide({ issues: [issue(4, claimed)], runs: [exhausted] }), [
    {
      kind: "fail",
      ...at,
      failure: "its review rounds did not converge after 2 hand-backs",
      log: exhausted.log,
    },
  ]);
  // The hand-back's implement run, ending on that PR, starts the next round.
  const next = launchOf(
    decide({
      issues: [issue(4, claimed)],
      runs: [ended({ continuation: { handBacks: 1, target: pr } })],
    }),
  )!;
  assert.equal(next.continuation.runKind, "review");
  assert.equal(next.continuation.handBacks, 1);
});

test("a review whose PR is ready awaits merge like a run without review", () => {
  const decisions = decide({
    issues: [issue(4, claimed)],
    runs: [
      ended({ continuation: { runKind: "review" }, provider: "provider-b" }),
    ],
  });
  assert.deepEqual(decisions[0], { kind: "keep", ...at });
  assert.equal(launchOf(decisions), undefined);
});

test("a run ending in a state stop leaves its issue there", () => {
  for (const stop of [labels.grill, labels.owner, labels.reporter]) {
    for (const runKind of [undefined, "review"] as const) {
      const decisions = decide({
        issues: [issue(4, [stop, labels.running])],
        runs: [ended({ continuation: { ...(runKind && { runKind }) } })],
      });
      assert.deepEqual(decisions, [{ kind: "release", ...at }], stop);
    }
  }
});

test("returning to the ready state resumes the same work and PR", () => {
  const inputResume = {
    pullRequests: [
      {
        number: 42,
        headBranch: "factory/issue-4",
        state: "open" as const,
        createdAt: pr.createdAt,
      },
    ],
  };
  const claim: Claim = { issue: 4, pullRequest: "open", inputResume };
  assert.deepEqual(
    decide({ issues: [issue(4, [labels.grill])], claims: [claim] }),
    [{ kind: "release", ...at }],
  );
  const decisions = decide({ issues: [issue(4)], claims: [claim] });
  assert.deepEqual(decisions[0], { kind: "claim", ...at });
  assert.deepEqual(launchOf(decisions)?.continuation.inputResume, inputResume);
  assert.equal(launchOf(decisions)?.continuation.runKind, undefined);
});

test("each optional-kind combination runs only its kinds", () => {
  for (const triage of [false, true])
    for (const review of [false, true]) {
      const kinds = { triage, review };
      const name = JSON.stringify(kinds);
      assert.equal(
        launchOf(decide({ issues: [issue(4, [labels.triage])], kinds }))
          ?.continuation.runKind,
        triage ? "triage" : undefined,
        name,
      );
      const implement = launchOf(decide({ kinds }));
      assert.ok(
        implement && implement.continuation.runKind === undefined,
        name,
      );
      const delivered = decide({
        issues: [issue(4, claimed)],
        runs: [ended({}, true)],
        kinds,
      });
      // Without review, implement's skill delivers: its open PR awaits merge.
      assert.deepEqual(
        delivered.map(({ kind }) => kind),
        review ? ["keep", "launch"] : ["keep", "skip"],
        name,
      );
      assert.equal(
        delivered[0].kind === "keep" && delivered[0].quiet,
        review ? true : undefined,
        name,
      );
    }
});

test("a review stopped at a gate resumes, claiming again, once the gate is cleared", () => {
  const review = {
    target: pr,
    implementedBy: "provider-a",
    handBacks: 0,
    gated: true,
  };
  const claim: Claim = {
    issue: 4,
    pullRequest: "open",
    inputResume: { pullRequests: [], review },
  };
  const waiting = [labels.owner, labels.ownerReview];
  assert.deepEqual(decide({ issues: [issue(4, waiting)], claims: [claim] }), [
    { kind: "release", ...at },
  ]);
  // A gate on the PR alone still stops it, as does an unreadable gate read.
  for (const gated of [[42], null])
    assert.equal(
      launchOf(
        decide({
          issues: [issue(4, [labels.owner])],
          claims: [claim],
          details: { gated },
        }),
      ),
      undefined,
    );
  const resumed = decide({
    issues: [issue(4, [labels.owner])],
    claims: [claim],
    details: { gated: [] },
  });
  assert.deepEqual(resumed[0], { kind: "claim", ...at });
  const launch = launchOf(resumed)!;
  assert.equal(launch.continuation.runKind, "review");
  assert.deepEqual(launch.continuation.target, pr);
  // Another stop the owner chose keeps it waiting.
  assert.equal(
    launchOf(
      decide({
        issues: [issue(4, [labels.owner, labels.grill])],
        claims: [claim],
      }),
    ),
    undefined,
  );
});

test("a review stopped with its PR ready resumes as review once its issue is ready again", () => {
  const claim: Claim = {
    issue: 4,
    pullRequest: "open",
    inputResume: {
      pullRequests: [],
      review: { target: pr, handBacks: 1, gated: false },
    },
  };
  assert.deepEqual(
    decide({ issues: [issue(4, [labels.owner])], claims: [claim] }),
    [{ kind: "release", ...at }],
  );
  const launch = launchOf(decide({ issues: [issue(4)], claims: [claim] }))!;
  assert.equal(launch.continuation.runKind, "review");
  assert.equal(launch.continuation.handBacks, 1);
});

test("run kinds pass the shared gate: invalid model labels and holds wait on every kind", () => {
  const cases: [string, Parameters<typeof decide>[0]][] = [
    ["triage", { issues: [issue(4, [labels.triage])] }],
    ["implement", {}],
    ["review", { issues: [issue(4, claimed)], runs: [ended({}, true)] }],
    [
      "hand-back",
      {
        issues: [issue(4, claimed)],
        runs: [ended({ continuation: { runKind: "review" } }, true)],
      },
    ],
  ];
  for (const [name, input] of cases) {
    const issues = input!.issues ?? [issue(4)];
    const labelled = issues.map((each) => ({
      ...each,
      labels: [
        ...each.labels,
        "model:provider-a/model-x",
        "model:provider-b/model-y",
      ],
    }));
    const held = decide({ ...input, issues: labelled });
    assert.equal(launchOf(held), undefined, name);
    assert.ok(
      held.some(
        (decision) =>
          decision.kind === "skip" &&
          decision.hold === holdKeys.model &&
          decision.reason.endsWith(
            "several model labels: model:provider-a/model-x, model:provider-b/model-y",
          ),
      ),
      name,
    );
    const paused = decide({
      ...input,
      details: { paused: "its Dockerfile is missing" },
    });
    assert.equal(launchOf(paused), undefined, name);
    assert.ok(
      paused.some(
        (decision) =>
          decision.kind === "skip" && decision.hold === holdKeys.configuration,
      ),
      name,
    );
    const factoryHeld = decide({ ...input, details: { factoryHold: [9] } });
    assert.equal(launchOf(factoryHeld), undefined, name);
  }
});

test("a review merges its own held PR: the factory hold exempts the review's target", () => {
  const decisions = decide({
    issues: [issue(4, claimed)],
    runs: [ended({}, true)],
    details: { factoryHold: [42] },
  });
  assert.equal(launchOf(decisions)?.continuation.runKind, "review");
});

test("with review on, a stale PR's merge relaunch runs review, keeping the release-hold asymmetry", () => {
  const stale = run({
    continuation: { runKind: "review" },
    ended: {
      timedOut: false,
      pullRequest: "open",
      openPullRequest: pr,
      mergeCandidate: pr,
    },
  });
  const decisions = decide({ issues: [issue(4, claimed)], runs: [stale] });
  const launch = launchOf(decisions)!;
  assert.equal(launch.continuation.runKind, "review");
  assert.deepEqual(launch.continuation.mergeRelaunch, pr);
  assert.equal(launch.selection, "recorded");
  // A fresh merge relaunch waits for a release hold...
  assert.match(
    skipOf(
      decide({
        issues: [issue(4, claimed)],
        runs: [stale],
        details: { releaseHold: [9] },
      }),
    )!.reason,
    /^relaunch waits: release hold/,
  );
  // ...while an interrupted one resumes, as before review existed.
  const interrupted = run({
    continuation: { runKind: "review", mergeRelaunch: pr },

    ended: { interrupted: true },
  });
  assert.equal(
    launchOf(
      decide({
        issues: [issue(4, claimed)],
        runs: [interrupted],
        details: { releaseHold: [9] },
      }),
    )?.continuation.runKind,
    "review",
  );
});

test("an unavailable {pullRequest} placeholder prevents launch with a configuration diagnostic", () => {
  const repository = configuration({ review: false });
  if (repository.version === 3)
    repository.runKinds.implement.arguments = "#{issue} pr={pullRequest}";
  const decisions = decideFactory(
    {
      now,
      repositories: [
        {
          name: widgets,
          configuration: repository,
          authorization: { authorizedRoles: ["admin"], neverAuthorize: [] },
          paused: null,
          issues: [issue(4)],
          claims: [],
        },
      ],
      runs: [],
      usage: {},
      holds: {},
      owners: {},
      settings: {
        defaultModel: "provider-a/model-impl",
        retryModel: "provider-b/model-retry",
        caps: { "provider-a": 1 },
        drainThreshold: null,
        pauseThreshold: null,
        timeLimitMinutes: 240,
      },
    },
    models,
  );
  assert.deepEqual(decisions, [
    {
      kind: "skip",
      ...at,
      reason:
        "runKinds.implement.arguments names {pullRequest}, and this launch has no pull request",
    },
  ]);
});

// Model resolution: the issue label selects only the initial implement
// attempt; every stage then takes its policy preference, then the host's
// default for it, always within host capabilities.
const failedFirst = run({ ended: { timedOut: false, pullRequest: "none" } });

function stages(
  policy?: ModelPolicy,
  issueLabels: string[] = [],
  settings: Partial<Settings> = {},
) {
  const model = (decisions: Decision[]) => {
    const launch = launchOf(decisions);
    return launch
      ? `${launch.provider}/${launch.model}@${launch.effort} ${launch.selection}`
      : skipOf(decisions)?.reason;
  };
  return {
    triage: model(
      decide({
        issues: [issue(4, [labels.triage, ...issueLabels])],
        policy,
        settings,
      }),
    ),
    initial: model(
      decide({
        issues: [issue(4, [labels.ready, ...issueLabels])],
        policy,
        settings,
      }),
    ),
    retry: model(
      decide({
        issues: [issue(4, [...claimed, ...issueLabels])],
        runs: [failedFirst],
        policy,
        settings,
      }),
    ),
    review: model(
      decide({
        issues: [issue(4, [...claimed, ...issueLabels])],
        runs: [ended({}, true)],
        policy,
        settings,
      }),
    ),
  };
}

test("without a policy every stage takes the host's default, and the label only the initial attempt", () => {
  assert.deepEqual(stages(), {
    triage: "provider-a/model-impl@medium host-default",
    initial: "provider-a/model-impl@medium host-default",
    retry: "provider-b/model-retry@medium host-default",
    review: "provider-a/model-impl@medium host-default",
  });
  assert.deepEqual(
    stages(undefined, ["model:provider-b/model-label@high"], {
      triageModel: "provider-a/model-triage",
      reviewModel: "provider-b/model-host",
    }),
    {
      triage: "provider-a/model-triage@medium host-default",
      initial: "provider-b/model-label@high issue-label",
      retry: "provider-b/model-retry@medium host-default",
      review: "provider-b/model-host@medium host-default",
    },
  );
});

test("a partial policy sets its stages, with explicit effort, and leaves the rest to host defaults", () => {
  const policy: ModelPolicy = {
    version: 1,
    fallback: "wait",
    runKinds: {
      review: { provider: "provider-a", model: "model-review", effort: "high" },
      implement: { initial: { provider: "provider-a", model: "model-host" } },
    },
  };
  assert.deepEqual(stages(policy), {
    triage: "provider-a/model-impl@medium host-default",
    initial: "provider-a/model-host@medium policy",
    retry: "provider-b/model-retry@medium host-default",
    review: "provider-a/model-review@high policy",
  });
  // The issue label still precedes the initial-implement preference.
  assert.equal(
    stages(policy, ["model:provider-b/model-label"]).initial,
    "provider-b/model-label@medium issue-label",
  );
});

test("a stage may reuse the issue's label, which it then needs", () => {
  const policy: ModelPolicy = {
    version: 1,
    fallback: "wait",
    runKinds: {
      triage: { source: "issue-label" },
      implement: { retry: { source: "issue-label" } },
      review: { source: "issue-label" },
    },
  };
  assert.deepEqual(stages(policy, ["model:provider-b/model-label"]), {
    triage: "provider-b/model-label@medium issue-label",
    initial: "provider-b/model-label@medium issue-label",
    retry: "provider-b/model-label@medium issue-label",
    review: "provider-b/model-label@medium issue-label",
  });
  const held = decide({
    issues: [issue(4, claimed)],
    runs: [failedFirst],
    policy,
  });
  assert.deepEqual(skipOf(held), {
    kind: "skip",
    ...at,
    reason:
      "retry waits: the model policy's runKinds.implement.retry selects the issue's model label, and the issue has none",
    hold: holdKeys.model,
  });
});

test("a policy preference outside the host's capabilities holds rather than launching", () => {
  const decisions = decide({
    policy: {
      version: 1,
      fallback: "host-default",
      runKinds: {
        implement: { initial: { provider: "provider-c", model: "x" } },
      },
    },
  });
  assert.equal(launchOf(decisions), undefined);
  assert.deepEqual(skipOf(decisions), {
    kind: "skip",
    ...at,
    reason:
      "the model policy's runKinds.implement.initial is outside this host's capabilities: model provider-c/x is outside this host's capabilities",
    hold: holdKeys.model,
  });
});

// The policy's preference on a provider at its cap: `provider-a` runs two.
const busy = [
  run({ issue: 8, provider: "provider-a" }),
  run({ issue: 9, provider: "provider-a" }),
];

test("an unavailable preference waits, or takes an available host default under host-default", () => {
  const preference = {
    provider: "provider-a",
    model: "model-review",
  };
  const policy = (fallback: ModelPolicy["fallback"]): ModelPolicy => ({
    version: 1,
    fallback,
    runKinds: { implement: { initial: preference } },
  });
  const issues = [issue(4), issue(8, claimed), issue(9, claimed)];
  assert.equal(
    skipOf(
      decide({ issues, runs: busy, policy: policy("wait") }).filter(
        (d) => d.issue === 4,
      ),
    )?.reason,
    "provider-a already runs its cap of 2 agents",
  );
  const fallback = launchOf(
    decide({
      issues,
      runs: busy,
      policy: policy("host-default"),
      settings: { defaultModel: "provider-b/model-host" },
    }),
  )!;
  assert.equal(
    `${fallback.provider}/${fallback.model}`,
    "provider-b/model-host",
  );
  assert.equal(fallback.selection, "fallback");
  // An unavailable host default waits too, without any other substitution.
  assert.equal(
    launchOf(decide({ issues, runs: busy, policy: policy("host-default") })),
    undefined,
  );
  // Restored availability launches the preference itself.
  const restored = launchOf(decide({ policy: policy("wait") }))!;
  assert.equal(
    `${restored.model} ${restored.selection}`,
    "model-review policy",
  );
});

test("an unavailable issue label falls back only under host-default, and forbidden labels never do", () => {
  const issues = [
    issue(4, [labels.ready, "model:provider-a/model-impl"]),
    issue(8, claimed),
    issue(9, claimed),
  ];
  const fallback = (policy?: ModelPolicy) =>
    launchOf(
      decide({
        issues,
        runs: busy,
        policy,
        settings: { defaultModel: "provider-b/model-host" },
      }),
    );
  assert.equal(fallback(), undefined);
  assert.equal(
    fallback({ version: 1, fallback: "wait", runKinds: {} }),
    undefined,
  );
  assert.equal(
    fallback({ version: 1, fallback: "host-default", runKinds: {} })?.selection,
    "fallback",
  );
  for (const label of [
    "model:provider-c/model-x",
    "model:provider-a/nothing",
  ]) {
    const held = decide({
      issues: [issue(4, [labels.ready, label])],
      policy: { version: 1, fallback: "host-default", runKinds: {} },
    });
    assert.equal(launchOf(held), undefined);
    assert.equal(skipOf(held)?.hold, holdKeys.model);
  }
});

test("a retry on a provider other than its first attempt's records its stage's choice", () => {
  const launch = launchOf(
    decide({
      issues: [issue(4, claimed)],
      runs: [failedFirst],
      policy: {
        version: 1,
        fallback: "wait",
        runKinds: {
          implement: { retry: { provider: "provider-b", model: "model-host" } },
        },
      },
    }),
  )!;
  assert.equal(launch.continuation.attempt, 2);
  assert.equal(
    `${launch.provider}/${launch.model} ${launch.selection}`,
    "provider-b/model-host policy",
  );
});

// Provider diversity: implement's PR-producing attempt ran on provider-a.
function review({
  policy,
  reviewModel,
  differentProvider = true,
  implementedBy = "provider-a",
  runs = [],
}: {
  policy?: ModelPolicy;
  reviewModel?: string;
  differentProvider?: boolean;
  implementedBy?: string;
  runs?: Run[];
}) {
  const decisions = decide({
    issues: [
      issue(4, claimed),
      ...runs.map((each) => issue(each.issue, claimed)),
    ],
    runs: [ended({ provider: implementedBy }, true), ...runs],
    kinds: { differentProvider },
    policy,
    settings: reviewModel === undefined ? {} : { reviewModel },
  });
  const launch = launchOf(decisions.filter((decision) => decision.issue === 4));
  return launch
    ? `${launch.provider}/${launch.model} ${launch.selection}${launch.diversity ? ` diversity ${launch.diversity}` : ""}`
    : undefined;
}

const reviewPreference = (fallback: ModelPolicy["fallback"]): ModelPolicy => ({
  version: 1,
  fallback,
  runKinds: { review: { provider: "provider-a", model: "model-review" } },
});

test("diversity switches an available same-provider review to the host's review default under host-default", () => {
  assert.equal(
    review({
      policy: reviewPreference("host-default"),
      reviewModel: "provider-b/model-host",
    }),
    "provider-b/model-host diversity",
  );
});

test("without a permitted alternative, review stays on its choice and reports unavailable diversity without waiting", () => {
  const unavailable = "provider-a/model-review policy diversity unavailable";
  assert.equal(
    review({
      policy: reviewPreference("wait"),
      reviewModel: "provider-b/model-host",
    }),
    unavailable,
  );
  assert.equal(
    review({ policy: reviewPreference("host-default") }),
    unavailable,
  );
  assert.equal(
    review({
      policy: reviewPreference("host-default"),
      reviewModel: "provider-a/model-host",
    }),
    unavailable,
  );
  // A provider-B default at its cap is unavailable.
  assert.equal(
    review({
      policy: reviewPreference("host-default"),
      reviewModel: "provider-b/model-host",
      runs: [
        run({ issue: 8, provider: "provider-b", model: "model-host" }),
        run({ issue: 9, provider: "provider-b", model: "model-host" }),
      ],
    }),
    unavailable,
  );
});

test("without a policy, the host's review default either already differs or stays chosen", () => {
  assert.equal(
    review({ reviewModel: "provider-b/model-host" }),
    "provider-b/model-host host-default",
  );
  assert.equal(
    review({ reviewModel: "provider-a/model-host" }),
    "provider-a/model-host host-default diversity unavailable",
  );
});

test("diversity compares the provider of the attempt that produced the PR, and only when asked", () => {
  // A retry on provider-b produced the PR, so a provider-a review differs.
  assert.equal(
    review({ policy: reviewPreference("wait"), implementedBy: "provider-b" }),
    "provider-a/model-review policy",
  );
  for (const differentProvider of [false, undefined])
    assert.equal(
      launchOf(
        decide({
          issues: [issue(4, claimed)],
          runs: [ended({}, true)],
          kinds: { differentProvider },
          policy: reviewPreference("host-default"),
          settings: { reviewModel: "provider-b/model-host" },
        }),
      )?.model,
      "model-review",
    );
});

test("a hand-back's failed implement attempt retries on the same PR", () => {
  const launch = launchOf(
    decide({
      issues: [issue(4, claimed)],
      runs: [
        run({
          continuation: { target: pr, handBacks: 1 },

          ended: { timedOut: false, pullRequest: "none" },
        }),
      ],
    }),
  )!;
  assert.equal(launch.continuation.attempt, 2);
  assert.deepEqual(launch.continuation.target, pr);
  assert.equal(launch.continuation.handBacks, 1);
});

test("an authorized issue author triggers triage without a label, including under a validator fallback", () => {
  for (const issueLabels of [[], [labels.triage]]) {
    const candidate = issue(4, issueLabels, {
      author: owner,
      triage: { at: now, actor: { kind: "bot", login: "validator[bot]" } },
    });
    assert.equal(
      launchOf(decide({ issues: [candidate] }))?.continuation.runKind,
      "triage",
    );
    for (const stopped of [
      labels.ready,
      labels.reporter,
      labels.grill,
      labels.owner,
    ])
      assert.notEqual(
        launchOf(decide({ issues: [{ ...candidate, labels: [stopped] }] }))
          ?.continuation.runKind,
        "triage",
      );
  }
});

test("outside issue text waits for a person's trusted label, never a bot fallback", () => {
  const outsider: Actor = { kind: "user", login: "reporter", role: null };
  assert.equal(
    launchOf(decide({ issues: [issue(4, [], { author: outsider })] })),
    undefined,
  );
  for (const actor of [
    outsider,
    { kind: "bot", login: "validator[bot]" },
    { kind: "unknown" },
    { kind: "unreadable", login: "owner" },
    { kind: "user", login: "writer", role: "write" },
  ] as Actor[]) {
    assert.equal(
      launchOf(
        decide({
          issues: [
            issue(4, [labels.triage], {
              author: outsider,
              triage: { at: now, actor },
            }),
          ],
        }),
      ),
      undefined,
      actor.kind,
    );
  }
  assert.equal(
    launchOf(
      decide({ issues: [issue(4, [labels.triage], { author: outsider })] }),
    )?.continuation.runKind,
    "triage",
  );
  assert.equal(
    launchOf(
      decide({
        issues: [issue(4, [], { author: owner })],
        details: {
          authorization: {
            authorizedRoles: ["admin"],
            neverAuthorize: ["OwNeR"],
          },
        },
      }),
    ),
    undefined,
  );
});

test("only a new reporter-state author reply retriggers triage, once, under a trusted stop", () => {
  const candidate = issue(4, [labels.reporter], {
    author: { kind: "user", login: "reporter", role: null },
    reporter: { at: "2026-10-08T00:00:00Z", actor: owner },
    authorReply: "2026-10-09T00:00:00Z",
  });
  assert.equal(
    launchOf(decide({ issues: [candidate] }))?.continuation.runKind,
    "triage",
  );
  for (const details of [
    { authorReply: null },
    { authorReply: candidate.reporter!.at },
    { lastTriageAt: now },
    { reporter: null },
    {
      reporter: {
        at: candidate.reporter!.at,
        actor: { kind: "bot", login: "outside[bot]" } as Actor,
      },
    },
  ])
    assert.equal(
      launchOf(decide({ issues: [{ ...candidate, ...details }] })),
      undefined,
    );
  assert.equal(
    launchOf(
      decide({
        issues: [
          {
            ...candidate,
            trustedHistory: true,
            reporter: {
              at: candidate.reporter!.at,
              actor: { kind: "bot", login: "factory[bot]" },
            },
          },
        ],
      }),
    )?.continuation.runKind,
    "triage",
  );
});

test("a consumed opening or label cannot repeat triage; a later trusted label can", () => {
  const candidate = issue(4, [], { author: owner, lastTriageAt: now });
  assert.equal(launchOf(decide({ issues: [candidate] })), undefined);
  assert.equal(
    launchOf(
      decide({
        issues: [
          {
            ...candidate,
            labels: [labels.triage],
            triage: { actor: owner, at: "2026-10-10T00:00:00Z" },
          },
        ],
      }),
    )?.continuation.runKind,
    "triage",
  );
});

test("a host-verified factory finding triggers triage; an unverified bot citation does not", () => {
  const candidate = issue(4, [], {
    author: { kind: "bot", login: "factory[bot]" },
    filingRun: "run-id",
  });
  assert.equal(launchOf(decide({ issues: [candidate] })), undefined);
  assert.equal(
    launchOf(decide({ issues: [{ ...candidate, filedByTrustedRun: true }] }))
      ?.continuation.runKind,
    "triage",
  );
});

test("trusted unowned draft PRs start review with and without linked issues, through the shared gate", () => {
  for (const nativeParent of [null, 3]) {
    const candidate = issue(42, [], {
      createdAt: pr.createdAt,
      author: owner,
      nativeParent,
      pullRequest: { target: pr, draft: true },
    });
    const review = launchOf(decide({ issues: [candidate] }));
    assert.equal(review?.continuation.runKind, "review");
    assert.equal(review?.issue, 42);
    assert.equal(review?.continuation.target?.number, 42);
    for (const details of [
      { author: { kind: "user", login: "outsider", role: null } as Actor },
      { author: { kind: "bot", login: "app[bot]" } as Actor },
      { pullRequest: { target: pr, draft: false } },
      { reviewedHeads: [pr.headCommit] },
    ])
      assert.equal(
        launchOf(decide({ issues: [{ ...candidate, ...details }] })),
        undefined,
      );
    for (const details of [
      { ownedPullRequests: [42] },
      { factoryHold: [90] },
      {
        authorization: {
          authorizedRoles: ["admin"],
          neverAuthorize: ["OWNER"],
        },
      },
    ])
      assert.equal(
        launchOf(decide({ issues: [candidate], details })),
        undefined,
      );
    assert.equal(
      launchOf(
        decide({ issues: [{ ...candidate, labels: ["model:forbidden"] }] }),
      ),
      undefined,
    );
    assert.equal(
      launchOf(decide({ issues: [candidate], kinds: { review: false } })),
      undefined,
    );
    assert.equal(
      launchOf(
        decide({
          issues: [
            {
              ...candidate,
              pullRequest: {
                target: pr,
                draft: true,
                headBranch: "factory/issue-4",
              },
            },
          ],
          runs: [run()],
        }),
      ),
      undefined,
    );
  }
});

test("removing review configuration makes its stale PR relaunch implement", () => {
  const stale = run({
    continuation: { runKind: "review" },
    ended: {
      timedOut: false,
      pullRequest: "open",
      openPullRequest: pr,
      mergeCandidate: pr,
    },
  });
  const launch = launchOf(
    decide({
      issues: [issue(4, claimed)],
      runs: [stale],
      kinds: { review: false },
    }),
  )!;
  assert.ok(launch);
  assert.equal(launch.continuation.runKind, undefined);
  assert.deepEqual(launch.continuation.mergeRelaunch, pr);
});
