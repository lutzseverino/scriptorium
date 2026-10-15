import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createRegistry } from "../src/providers.ts";
import { UsageReadError } from "../src/providers/usage.ts";
import { createUsage, retryAt, usageFreshMinutes } from "../src/usage.ts";
import { directory, fakePorts } from "./fakes.ts";

const start = new Date("2026-10-14T15:00:00.000Z");
const later = (seconds: number) => new Date(start.getTime() + seconds * 1000);

test("a Retry-After delay counts from the answer's receipt, and an HTTP date in any of its forms is absolute", () => {
  for (const [value, expected] of [
    ["1148", "2026-10-14T15:19:08.000Z"],
    [" 60 ", "2026-10-14T15:01:00.000Z"],
    ["Wed, 14 Oct 2026 15:30:00 GMT", "2026-10-14T15:30:00.000Z"],
    ["Wednesday, 14-Oct-26 15:30:00 GMT", "2026-10-14T15:30:00.000Z"],
    ["Wed Oct 14 15:30:00 2026", "2026-10-14T15:30:00.000Z"],
    ["Thu, 15 Oct 2026 08:00:00 GMT", "2026-10-15T08:00:00.000Z"],
  ] as const)
    assert.equal(retryAt(value, start)?.toISOString() ?? null, expected, value);
});

test("a missing, malformed or past Retry-After lets the next pass read", () => {
  for (const value of [
    undefined,
    "",
    "soon",
    "-5",
    "1.5",
    "0",
    "Wed, 14 Oct 2026 14:00:00 GMT",
    "Thu Oct  1 15:30:00 2026",
    "Sat, 31 Feb 2026 15:30:00 GMT",
    "Wed, 14 Oct 2026 25:30:00 GMT",
    "2026-10-14T16:00:00Z",
    "Wed, 14 Oct 2026 15:30:00 UTC",
    "9".repeat(400),
  ])
    assert.equal(retryAt(value, start), null, String(value));
});

// Usage reads on a fake clock, with each provider's next answers queued: a
// number, null for no usage window, or an error to throw.
function usage(t: TestContext, path = join(directory(t), "usage.json")) {
  const clock = { now: start };
  const answers: Record<string, (number | null | Error)[]> = {
    "claude-code": [],
    codex: [],
  };
  const reads: string[] = [];
  const reports: string[] = [];
  const instance = createUsage({
    providers: ["claude-code", "codex"],
    async read(provider) {
      reads.push(provider);
      const answer = answers[provider].shift();
      if (answer === undefined) throw new Error(`no answer for ${provider}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    now: () => clock.now,
    report: (line) => reports.push(line),
    path,
  });
  return {
    ...instance,
    clock,
    answers,
    reads,
    reports,
    path,
    // A pass at `seconds` after the start.
    at(seconds: number) {
      clock.now = later(seconds);
      return instance.read();
    },
  };
}

const throttled = (retryAfter?: string) =>
  new UsageReadError("the usage endpoint answered HTTP 429", {
    status: 429,
    ...(retryAfter !== undefined && { retryAfter }),
  });

test("a provider throttled for 1148 seconds is not read at the next 600-second pass but at the first one after", async (t) => {
  const reader = usage(t);
  reader.answers["claude-code"].push(throttled("1148"), 30);
  reader.answers.codex.push(10, 11, 12);
  assert.deepEqual(await reader.at(0), {
    "claude-code": null,
    codex: { used: 10, at: start.toISOString() },
  });
  assert.deepEqual(reader.reports, [
    "usage for claude-code is unreadable: UsageReadError: the usage endpoint answered HTTP 429; it is next read at 2026-10-14T15:19:08.000Z",
  ]);
  // The other provider reads every pass meanwhile.
  assert.deepEqual(await reader.at(600), {
    "claude-code": null,
    codex: { used: 11, at: later(600).toISOString() },
  });
  assert.deepEqual(reader.reads, ["claude-code", "codex", "codex"]);
  assert.equal(
    reader.reports[1],
    "usage for claude-code is not read before 2026-10-14T15:19:08.000Z, as its provider asked",
  );
  assert.deepEqual((await reader.at(1200))["claude-code"], {
    used: 30,
    at: later(1200).toISOString(),
  });
  assert.deepEqual(reader.reads, [
    "claude-code",
    "codex",
    "codex",
    "claude-code",
    "codex",
  ]);
});

test("repeated throttling moves the next read each time, and an HTTP date sets it too", async (t) => {
  const reader = usage(t);
  reader.answers["claude-code"].push(
    throttled("1148"),
    throttled("Wed, 14 Oct 2026 16:00:00 GMT"),
    40,
  );
  reader.answers.codex.push(1, 2, 3, 4, 5, 6, 7);
  await reader.at(0);
  await reader.at(1200);
  const count = () => reader.reads.filter((p) => p === "claude-code").length;
  assert.equal(count(), 2);
  await reader.at(1800);
  await reader.at(2400);
  await reader.at(3000);
  assert.equal(count(), 2);
  assert.equal((await reader.at(3600))["claude-code"]?.used, 40);
  assert.equal(count(), 3);
});

test("a failure without a usable Retry-After, or an answer without a window, is read again at the next pass", async (t) => {
  for (const failure of [
    throttled(),
    throttled("soon"),
    throttled("Wed, 14 Oct 2026 14:00:00 GMT"),
    new UsageReadError("the usage endpoint answered HTTP 503", { status: 503 }),
    new TypeError("fetch failed"),
    null,
  ]) {
    const reader = usage(t);
    reader.answers["claude-code"].push(failure, 25);
    reader.answers.codex.push(1, 2);
    await reader.at(0);
    assert.match(
      reader.reports[0],
      failure === null
        ? /^usage for claude-code is unreadable: its answer holds no usage window; it is read again next pass$/
        : /^usage for claude-code is unreadable: .+; it is read again next pass$/,
    );
    assert.equal((await reader.at(600))["claude-code"]?.used, 25);
  }
});

test("a good reading outlives failed and skipped reads with its own time, for 20 minutes at most", async (t) => {
  assert.equal(usageFreshMinutes, 20);
  for (const used of [12, 95]) {
    const reader = usage(t);
    reader.answers["claude-code"].push(
      used,
      new UsageReadError("the usage endpoint answered HTTP 500", {
        status: 500,
      }),
      throttled("1800"),
    );
    reader.answers.codex.push(1, 2, 3, 4);
    const reading = { used, at: start.toISOString() };
    assert.deepEqual((await reader.at(0))["claude-code"], reading);
    assert.deepEqual((await reader.at(300))["claude-code"], reading);
    assert.deepEqual((await reader.at(600))["claude-code"], reading);
    // Skipped while throttled, and expired exactly 20 minutes after it was read.
    assert.deepEqual((await reader.at(1200))["claude-code"], reading);
    assert.equal((await reader.at(1201))["claude-code"], null);
    assert.equal(reader.reads.filter((p) => p === "claude-code").length, 3);
  }
});

test("the readings and read deadlines survive a restart", async (t) => {
  const first = usage(t);
  first.answers["claude-code"].push(throttled("1148"));
  first.answers.codex.push(33);
  await first.at(0);
  const recorded = JSON.parse(readFileSync(first.path, "utf8"));
  assert.deepEqual(recorded, {
    "claude-code": { reading: null, nextRead: "2026-10-14T15:19:08.000Z" },
    codex: {
      reading: { used: 33, at: start.toISOString() },
      nextRead: null,
    },
  });

  const second = usage(t, first.path);
  second.answers["claude-code"].push(20);
  second.answers.codex.push(new Error("timed out"));
  assert.deepEqual(await second.at(600), {
    "claude-code": null,
    codex: { used: 33, at: start.toISOString() },
  });
  assert.deepEqual(second.reads, ["codex"]);
  assert.equal((await second.at(1200))["claude-code"]?.used, 20);
});

test("an unreadable usage record starts empty, and one entry's bad fields are dropped", async (t) => {
  const reader = usage(t);
  writeFileSync(reader.path, "{not json");
  reader.answers["claude-code"].push(5);
  reader.answers.codex.push(6);
  await reader.at(0);
  assert.match(
    reader.reports[0],
    /^the usage record is unreadable, so it starts empty: /,
  );

  const partial = usage(t);
  writeFileSync(
    partial.path,
    JSON.stringify({
      "claude-code": {
        reading: { used: "high", at: "now" },
        nextRead: "later",
      },
      codex: { reading: { used: 7, at: start.toISOString() }, nextRead: null },
    }),
  );
  partial.answers["claude-code"].push(new Error("refused"));
  partial.answers.codex.push(new Error("refused"));
  assert.deepEqual(await partial.at(60), {
    "claude-code": null,
    codex: { used: 7, at: start.toISOString() },
  });
  assert.deepEqual(partial.reads, ["claude-code", "codex"]);
});

test("Claude Code's refusals reach the process log with the provider and status, without the token or the answer", async (t) => {
  const credential = join(directory(t), "claude-token");
  writeFileSync(credential, "sk-ant-oat01-secret\n");
  for (const [status, headers, report] of [
    [401, {}, "HTTP 401; it is read again next pass"],
    [
      429,
      { "retry-after": "1148" },
      "HTTP 429; it is next read at 2026-10-14T15:19:08.000Z",
    ],
    [503, {}, "HTTP 503; it is read again next pass"],
  ] as const) {
    const adapter = createRegistry(
      { "claude-code": { credential } },
      fakePorts({
        fetch: async () =>
          new Response('{"error":"sk-ant-oat01-secret body"}', {
            status,
            headers,
          }),
      }).ports,
    ).providers.get("claude-code")!;
    const reports: string[] = [];
    await createUsage({
      providers: ["claude-code"],
      read: () => adapter.readUsage(),
      now: () => start,
      report: (line) => reports.push(line),
      path: join(directory(t), "usage.json"),
    }).read();
    assert.deepEqual(reports, [
      `usage for claude-code is unreadable: UsageReadError: the usage endpoint answered ${report}`,
    ]);
  }
});
