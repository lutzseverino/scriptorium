import assert from "node:assert/strict";
import { test } from "node:test";
import type { Git } from "../src/clone.ts";
import type {
  Claim,
  Issue,
  Models,
  Repository,
  Run,
  Snapshot,
} from "../src/factory.ts";
import type { FactoryConfiguration } from "../src/factory-configuration.ts";
import type { MergeRelaunch } from "../src/platform.ts";
import {
  observeEnding,
  settleEnding,
  type EndingReads,
  type RunEnding,
} from "../src/run-ending.ts";

// The run-ending module: ended runs and orphaned claims observed and settled
// at one boundary, on a version 3 configuration with review on.
const widgets = "acme/widgets";
const labels = {
  triage: "state:triage",
  owner: "state:owner",
  ready: "state:ready",
  running: "factory:running",
  paused: "factory:paused",
  failed: "factory:failed",
};

function configuration(review = true): FactoryConfiguration {
  return {
    version: 3,
    labels,
    contractResult: { marker: "contract", author: "validator[bot]" },
    modelLabelPrefix: "model:",
    runKinds: {
      implement: { skill: "implement", arguments: "#{issue}" },
      triage: { skill: "triage", arguments: "#{issue}" },
      ...(review && {
        review: { skill: "review", arguments: "#{pullRequest}" },
      }),
    },
  };
}

// Only the retry model `provider/retry` resolves.
const models: Models = {
  resolveModel: (value) =>
    value === "provider/retry"
      ? { provider: "provider", model: "retry", effort: "high" }
      : { error: `${value} is outside this host's capabilities` },
  resolveModelLabel: () => ({ error: "unused" }),
};

function issue(labelled = [labels.ready, labels.running]): Issue {
  return {
    number: 4,
    createdAt: "2026-10-01T00:00:00Z",
    labels: labelled,
    ready: null,
    editedAt: null,
    contractHold: null,
    nativeParent: null,
    latestLink: null,
    linkAdditions: null,
    subIssues: [],
    blockedBy: [],
  };
}

function repository(issues: Issue[] = [issue()], review = true): Repository {
  return {
    name: widgets,
    configuration: configuration(review),
    authorization: { authorizedRoles: ["admin"], neverAuthorize: [] },
    paused: null,
    issues,
    claims: [],
  };
}

function snapshot(retryModel = "provider/retry"): Snapshot {
  return {
    now: "2026-10-09T12:00:00Z",
    repositories: [],
    runs: [],
    usage: {},
    holds: {},
    owners: {},
    settings: {
      defaultModel: "provider/default",
      retryModel,
      caps: { provider: 1 },
      drainThreshold: null,
      pauseThreshold: null,
      timeLimitMinutes: 240,
    },
  };
}

const pr: MergeRelaunch = {
  number: 42,
  headCommit: "a".repeat(40),
  baseBranch: "main",
  createdAt: "2026-10-09T11:30:00Z",
};

function run(ending: Partial<RunEnding>, details: Partial<Run> = {}) {
  const ended: RunEnding = { timedOut: false, pullRequest: "none", ...ending };
  return {
    run: {
      repository: widgets,
      issue: 4,
      provider: "provider",
      model: "default",
      effort: "high",
      attempt: 1 as const,
      startedAt: "2026-10-09T11:00:00Z",
      log: "/srv/factory/issue-4-attempt-1.log",
      ...details,
      ended,
    },
    ending: ended,
  };
}

const at = { repository: widgets, issue: 4 };
const settle = (
  ended: Parameters<typeof settleEnding>[0],
  target = repository(),
  state = snapshot(),
) => settleEnding(ended, target, state, models);

test("an ended run and an orphaned claim settle through one table, in order", () => {
  const claim = (facts: Partial<Claim>): { claim: Claim } => ({
    claim: { issue: 4, pullRequest: "none", ...facts },
  });
  // A closed issue is done before any other fact.
  assert.deepEqual(settle(run({ pullRequest: "merged" }), repository([])), [
    { kind: "release", ...at },
  ]);
  assert.deepEqual(settle(run({ pullRequest: "merged", closesIssue: true })), [
    { kind: "complete", ...at },
  ]);
  assert.deepEqual(settle(claim({ pullRequest: "merged" })), [
    {
      kind: "fail",
      ...at,
      failure:
        "its pull request merged without closing the issue; close the issue if that finished it",
      log: null,
    },
  ]);
  // A stop precedes an open PR, even after a timeout.
  assert.deepEqual(
    settle(
      run({ pullRequest: "open", timedOut: true }),
      repository([issue([labels.ready, labels.owner])]),
    ),
    [{ kind: "release", ...at }],
  );
  // An orphaned claim's open PR awaits merge with its notice: a claim
  // records no run kind to hand it to review.
  assert.deepEqual(
    settle(claim({ pullRequest: "open", openPullRequest: pr })),
    [{ kind: "keep", ...at }],
  );
  assert.deepEqual(
    settle(run({ pullRequest: "open", openPullRequest: pr })),
    [{ kind: "keep", ...at, quiet: true }],
    "review takes an implement run's PR",
  );
  assert.deepEqual(
    settle(
      run({ pullRequest: "open", openPullRequest: pr }),
      repository(undefined, false),
    ),
    [{ kind: "keep", ...at }],
  );
  assert.deepEqual(
    settle(claim({ unpushedChanges: [".github/workflows/ci.yml"] })),
    [
      {
        kind: "fail",
        ...at,
        failure:
          "the run's branch changes paths the factory's GitHub App can't push",
        log: null,
        unpushedChanges: [".github/workflows/ci.yml"],
      },
    ],
  );
});

test("a review's draft PR hands back until its rounds fail", () => {
  const draft = {
    pullRequest: "open" as const,
    openPullRequest: { ...pr, draft: true as const },
  };
  assert.deepEqual(settle(run(draft, { runKind: "review", handBacks: 1 })), [
    { kind: "keep", ...at, quiet: true },
  ]);
  assert.deepEqual(settle(run(draft, { runKind: "review", handBacks: 2 })), [
    {
      kind: "fail",
      ...at,
      failure: "its review rounds did not converge after 2 hand-backs",
      log: "/srv/factory/issue-4-attempt-1.log",
    },
  ]);
});

test("only a failed first implement attempt retries, on an available retry model", () => {
  const failed = run({});
  assert.deepEqual(settle(failed), {
    run: failed.run,
    failure: "the run ended without an open pull request",
  });
  for (const [ended, state] of [
    [run({}, { attempt: 2 }), snapshot()],
    [run({}, { runKind: "review" }), snapshot()],
    [failed, snapshot("provider/unavailable")],
  ] as const)
    assert.equal(
      (settle(ended, repository(), state) as { kind: string }[])[0].kind,
      "fail",
    );
  // An orphaned record names its orphaning rather than its time.
  const orphan = run({ timedOut: true, orphaned: true });
  assert.deepEqual(settle(orphan), {
    run: orphan.run,
    failure: "no factory run or open pull request holds its claim",
  });
  assert.deepEqual(settle({ claim: { issue: 4, pullRequest: "closed" } }), {
    run: { repository: widgets, issue: 4, attempt: 1, log: null },
    failure: "its pull request closed without merging",
  });
  const overtime = run({ timedOut: true });
  assert.deepEqual(settle(overtime), {
    run: overtime.run,
    failure: "the run exceeded the time limit of 240 minutes",
  });
});

test("a triage run ends once its issue leaves the triage state", () => {
  const triage = run({}, { runKind: "triage" });
  assert.deepEqual(settle(triage, repository([issue([labels.ready])])), [
    { kind: "release", ...at },
  ]);
  assert.deepEqual(
    settle(triage, repository([issue([labels.triage, labels.running])])),
    [
      {
        kind: "fail",
        ...at,
        failure:
          "the triage run ended with the issue still labelled state:triage",
        log: "/srv/factory/issue-4-attempt-1.log",
      },
    ],
  );
});

// A platform whose run has one owned open PR, and a clone whose default branch
// is `main`, with the PR's head behind it.
function reads(
  observation: Partial<
    Awaited<ReturnType<EndingReads["platform"]["pullRequestObservation"]>>
  > = {},
) {
  const calls: string[] = [];
  const git: Git = async (_cwd, args) => {
    calls.push(args.join(" "));
    if (args[0] === "symbolic-ref") return "refs/remotes/origin/main\n";
    if (args[0] === "rev-list") return args[2].startsWith("a") ? "b\n" : "";
    return "";
  };
  return {
    calls,
    reads: {
      platform: {
        async pullRequestObservation(number, since, draft) {
          calls.push(`observe ${number} ${since} ${draft}`);
          return {
            state: "open",
            pullRequests: [],
            ownedPullRequests: [42],
            mergeCandidate: pr,
            ...observation,
          };
        },
      },
      git,
      clone: "/clone",
      configuration: configuration(),
      paused: false,
      unpushablePaths: [".github/workflows/"],
    } satisfies EndingReads,
  };
}

test("an ending reads the platform and its branch once, accumulating owned PRs", async () => {
  const { reads: open, calls } = reads();
  assert.deepEqual(
    await observeEnding(open, issue(), {
      issue: 4,
      since: "2026-10-09T11:00:00Z",
      review: true,
      ownedPullRequests: [7],
    }),
    {
      facts: { pullRequest: "open", mergeCandidate: pr, openPullRequest: pr },
      pullRequests: [],
      ownedPullRequests: [7, 42],
    },
  );
  assert.deepEqual(calls, [
    "observe 4 2026-10-09T11:00:00Z true",
    "symbolic-ref refs/remotes/origin/HEAD",
    `fetch --quiet --no-tags origin ${pr.headCommit}`,
    `rev-list --max-count=1 ${pr.headCommit}..refs/remotes/origin/HEAD`,
  ]);
  // A consumed head is no merge candidate, but a hold that stopped its merge
  // attempt returns it.
  const consumed = {
    issue: 4,
    mergeRelaunch: pr,
    mergeRelaunchHeads: [`42:${pr.headCommit}`],
  };
  assert.equal(
    (await observeEnding(open, issue(), { ...consumed, holdObserved: [] }))
      .facts.mergeCandidate,
    undefined,
  );
  const held = await observeEnding(open, issue(), {
    ...consumed,
    holdObserved: null,
  });
  assert.deepEqual(held.mergeRelaunchHeads, []);
  assert.deepEqual(held.facts.mergeCandidate, pr);
  // A stopped issue has no merge candidate, and a closed one no branch read.
  assert.equal(
    (await observeEnding(open, issue([labels.owner]), { issue: 4 })).facts
      .mergeCandidate,
    undefined,
  );
  const closed = reads({ state: "none", mergeCandidate: undefined });
  assert.deepEqual(
    (await observeEnding(closed.reads, undefined, { issue: 4 })).facts,
    { pullRequest: "none" },
  );
  assert.deepEqual(closed.calls, ["observe 4 undefined undefined"]);
});
