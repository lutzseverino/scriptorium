import assert from "node:assert/strict";
import { test } from "node:test";
import { providerStatus } from "../src/events.ts";
import { emptyRunKindCounts, type Run } from "../src/factory.ts";
import { hostStatus } from "../src/status.ts";

test("host status accepts the original three arguments with no provider statuses", () => {
  const now = "2026-10-18T00:00:00.000Z";
  assert.deepEqual(
    hostStatus(now, [{ name: "acme/widgets", paused: null }], []),
    {
      updatedAt: now,
      providers: [],
      capacity: {
        observedAt: now,
        counting: "non-ended-runs",
        host: {
          runKinds: emptyRunKindCounts(),
          implement: { limit: null, running: 0, free: null },
        },
        repositories: [
          {
            repository: "acme/widgets",
            runKinds: emptyRunKindCounts(),
            implement: { limit: null, running: 0, free: null },
          },
        ],
      },
      repositories: [
        { repository: "acme/widgets", state: "running", held: [] },
      ],
    },
  );
});

test("host status keeps explicitly supplied provider statuses", () => {
  const now = "2026-10-18T00:00:00.000Z";
  const providers = [
    providerStatus(
      "codex",
      now,
      null,
      null,
      null,
      {
        drainThreshold: 80,
        pauseThreshold: 95,
        afterDrain: "auto-resume",
      },
      0,
      0,
    ),
  ];
  assert.deepEqual(hostStatus(now, [], [], providers), {
    updatedAt: now,
    repositories: [],
    providers,
    capacity: {
      observedAt: now,
      counting: "non-ended-runs",
      host: {
        runKinds: emptyRunKindCounts(),
        implement: { limit: null, running: 0, free: null },
      },
      repositories: [],
    },
  });
});

test("capacity projection counts run exits independently of retained endings across providers", () => {
  const now = "2026-11-09T00:00:00.000Z";
  const run = (
    repository: string,
    issue: number,
    details: Partial<Run> = {},
  ): Run => ({
    repository,
    issue,
    provider: issue % 2 ? "codex" : "claude-code",
    model: "model",
    effort: "high",
    continuation: { attempt: 1 },
    startedAt: now,
    log: "/tmp/log",
    exited: details.ended != null,
    ended: null,
    ...details,
  });
  const runs = [
    run("acme/widgets", 1),
    run("acme/widgets", 2, { continuation: { attempt: 1, runKind: "triage" } }),
    run("acme/gadgets", 3),
    run("acme/gadgets", 4, { continuation: { attempt: 1, runKind: "review" } }),
    run("acme/widgets", 5, { ended: { interrupted: true } }),
    run("acme/widgets", 6, {
      ended: {
        paused: { cause: "usage limit", reset: null, at: now, until: now },
      },
    }),
    run("acme/widgets", 7, { ended: { timedOut: false, pullRequest: "open" } }),
    ...([undefined, "triage", "review"] as const).map((runKind, i) =>
      run("acme/widgets", 8 + i, {
        exited: true,
        ended: null,
        continuation: { attempt: 1, runKind },
      }),
    ),
  ];
  const repos = [
    { name: "acme/widgets", paused: null },
    { name: "acme/gadgets", paused: "held" },
    { name: "acme/empty", paused: null },
  ];
  for (const limits of [
    undefined,
    { total: 2, perRepository: 1 },
    { total: 4, perRepository: 2 },
    { total: 0, perRepository: 0 },
  ]) {
    const capacity = hostStatus(
      now,
      repos,
      [],
      [],
      undefined,
      runs,
      limits,
    ).capacity;
    assert.deepEqual(capacity.host.runKinds, {
      implement: 2,
      triage: 1,
      review: 1,
    });
    assert.equal(capacity.host.implement.running, 2);
    assert.equal(capacity.host.implement.limit, limits?.total ?? null);
    assert.equal(
      capacity.host.implement.free,
      limits ? Math.max(0, limits.total - 2) : null,
    );
    assert.deepEqual(
      capacity.repositories.map(({ runKinds }) => runKinds),
      [
        { implement: 1, triage: 1, review: 0 },
        { implement: 1, triage: 0, review: 1 },
        { implement: 0, triage: 0, review: 0 },
      ],
    );
    assert.deepEqual(
      capacity.repositories.map(({ implement }) => implement.free),
      limits
        ? [
            Math.max(0, limits.perRepository - 1),
            Math.max(0, limits.perRepository - 1),
            limits.perRepository,
          ]
        : [null, null, null],
    );
  }
});
