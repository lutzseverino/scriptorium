import assert from "node:assert/strict";
import { test } from "node:test";
import { maximumPauseHours, pauseDeadline } from "../src/pause.ts";

const deadline = (reset: string | null, pausedAt: string) =>
  pauseDeadline(reset, new Date(pausedAt)).toISOString();

test("a UTC time-of-day reset is its first occurrence at or after the pause, whenever it is computed", () => {
  // The incident: paused at 15:03:29, so 5:50pm is that same day's, even
  // when a later pass or restart on October 15 computes it.
  assert.equal(
    deadline("5:50pm (UTC)", "2026-10-14T15:03:29.000Z"),
    "2026-10-14T17:50:00.000Z",
  );
  for (const [reset, pausedAt, expected] of [
    ["12:50pm (UTC)", "2026-10-09T11:30:00.000Z", "2026-10-09T12:50:00.000Z"],
    ["3pm (UTC)", "2026-10-09T15:00:00.000Z", "2026-10-09T15:00:00.000Z"],
    ["3 PM (UTC)", "2026-10-09T15:00:00.001Z", "2026-10-10T15:00:00.000Z"],
    ["12am (UTC)", "2026-10-09T23:10:00.000Z", "2026-10-10T00:00:00.000Z"],
    ["12:30am (utc)", "2026-12-31T23:59:00.000Z", "2027-01-01T00:30:00.000Z"],
    ["17:50 (UTC)", "2026-10-14T18:00:00.000Z", "2026-10-15T17:50:00.000Z"],
  ] as const)
    assert.equal(deadline(reset, pausedAt), expected, reset);
});

test("a missing, unsupported or ambiguous reset waits the whole hold from the pause", () => {
  assert.equal(maximumPauseHours, 24);
  for (const reset of [
    null,
    "3pm",
    "3pm (America/New_York)",
    "Oct 20, 3pm (Europe/Berlin)",
    "3:45 PM",
    "in 5 minutes",
    "13pm (UTC)",
    "0am (UTC)",
    "3:75pm (UTC)",
    "24:00 (UTC)",
  ])
    assert.equal(
      deadline(reset, "2026-10-14T15:03:29.000Z"),
      "2026-10-15T15:03:29.000Z",
      String(reset),
    );
});

test("a reset at the pause's own minute is the pause, and one just past it the next day's", () => {
  assert.equal(
    deadline("5:50pm (UTC)", "2026-10-14T17:50:00.000Z"),
    "2026-10-14T17:50:00.000Z",
  );
  assert.equal(
    deadline("5:50pm (UTC)", "2026-10-14T17:50:30.000Z"),
    "2026-10-15T17:50:00.000Z",
  );
});
