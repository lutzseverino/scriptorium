import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { status, type StatusPorts } from "../src/status-command.ts";
import { providerStatus } from "../src/events.ts";
import { UsageReadError } from "../src/providers/usage.ts";
import { directory } from "./fakes.ts";
import { execFileSync } from "node:child_process";

const now = new Date("2026-11-08T12:00:00.000Z");

function fixture(t: TestContext) {
  const root = directory(t);
  const path = join(root, "host.json");
  const state = join(root, "state");
  const config = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "fixtures/host-configuration/valid.json"),
      "utf8",
    ),
  );
  writeFileSync(path, JSON.stringify({ ...config, stateDirectory: state }));
  return { path, state };
}

async function command(args: string[], extra: Partial<StatusPorts> = {}) {
  const output: string[] = [];
  const errors: string[] = [];
  const code = await status(args, {
    now: () => now,
    print: (line: string) => output.push(line),
    error: (line: string) => errors.push(line),
    ...extra,
  });
  return { code, output, errors };
}

test("text and JSON status share the normalized catalog, guidance, effort and defaults", async (t) => {
  const { path, state } = fixture(t);
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.models = {
    effort: "medium",
    default: "claude-work@high",
    retry: "gpt-work",
    review: "codex/gpt-work@xhigh",
    allowed: ["claude-work", "gpt-work", "gpt-unnamed"],
    metadata: {
      "gpt-work": { guidance: "Routine work", effort: "low" },
      "codex/gpt-work": { guidance: "Routine work", effort: "low" },
    },
  };
  writeFileSync(path, JSON.stringify(config));
  const json = await command([path, "--json"]);
  assert.equal(json.code, 0, json.errors.join("\n"));
  const budget = JSON.parse(json.output[0]);
  assert.deepEqual(budget.models, {
    effort: "medium",
    defaults: {
      default: {
        provider: "claude-code",
        model: "claude-work",
        effort: "high",
      },
      retry: { provider: "codex", model: "gpt-work", effort: "low" },
      triage: { provider: "claude-code", model: "claude-work", effort: "high" },
      review: { provider: "codex", model: "gpt-work", effort: "xhigh" },
    },
    catalog: [
      {
        identity: "claude-code/claude-work",
        provider: "claude-code",
        model: "claude-work",
        effectiveEffort: "medium",
      },
      {
        identity: "codex/gpt-unnamed",
        provider: "codex",
        model: "gpt-unnamed",
        effectiveEffort: "medium",
      },
      {
        identity: "codex/gpt-work",
        provider: "codex",
        model: "gpt-work",
        guidance: "Routine work",
        effort: "low",
        effectiveEffort: "low",
      },
    ],
  });
  const text = await command([path]);
  assert.equal(text.code, 0);
  assert.ok(text.output[0].includes(`models=${JSON.stringify(budget.models)}`));
  assert.equal(budget.providers[0].cap, 2);
  assert.equal(budget.providers[0].running, null);
  assert.equal(existsSync(state), false);
});

test("status reports missing work as unavailable, never zero, without creating state", async (t) => {
  const { path, state } = fixture(t);
  const result = await command([path, "--json"]);
  assert.equal(result.code, 0, result.errors.join("\n"));
  const budget = JSON.parse(result.output[0]);
  assert.equal(budget.version, 1);
  assert.equal(budget.observedAt, now.toISOString());
  assert.deepEqual(
    budget.providers.map(
      (provider: { cap: number; running: unknown; free: unknown }) => [
        provider.cap,
        provider.running,
        provider.free,
      ],
    ),
    [
      [2, null, null],
      [1, null, null],
    ],
  );
  assert.equal(budget.providers[0].observations.work.state, "unavailable");
  assert.match(budget.providers[0].observations.work.problem, /missing/);
  assert.equal(budget.providers[0].claimsHeld, null);
  assert.equal(budget.providers[0].nextAction, "inspect-observations");
  assert.equal(existsSync(state), false);
  const text = await command([path]);
  assert.match(text.output[0], /cap=2 running=unavailable free=unavailable/);
  assert.match(text.output[0], /not a launch grant or reservation/);
});

test("a live usage refresh cannot invent work, release an owner hold or apply a resume request", async (t) => {
  const { path, state } = fixture(t);
  mkdirSync(join(state, "requests"), { recursive: true });
  const held = { since: "2026-11-07T12:00:00.000Z", used: 97 };
  writeFileSync(
    join(state, "owner.json"),
    JSON.stringify({
      providers: {
        "claude-code": { hold: held, reserve: null, draining: true },
      },
      applied: [],
    }),
  );
  writeFileSync(
    join(state, "requests", "resume.json"),
    JSON.stringify({ provider: "claude-code", requestedAt: now.toISOString() }),
  );
  const before = readdirSync(state, { recursive: true });
  const ownerBefore = readFileSync(join(state, "owner.json"), "utf8");
  const result = await command([path, "--json", "--live-usage"], {
    readUsage: async () => ({ used: 5, reset: null }),
  });
  assert.equal(result.code, 0, result.errors.join("\n"));
  const provider = JSON.parse(result.output[0]).providers[0];
  assert.deepEqual(provider.usage, {
    state: "known",
    reading: { used: 5, at: now.toISOString() },
  });
  assert.equal(provider.observations.usage.state, "current");
  assert.equal(provider.observations.usage.source, "provider");
  assert.equal(provider.running, null);
  assert.equal(provider.free, null);
  assert.deepEqual(provider.ownerHold, held);
  assert.equal(provider.claimsHeld, true);
  assert.equal(provider.nextAction, "owner-resume");
  assert.equal(provider.launchPermission, "not-established");
  assert.equal(provider.pausedRecoveryUsageHeld, false);
  assert.deepEqual(readdirSync(state, { recursive: true }), before);
  assert.equal(readFileSync(join(state, "owner.json"), "utf8"), ownerBefore);
  assert.equal(existsSync(join(state, "usage.json")), false);
});

test("text and JSON preserve positive free capacity alongside independent persisted holds", async (t) => {
  const { path, state } = fixture(t);
  mkdirSync(state);
  const at = "2026-11-08T11:55:00.000Z";
  const reading = { used: 96, at, reset: "2026-11-08T14:00:00.000Z" };
  const usageHold = { ...reading, since: at, until: reading.reset };
  const control = {
    hold: { since: at, used: 96 },
    reserve: { drainThreshold: 94, since: at, until: reading.reset },
  };
  const provider = providerStatus(
    "claude-code",
    at,
    reading,
    usageHold,
    control,
    { drainThreshold: 90, pauseThreshold: 95, afterDrain: "auto-resume" },
    1,
    2,
  );
  writeFileSync(
    join(state, "status.json"),
    JSON.stringify({
      updatedAt: at,
      providers: [
        {
          ...provider,
          counting: "non-ended-runs",
          cap: 2,
          free: 1,
          retained: 3,
        },
      ],
    }),
  );
  writeFileSync(
    join(state, "usage.json"),
    JSON.stringify({
      "claude-code": {
        reading,
        hold: usageHold,
        nextRead: null,
        failure: null,
      },
    }),
  );
  writeFileSync(
    join(state, "owner.json"),
    JSON.stringify({
      providers: { "claude-code": { ...control, draining: true } },
      applied: [],
    }),
  );
  const before = readdirSync(state).map((file) => [
    file,
    readFileSync(join(state, file), "utf8"),
  ]);
  const result = await command([path, "--json"]);
  assert.equal(result.code, 0, result.errors.join("\n"));
  const budget = JSON.parse(result.output[0]);
  const observed = budget.providers[0];
  assert.deepEqual(
    [
      observed.cap,
      observed.running,
      observed.free,
      observed.paused,
      observed.retained,
    ],
    [2, 1, 1, 2, 3],
  );
  assert.deepEqual(observed.ownerHold, control.hold);
  assert.deepEqual(observed.usageHold, usageHold);
  assert.deepEqual(observed.reserve, control.reserve);
  assert.equal(observed.thresholds.effectiveDrainThreshold, 94);
  assert.equal(observed.claimsHeld, true);
  assert.equal(observed.pauseAtThreshold, true);
  assert.equal(observed.reason, "owner-hold");
  assert.equal(observed.nextAction, "owner-resume");
  assert.deepEqual(observed.observations.work, {
    state: "last-observed",
    source: "status.json",
    at,
  });
  const text = await command([path]);
  assert.match(text.output[0], /cap=2 running=1 free=1 paused=2 retained=3/);
  for (const key of [
    "usage",
    "usageHold",
    "ownerHold",
    "reserve",
    "thresholds",
    "claimsHeld",
    "pauseAtThreshold",
    "drained",
    "reason",
    "nextAction",
    "observations",
  ])
    assert.ok(
      text.output[0].includes(`  ${key}=${JSON.stringify(observed[key])}`),
      key,
    );
  assert.deepEqual(
    readdirSync(state).map((file) => [
      file,
      readFileSync(join(state, file), "utf8"),
    ]),
    before,
  );
});

test("a stopped host's old operational snapshot remains last-observed, including its owner hold", async (t) => {
  const { path, state } = fixture(t);
  mkdirSync(state);
  const at = "2026-11-01T12:00:00.000Z";
  const provider = providerStatus(
    "claude-code",
    at,
    { used: 5, at },
    null,
    { hold: { since: at, used: 97 }, reserve: null },
    { drainThreshold: 90, pauseThreshold: 95, afterDrain: "auto-resume" },
    1,
    0,
    { cap: 2, retained: 1 },
  );
  writeFileSync(
    join(state, "status.json"),
    JSON.stringify({ providers: [provider] }),
  );
  const result = await command([path, "--json"]);
  const observed = JSON.parse(result.output[0]).providers[0];
  assert.equal(observed.running, 1);
  assert.equal(observed.free, 1);
  assert.equal(observed.observations.work.at, at);
  assert.equal(observed.observations.work.state, "last-observed");
  assert.deepEqual(observed.ownerHold, provider.ownerHold);
  assert.equal(observed.observations.owner.source, "status.json");
  assert.equal(observed.usage.state, "unknown");
  assert.match(observed.observations.usage.problem, /expired/);
  assert.equal(observed.claimsHeld, true);
  assert.equal(observed.launchPermission, "not-established");
});

test("CLI dispatch validates configuration and reads status without starting the host", (t) => {
  const { path, state } = fixture(t);
  const stdout = execFileSync(
    process.execPath,
    ["src/main.ts", "status", path, "--json"],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(JSON.parse(stdout).providers[0].running, null);
  assert.equal(existsSync(state), false);
});

for (const failure of ["read-error", "no-window", "http:429"])
  for (const minutes of [10, 21, 181])
    test(`${failure} after ${minutes} minutes preserves usage freshness and the hold deadline without writing`, async (t) => {
      const { path, state } = fixture(t);
      mkdirSync(state);
      const at = "2026-11-08T12:00:00.000Z";
      const reading = { used: 96, at, reset: "2026-11-08T15:00:00.000Z" };
      const hold = { ...reading, since: at, until: reading.reset };
      const original = JSON.stringify({
        "claude-code": { reading, hold, nextRead: null, failure: null },
      });
      writeFileSync(join(state, "usage.json"), original);
      writeFileSync(
        join(state, "owner.json"),
        JSON.stringify({
          providers: {
            "claude-code": { hold: null, reserve: null, draining: false },
          },
        }),
      );
      const result = await command([path, "--json", "--live-usage"], {
        now: () => new Date(now.getTime() + minutes * 60_000),
        readUsage: async () => {
          if (failure === "no-window") return null;
          if (failure === "http:429")
            throw new UsageReadError("private response", { status: 429 });
          throw new Error("private response");
        },
      });
      const provider = JSON.parse(result.output[0]).providers[0];
      assert.equal(provider.usage.state, minutes <= 20 ? "known" : "unknown");
      assert.equal(provider.claimsHeld, minutes < 180);
      assert.equal(provider.usageHold !== null, minutes < 180);
      assert.equal(provider.running, null);
      assert.match(provider.observations.usage.problem, new RegExp(failure));
      if (minutes > 20)
        assert.match(provider.observations.usage.problem, /expired/);
      assert.doesNotMatch(JSON.stringify(result), /private response/);
      assert.equal(readFileSync(join(state, "usage.json"), "utf8"), original);
    });

test("usage backoff is honored and a reserve ends under the host's existing rules", async (t) => {
  const { path, state } = fixture(t);
  mkdirSync(state);
  const at = now.toISOString();
  writeFileSync(
    join(state, "usage.json"),
    JSON.stringify({
      "claude-code": {
        reading: { used: 20, at },
        hold: null,
        nextRead: "2026-11-08T12:10:00.000Z",
        failure: "http:403",
      },
    }),
  );
  const original = JSON.stringify({
    providers: {
      "claude-code": {
        hold: { since: at, used: 97 },
        reserve: { drainThreshold: 94, since: at, until: null },
        draining: true,
      },
    },
  });
  writeFileSync(join(state, "owner.json"), original);
  let reads = 0;
  const result = await command([path, "--json", "--live-usage"], {
    readUsage: async () => {
      reads++;
      return null;
    },
  });
  // Only the other configured provider may be read.
  assert.equal(reads, 1);
  const provider = JSON.parse(result.output[0]).providers[0];
  assert.match(provider.observations.usage.problem, /deferred until/);
  assert.equal(provider.reserve, null);
  assert.equal(provider.thresholds.effectiveDrainThreshold, 90);
  assert.equal(provider.claimsHeld, true);
  assert.equal(readFileSync(join(state, "owner.json"), "utf8"), original);
});

test("a damaged cached reading cannot discard or extend a valid usage hold", async (t) => {
  const { path, state } = fixture(t);
  mkdirSync(state);
  const hold = {
    used: 96,
    at: "2026-11-08T11:30:00.000Z",
    since: "2026-11-08T11:30:00.000Z",
    until: "2026-11-08T13:00:00.000Z",
  };
  const original = JSON.stringify({
    "claude-code": {
      reading: { used: 96, at: "bad timestamp" },
      hold,
      nextRead: null,
      failure: null,
    },
  });
  writeFileSync(join(state, "usage.json"), original);
  for (const mode of ["offline", "failed", "no-window", "high"]) {
    const live = mode !== "offline";
    const result = await command(
      [path, "--json", ...(live ? ["--live-usage"] : [])],
      {
        readUsage: async () => {
          if (mode === "failed") throw new Error("private response");
          return mode === "high"
            ? { used: 96, reset: "2026-11-08T15:00:00.000Z" }
            : null;
        },
      },
    );
    const provider = JSON.parse(result.output[0]).providers[0];
    assert.equal(provider.usageHold.since, hold.since, mode);
    assert.equal(provider.usageHold.until, hold.until, mode);
    assert.equal(provider.claimsHeld, true, mode);
    assert.equal(provider.pauseAtThreshold, true, mode);
    assert.equal(provider.pausedRecoveryUsageHeld, true, mode);
    assert.equal(provider.usage.state, mode === "high" ? "known" : "unknown");
    assert.equal(readFileSync(join(state, "usage.json"), "utf8"), original);
  }
});

for (const damaged of [
  "unreadable",
  "negative",
  "future",
  "legacy",
  "duplicate",
])
  test(`${damaged} work observations cannot fabricate free capacity`, async (t) => {
    const { path, state } = fixture(t);
    mkdirSync(state);
    const provider = providerStatus(
      "claude-code",
      now.toISOString(),
      null,
      null,
      null,
      { drainThreshold: 90, pauseThreshold: 95, afterDrain: "auto-resume" },
      1,
      0,
      { cap: 2, retained: 0 },
    );
    if (damaged === "unreadable") mkdirSync(join(state, "status.json"));
    else {
      if (damaged === "negative") provider.running = -1;
      if (damaged === "future") provider.observedAt = "2027-01-01T00:00:00Z";
      if (damaged === "legacy") delete provider.counting;
      writeFileSync(
        join(state, "status.json"),
        JSON.stringify({
          providers:
            damaged === "duplicate" ? [provider, provider] : [provider],
        }),
      );
    }
    const result = await command([path, "--json"]);
    const observed = JSON.parse(result.output[0]).providers[0];
    assert.equal(observed.running, null);
    assert.equal(observed.free, null);
    assert.equal(observed.observations.work.state, "unavailable");
    assert.match(
      observed.observations.work.problem,
      /unreadable|inconsistent|legacy/,
    );
  });

test("committed event observations are a fallback, but pending transactions require host recovery", async (t) => {
  const { path, state } = fixture(t);
  mkdirSync(state);
  const provider = providerStatus(
    "claude-code",
    now.toISOString(),
    null,
    null,
    { hold: { since: now.toISOString(), used: null }, reserve: null },
    { drainThreshold: 90, pauseThreshold: 95, afterDrain: "owner-resume" },
    1,
    0,
    { cap: 2, retained: 1 },
  );
  for (const pending of [false, true]) {
    const original = JSON.stringify({
      version: 1,
      providers: [provider],
      ...(pending && { pending: { text: "private bytes", offset: 0 } }),
    });
    writeFileSync(join(state, "events-state.json"), original);
    const result = await command([path, "--json"]);
    const observed = JSON.parse(result.output[0]).providers[0];
    assert.equal(observed.running, pending ? null : 1);
    assert.equal(observed.claimsHeld, true);
    assert.match(
      observed.observations.work.problem,
      pending ? /pending operational transaction/ : /status.json: missing/,
    );
    assert.equal(
      readFileSync(join(state, "events-state.json"), "utf8"),
      original,
    );
    assert.equal(existsSync(join(state, "events.jsonl")), false);
    assert.doesNotMatch(result.output[0], /private bytes/);
  }
});

test("malformed commands and invalid configuration fail before observing providers", async (t) => {
  const { path } = fixture(t);
  for (const args of [
    [],
    [path, "--force"],
    [path, "--json", "--json"],
    [path, "other.json"],
  ])
    assert.equal((await command(args)).code, 2);
  writeFileSync(path, "{}");
  const result = await command([path, "--live-usage"], {
    readUsage: async () => {
      throw new Error("must not read usage");
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.errors[0], /invalid/);
});

test("unreadable policy records and incomplete owner entries never erase last-observed owner holds", async (t) => {
  const { path, state } = fixture(t);
  mkdirSync(state);
  const provider = providerStatus(
    "claude-code",
    now.toISOString(),
    { used: 3, at: now.toISOString() },
    null,
    { hold: { since: now.toISOString(), used: 97 }, reserve: null },
    { drainThreshold: 90, pauseThreshold: 95, afterDrain: "owner-resume" },
    1,
    0,
    { cap: 2, retained: 0 },
  );
  writeFileSync(
    join(state, "status.json"),
    JSON.stringify({ providers: [provider] }),
  );
  writeFileSync(join(state, "usage.json"), "private invalid usage bytes");
  for (const owner of [
    "private invalid owner bytes",
    JSON.stringify({ providers: { "claude-code": {} } }),
  ]) {
    writeFileSync(join(state, "owner.json"), owner);
    const result = await command([path, "--json", "--live-usage"], {
      readUsage: async () => ({ used: 1, reset: null }),
    });
    const observed = JSON.parse(result.output[0]).providers[0];
    assert.deepEqual(observed.ownerHold, provider.ownerHold);
    assert.equal(observed.claimsHeld, true);
    assert.match(
      observed.observations.owner.problem,
      /unreadable|inconsistent/,
    );
    assert.doesNotMatch(result.output[0], /private invalid/);
    assert.equal(readFileSync(join(state, "owner.json"), "utf8"), owner);
  }
});
