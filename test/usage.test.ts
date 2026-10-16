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

test("a missing, malformed or past Retry-After provides no header deadline", () => {
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
    "9999999999999",
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

test("403 and 429 without a usable Retry-After wait one hour and 20 minutes, from each answer's receipt", async (t) => {
  for (const [status, delay] of [
    [403, 3600],
    [429, 1200],
  ]) {
    for (const retryAfter of [
      undefined,
      "soon",
      "9999999999999",
      "Wed, 14 Oct 2026 14:00:00 GMT",
    ]) {
      const reader = usage(t);
      const refusal = () =>
        new UsageReadError(`HTTP ${status}`, { status, retryAfter });
      reader.answers["claude-code"].push(refusal(), refusal(), 25);
      reader.answers.codex.push(...Array(20).fill(1));
      await reader.at(0);
      for (let seconds = 600; seconds < delay; seconds += 600) {
        await reader.at(seconds);
        assert.equal(reader.reads.filter((p) => p === "claude-code").length, 1);
      }
      await reader.at(delay);
      assert.equal(reader.reads.filter((p) => p === "claude-code").length, 2);
      await reader.at(delay * 2 - 1);
      assert.equal(reader.reads.filter((p) => p === "claude-code").length, 2);
      assert.equal((await reader.at(delay * 2))["claude-code"]?.used, 25);
      assert.equal(reader.reads.filter((p) => p === "claude-code").length, 3);
      assert.equal(
        reader.reads.filter((p) => p === "codex").length,
        delay / 600 + 3,
      );
    }
  }
});

test("unavailable episodes stay quiet across cooldowns and restarts, report changes, and recover only on a numeric reading", async (t) => {
  const first = usage(t);
  const forbidden = () =>
    new UsageReadError("synthetic-secret response-body", { status: 403 });
  first.answers["claude-code"].push(forbidden());
  first.answers.codex.push(1, 2);
  await first.at(0);
  await first.at(600);
  assert.equal(first.reports.length, 1);
  assert.match(
    first.reports[0],
    /claude-code.*HTTP 403.*2026-10-14T16:00:00.000Z/,
  );
  assert.match(first.reports[0], /setup token may lack usage-read permission/);
  assert.match(
    first.reports[0],
    /cached reading.*expires.*fresh launches.*without the percentage gate/,
  );

  const second = usage(t, first.path);
  second.answers["claude-code"].push(
    forbidden(),
    throttled(),
    null,
    null,
    new TypeError("synthetic-secret response-body"),
    new TypeError("different secret"),
    30,
    31,
    forbidden(),
  );
  second.answers.codex.push(...Array(12).fill(2));
  await second.at(1200);
  await second.at(3600);
  await second.at(4200);
  assert.deepEqual(second.reports, []);
  await second.at(7200);
  assert.equal(second.reports.length, 1);
  assert.match(second.reports[0], /HTTP 429.*2026-10-14T17:20:00.000Z/);
  await second.at(8400);
  assert.equal(second.reports.length, 2);
  assert.match(second.reports[1], /no usage window/);
  await second.at(9000);
  assert.equal(second.reports.length, 2);
  await second.at(9600);
  assert.equal(second.reports.length, 3);
  assert.match(second.reports[2], /read failed/);
  await second.at(10200);
  assert.equal(second.reports.length, 3);
  await second.at(10800);
  assert.equal(second.reports.length, 4);
  assert.match(second.reports[3], /claude-code is readable again.*30%/);
  await second.at(11400);
  assert.equal(second.reports.length, 4);
  await second.at(12000);
  assert.equal(second.reports.length, 5);
  assert.match(second.reports[4], /HTTP 403/);
  for (const output of [
    first.reports.join("\n"),
    second.reports.join("\n"),
    readFileSync(first.path, "utf8"),
  ])
    assert.doesNotMatch(
      output,
      /synthetic-secret|response-body|different secret/,
    );
});

test("a provider throttled for 1148 seconds is not read at the next 600-second pass but at the first one after", async (t) => {
  const reader = usage(t);
  reader.answers["claude-code"].push(throttled("1148"), 30);
  reader.answers.codex.push(10, 11, 12);
  assert.deepEqual(await reader.at(0), {
    "claude-code": null,
    codex: { used: 10, at: start.toISOString() },
  });
  assert.equal(reader.reports.length, 1);
  assert.match(
    reader.reports[0],
    /claude-code.*HTTP 429; it is next read at 2026-10-14T15:19:08.000Z/,
  );
  // The other provider reads every pass meanwhile.
  assert.deepEqual(await reader.at(600), {
    "claude-code": null,
    codex: { used: 11, at: later(600).toISOString() },
  });
  assert.deepEqual(reader.reads, ["claude-code", "codex", "codex"]);
  assert.equal(reader.reports.length, 1);
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
  assert.equal(reader.reports.length, 2);
  assert.match(reader.reports[1], /claude-code is readable again/);
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

test("other failures without a usable Retry-After, or answers without a window, are read again at the next pass", async (t) => {
  for (const failure of [
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
        ? /^usage for claude-code is unreadable: its answer holds no usage window; it is read again next pass;/
        : /^usage for claude-code is unreadable: .+; it is read again next pass;/,
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
    "claude-code": {
      reading: null,
      nextRead: "2026-10-14T15:19:08.000Z",
      failure: "http:429",
    },
    codex: {
      reading: { used: 33, at: start.toISOString() },
      nextRead: null,
      failure: null,
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

test("403 and 429 honor delay-seconds and HTTP-date headers across restarts", async (t) => {
  for (const status of [403, 429]) {
    for (const retryAfter of ["1148", "Wed, 14 Oct 2026 15:19:08 GMT"]) {
      const first = usage(t);
      first.answers["claude-code"].push(
        new UsageReadError("refused", { status, retryAfter }),
      );
      first.answers.codex.push(1);
      await first.at(0);
      const second = usage(t, first.path);
      second.answers["claude-code"].push(20);
      second.answers.codex.push(2, 3);
      await second.at(600);
      assert.deepEqual(second.reads, ["codex"]);
      assert.deepEqual(second.reports, []);
      assert.equal((await second.at(1200))["claude-code"]?.used, 20);
      assert.deepEqual(second.reads, ["codex", "claude-code", "codex"]);
    }
  }
});

test("fallback deadlines count from receipt and a replaced credential recovers at the next eligible probe after restart", async (t) => {
  for (const [status, deadline] of [
    [403, 3720],
    [429, 1320],
  ]) {
    const credential = join(directory(t), "claude-token");
    const path = join(directory(t), "usage.json");
    writeFileSync(credential, "fixture-first-secret");
    const clock = { now: start };
    const tokens: string[] = [];
    const reports: string[] = [];
    const adapter = createRegistry(
      { "claude-code": { credential } },
      fakePorts({
        fetch: async (_url, init) => {
          tokens.push(new Headers(init?.headers).get("authorization") ?? "");
          if (tokens.length > 1)
            return new Response('{"five_hour":{"utilization":42}}');
          clock.now = later(120);
          return new Response("fixture-secret-response-body", { status });
        },
      }).ports,
    ).providers.get("claude-code")!;
    const ports = {
      providers: ["claude-code"],
      read: () => adapter.readUsage(),
      now: () => clock.now,
      report: (line: string) => reports.push(line),
      path,
    };
    await createUsage(ports).read();
    writeFileSync(credential, "fixture-replacement-secret");
    const restarted = createUsage(ports);
    for (const seconds of [600, deadline - 1]) {
      clock.now = later(seconds);
      await restarted.read();
      assert.equal(tokens.length, 1);
      assert.equal(reports.length, 1);
    }
    clock.now = later(deadline);
    assert.deepEqual((await restarted.read())["claude-code"], {
      used: 42,
      at: later(deadline).toISOString(),
    });
    assert.deepEqual(tokens, [
      "Bearer fixture-first-secret",
      "Bearer fixture-replacement-secret",
    ]);
    assert.equal(reports.length, 2);
    assert.match(reports[1], /readable again/);
    assert.doesNotMatch(
      reports.join("\n") + readFileSync(path, "utf8"),
      /fixture-.*secret/,
    );
  }
});

test("legacy records without episode metadata retain fresh low and high readings during a persisted cooldown", async (t) => {
  for (const used of [12, 95]) {
    const reader = usage(t);
    const reading = { used, at: start.toISOString() };
    writeFileSync(
      reader.path,
      JSON.stringify({
        "claude-code": { reading, nextRead: "2026-10-14T16:00:00.000Z" },
      }),
    );
    reader.answers.codex.push(1, 2, 3);
    assert.deepEqual((await reader.at(600))["claude-code"], reading);
    assert.deepEqual((await reader.at(1200))["claude-code"], reading);
    assert.equal((await reader.at(1201))["claude-code"], null);
    assert.deepEqual(reader.reads, ["codex", "codex", "codex"]);
    assert.deepEqual(reader.reports, []);
  }
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
    [403, {}, "HTTP 403; it is next read at 2026-10-14T16:00:00.000Z"],
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
    assert.equal(reports.length, 1);
    assert.ok(
      reports[0].includes(
        `usage for claude-code is unreadable: the usage endpoint answered ${report}`,
      ),
    );
    assert.doesNotMatch(reports[0], /sk-ant|secret body/);
  }
});
