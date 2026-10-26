import assert from "node:assert/strict";
import { test } from "node:test";
import { providerStatus } from "../src/events.ts";
import { hostStatus } from "../src/status.ts";

test("host status accepts the original three arguments with no provider statuses", () => {
  const now = "2026-10-18T00:00:00.000Z";
  assert.deepEqual(
    hostStatus(now, [{ name: "acme/widgets", paused: null }], []),
    {
      updatedAt: now,
      providers: [],
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
  });
});
