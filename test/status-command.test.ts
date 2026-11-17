import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { status, type StatusPorts } from "../src/status-command.ts";
import {
  hostStatus,
  type ConfigurationCoverage,
  type ModelPolicyCoverage,
  type UnresolvedRun,
} from "../src/status.ts";
import {
  decideFactory,
  type Issue,
  type Run,
  type Snapshot,
} from "../src/factory.ts";
import { createRegistry } from "../src/providers.ts";
import { providerStatus } from "../src/events.ts";
import { UsageReadError, type ReportedWindow } from "../src/providers/usage.ts";
import { credentialHealth } from "../src/credentials.ts";
import { directory } from "./fakes.ts";
import { execFileSync } from "node:child_process";

const now = new Date("2026-11-08T12:00:00.000Z");
const valid: ConfigurationCoverage = {
  state: "valid",
  version: 3,
  runKinds: ["implement"],
};
const policy: ModelPolicyCoverage = {
  state: "read",
  path: ".scriptorium/model-policy.json",
};
const legacyPolicy: ModelPolicyCoverage = {
  state: "read",
  path: ".github/factory-model-policy.json",
};

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

test("status reports whether an upload credential is configured without reading or exposing its source", async (t) => {
  const { path } = fixture(t);
  const config = JSON.parse(readFileSync(path, "utf8"));
  for (const source of [
    undefined,
    { file: "/unreadable-upload-source" },
    { command: ["/never-run-upload-command", "private-argument"] },
  ]) {
    writeFileSync(
      path,
      JSON.stringify({ ...config, attachmentUploadCredential: source }),
    );
    const json = await command([path, "--json"]);
    assert.equal(json.code, 0, json.errors.join("\n"));
    assert.equal(
      JSON.parse(json.output[0]).attachmentUploadCredential.configured,
      source !== undefined,
    );
    const text = await command([path]);
    assert.equal(text.code, 0, text.errors.join("\n"));
    assert.match(
      text.output.join("\n"),
      new RegExp(
        `attachment upload credential configured=${source !== undefined}`,
      ),
    );
    assert.doesNotMatch(
      [...json.output, ...text.output].join("\n"),
      /unreadable-upload-source|never-run-upload-command|private-argument/,
    );
  }
});

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

test("text and JSON show each provider's windows and its spare usage, or why it is unknown", async (t) => {
  const { path, state } = fixture(t);
  mkdirSync(state);
  const at = "2026-11-08T11:55:00.000Z";
  // Half of each window has elapsed at `now`.
  const week = (used: number) => ({
    used,
    reset: "2026-11-12T00:00:00.000Z",
    minutes: 10080,
  });
  const session = (used: number) => ({
    used,
    reset: "2026-11-08T14:30:00.000Z",
    minutes: 300,
  });
  const entry = (windows: ReportedWindow[], read = at) => ({
    reading: {
      used: Math.max(...windows.map((window) => window.used)),
      at: read,
      windows,
    },
    hold: null,
    nextRead: null,
    failure: null,
  });
  const record = (claude: object, codex: object) =>
    writeFileSync(
      join(state, "usage.json"),
      JSON.stringify({ "claude-code": claude, codex }),
    );
  const spare = async (extra: Partial<StatusPorts> = {}) => {
    const result = await command(
      [path, "--json", ...(extra.readUsage ? ["--live-usage"] : [])],
      extra,
    );
    assert.equal(result.code, 0, result.errors.join("\n"));
    return JSON.parse(result.output[0]).providers.map(
      (provider: { spareUsage: unknown }) => provider.spareUsage,
    );
  };
  const pace = (used: number) => ({
    used,
    minutes: 10080,
    reset: "2026-11-12T00:00:00.000Z",
    elapsed: 50,
  });

  record(entry([session(40), week(31)]), entry([session(10), week(60)]));
  const json = await command([path, "--json"]);
  const providers = JSON.parse(json.output[0]).providers;
  assert.deepEqual(providers[0].usage, {
    state: "known",
    reading: { used: 40, at, windows: [session(40), week(31)] },
  });
  assert.deepEqual(
    providers.map((provider: { spareUsage: unknown }) => provider.spareUsage),
    [
      { state: "yes", pace: pace(31) },
      { state: "no", reason: "over-pace", pace: pace(60) },
    ],
  );
  const text = (await command([path])).output[0];
  for (const provider of providers)
    for (const key of ["usage", "spareUsage"])
      assert.ok(
        text.includes(`  ${key}=${JSON.stringify(provider[key])}`),
        key,
      );

  // A shorter window at the drain threshold, and a reading with no window
  // that has a length.
  record(
    entry([session(90), week(31)]),
    entry([{ used: 10, reset: "2026-11-12T00:00:00.000Z", minutes: null }]),
  );
  assert.deepEqual(await spare(), [
    {
      state: "no",
      reason: "shorter-window-at-drain-threshold",
      pace: pace(31),
    },
    { state: "unknown", reason: "no-pace-window" },
  ]);

  // A stale reading and a record from before readings kept windows.
  record(entry([week(10)], "2026-11-08T11:39:59.000Z"), {
    ...entry([week(10)]),
    reading: { used: 10, at },
  });
  assert.deepEqual(await spare(), [
    { state: "unknown", reason: "no-fresh-reading" },
    { state: "unknown", reason: "no-pace-window" },
  ]);

  // A live read replaces the stale reading with its own windows.
  assert.deepEqual(
    await spare({
      readUsage: async () => ({
        used: 20,
        reset: "2026-11-12T00:00:00.000Z",
        windows: [week(20)],
      }),
    }),
    [
      { state: "yes", pace: pace(20) },
      { state: "yes", pace: pace(20) },
    ],
  );

  // Without a usage record, the status file's snapshot keeps the windows.
  rmSync(join(state, "usage.json"));
  const reading = { used: 31, at, windows: [session(12), week(31)] };
  writeFileSync(
    join(state, "status.json"),
    JSON.stringify({
      updatedAt: at,
      providers: [
        providerStatus(
          "claude-code",
          at,
          reading,
          null,
          null,
          { drainThreshold: 90, pauseThreshold: 95, afterDrain: "auto-resume" },
          0,
          0,
        ),
      ],
    }),
  );
  const fallback = JSON.parse((await command([path, "--json"])).output[0])
    .providers[0];
  assert.deepEqual(fallback.usage, { state: "known", reading });
  assert.deepEqual(fallback.spareUsage, { state: "yes", pace: pace(31) });
});

// A host that declares `codex/gpt-narrow` narrower than
// `claude-code/claude-broad`, with each provider's usage, running work and
// owner control written as a pass leaves them. Half of the week has elapsed
// at `now`.
type PairFacts = {
  usage: Record<string, ReturnType<typeof weekly> | null>;
  running?: Record<string, number>;
  owners?: Snapshot["owners"];
};

function weekly(used: number, at = "2026-11-08T11:55:00.000Z") {
  const reset = "2026-11-12T00:00:00.000Z";
  return { used, at, reset, windows: [{ used, reset, minutes: 10080 }] };
}

const pairPolicy = {
  drainThreshold: 90,
  pauseThreshold: 95,
  afterDrain: "auto-resume" as const,
};

function pairFixture(t: TestContext) {
  const { path, state } = fixture(t);
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.models = {
    effort: "high",
    default: "claude-sonnet-5-5",
    retry: "claude-opus-5-5@xhigh",
    metadata: {
      "codex/gpt-narrow": { narrowerThan: ["claude-code/claude-broad"] },
      "claude-code/claude-broad": { effort: "xhigh" },
    },
  };
  writeFileSync(path, JSON.stringify(config));
  mkdirSync(state);
  const write = ({ usage, running = {}, owners = {} }: PairFacts) => {
    const at = "2026-11-08T11:55:00.000Z";
    const caps: Record<string, number> = { "claude-code": 2, codex: 1 };
    writeFileSync(
      join(state, "status.json"),
      JSON.stringify({
        updatedAt: at,
        providers: Object.entries(caps).map(([provider, cap]) => ({
          ...providerStatus(
            provider,
            at,
            usage[provider] ?? null,
            null,
            owners[provider] ?? null,
            pairPolicy,
            running[provider] ?? 0,
            0,
          ),
          counting: "non-ended-runs",
          cap,
          free: Math.max(0, cap - (running[provider] ?? 0)),
          retained: 0,
        })),
      }),
    );
    writeFileSync(
      join(state, "usage.json"),
      JSON.stringify(
        Object.fromEntries(
          Object.keys(caps).map((provider) => [
            provider,
            {
              reading: usage[provider] ?? null,
              hold: null,
              nextRead: null,
              failure: null,
            },
          ]),
        ),
      ),
    );
    writeFileSync(
      join(state, "owner.json"),
      JSON.stringify({
        providers: Object.fromEntries(
          Object.keys(caps).map((provider) => [
            provider,
            {
              hold: owners[provider]?.hold ?? null,
              reserve: owners[provider]?.reserve ?? null,
              draining: false,
            },
          ]),
        ),
        applied: [],
      }),
    );
  };
  const read = async (extra: Partial<StatusPorts> = {}) => {
    const live = extra.readUsage ? ["--live-usage"] : [];
    const json = await command([path, "--json", ...live], extra);
    assert.equal(json.code, 0, json.errors.join("\n"));
    const text = await command([path, ...live], extra);
    assert.equal(text.code, 0, text.errors.join("\n"));
    const budget = JSON.parse(json.output[0]);
    const lines = text.output[0]
      .split("\n")
      .filter((line) => line.startsWith("narrower "));
    return { picks: budget.narrowerModels, lines, config };
  };
  return { path, state, write, read, config };
}

const narrow = { provider: "codex", model: "gpt-narrow", effort: "high" };
const broad = {
  provider: "claude-code",
  model: "claude-broad",
  effort: "xhigh",
};
const pace = (used: number) => ({
  used,
  minutes: 10080,
  reset: "2026-11-12T00:00:00.000Z",
  elapsed: 50,
});

test("text and JSON show a narrower model's stand-in or chosen model, with why, and unknown usage as unknown", async (t) => {
  const { write, read } = pairFixture(t);
  const entry = (pick: object) => [
    {
      model: "codex/gpt-narrow",
      narrowerThan: ["claude-code/claude-broad"],
      pick,
    },
  ];

  // The broader provider has spare usage.
  write({ usage: { codex: weekly(20), "claude-code": weekly(30) } });
  let shown = await read();
  assert.deepEqual(
    shown.picks,
    entry({
      state: "stand-in",
      runs: broad,
      reason: { kind: "spare usage", used: 30, elapsed: 50 },
      declined: [],
    }),
  );
  assert.deepEqual(shown.lines, [
    "narrower codex/gpt-narrow: runs claude-code/claude-broad@xhigh; stand-in: spare usage (30% used, 50% elapsed)",
  ]);

  // The chosen provider cannot launch; the broader one is over pace but
  // below drain.
  write({ usage: { codex: weekly(92), "claude-code": weekly(60) } });
  shown = await read();
  const drained = "codex usage 92% is at or above the 90% drain threshold";
  assert.deepEqual(
    shown.picks,
    entry({
      state: "stand-in",
      runs: broad,
      reason: { kind: "chosen provider cannot launch", reason: drained },
      declined: [],
    }),
  );
  assert.deepEqual(shown.lines, [
    `narrower codex/gpt-narrow: runs claude-code/claude-broad@xhigh; stand-in: chosen provider cannot launch (${drained})`,
  ]);

  // The broader provider is over pace, and the chosen one can launch.
  write({ usage: { codex: weekly(20), "claude-code": weekly(60) } });
  shown = await read();
  assert.deepEqual(
    shown.picks,
    entry({
      state: "chosen model",
      runs: narrow,
      chosenCannotLaunch: null,
      declined: [
        {
          broader: "claude-code/claude-broad",
          kind: "no spare usage",
          spareUsage: { state: "no", reason: "over-pace", pace: pace(60) },
        },
      ],
    }),
  );
  assert.deepEqual(shown.lines, [
    "narrower codex/gpt-narrow: runs codex/gpt-narrow@high; chosen model: claude-code/claude-broad has no spare usage (over-pace, 60% used, 50% elapsed)",
  ]);

  // The broader provider runs its cap.
  write({
    usage: { codex: weekly(20), "claude-code": weekly(30) },
    running: { "claude-code": 2 },
  });
  shown = await read();
  const capped = "claude-code already runs its cap of 2 agents";
  assert.deepEqual(
    shown.picks,
    entry({
      state: "chosen model",
      runs: narrow,
      chosenCannotLaunch: null,
      declined: [
        {
          broader: "claude-code/claude-broad",
          kind: "cannot launch",
          reason: capped,
        },
      ],
    }),
  );
  assert.deepEqual(shown.lines, [
    `narrower codex/gpt-narrow: runs codex/gpt-narrow@high; chosen model: claude-code/claude-broad cannot launch (${capped})`,
  ]);

  // A stale broader reading is unknown usage, never spare, even while the
  // chosen provider cannot launch.
  write({
    usage: {
      codex: weekly(92),
      "claude-code": weekly(10, "2026-11-08T11:39:59.000Z"),
    },
  });
  shown = await read();
  assert.deepEqual(
    shown.picks,
    entry({
      state: "chosen model",
      runs: narrow,
      chosenCannotLaunch: drained,
      declined: [
        {
          broader: "claude-code/claude-broad",
          kind: "no spare usage",
          spareUsage: { state: "unknown", reason: "no-fresh-reading" },
        },
      ],
    }),
  );
  assert.deepEqual(shown.lines, [
    `narrower codex/gpt-narrow: runs codex/gpt-narrow@high; chosen model: claude-code/claude-broad spare usage unknown (no-fresh-reading); the chosen provider cannot launch either (${drained})`,
  ]);

  // A live read replaces that stale reading.
  shown = await read({
    readUsage: async (provider) =>
      provider === "claude-code"
        ? {
            used: 25,
            reset: "2026-11-12T00:00:00.000Z",
            windows: [
              { used: 25, reset: "2026-11-12T00:00:00.000Z", minutes: 10080 },
            ],
          }
        : null,
  });
  assert.deepEqual(
    shown.picks,
    entry({
      state: "stand-in",
      runs: broad,
      reason: { kind: "spare usage", used: 25, elapsed: 50 },
      declined: [],
    }),
  );
});

test("a narrower model's pick is unknown while status cannot establish a fact the stand-in step reads", async (t) => {
  const { state, write, read } = pairFixture(t);
  write({ usage: { codex: weekly(20), "claude-code": weekly(30) } });
  rmSync(join(state, "status.json"));
  rmSync(join(state, "owner.json"));
  const { picks, lines } = await read();
  const unavailable = [
    "codex work",
    "codex owner control",
    "claude-code work",
    "claude-code owner control",
  ];
  assert.deepEqual(picks, [
    {
      model: "codex/gpt-narrow",
      narrowerThan: ["claude-code/claude-broad"],
      pick: { state: "unknown", unavailable },
    },
  ]);
  assert.deepEqual(lines, [
    `narrower codex/gpt-narrow: pick unknown; unavailable: ${unavailable.join(", ")}`,
  ]);
});

test("the status pick and the factory's launch decision agree on one snapshot", async (t) => {
  const { write, read, config } = pairFixture(t);
  const registry = createRegistry(config.providers, config.models);
  const now = "2026-11-08T12:00:00.000Z";
  const owner = { kind: "user" as const, login: "owner", role: "admin" };
  const ready: Issue = {
    number: 4,
    createdAt: "2026-11-01T00:00:00Z",
    labels: ["state:ready", "model:gpt-narrow"],
    ready: { at: "2026-11-01T00:00:00Z", actor: owner },
    editedAt: null,
    contractHold: null,
    nativeParent: null,
    latestLink: null,
    linkAdditions: null,
    subIssues: [],
    blockedBy: [],
  };
  const cases: PairFacts[] = [
    { usage: { codex: weekly(20), "claude-code": weekly(30) } },
    { usage: { codex: weekly(92), "claude-code": weekly(60) } },
    { usage: { codex: weekly(20), "claude-code": weekly(60) } },
    {
      usage: { codex: weekly(20), "claude-code": weekly(30) },
      running: { "claude-code": 2 },
    },
    {
      usage: { codex: weekly(20), "claude-code": weekly(30) },
      owners: {
        "claude-code": { hold: { since: now, used: 91 }, reserve: null },
      },
    },
    {
      usage: { "claude-code": weekly(60) },
      owners: { codex: { hold: { since: now, used: 91 }, reserve: null } },
    },
  ];
  for (const facts of cases) {
    write(facts);
    const [{ pick }] = (await read()).picks;
    const runs: Run[] = Object.entries(facts.running ?? {}).flatMap(
      ([provider, count]) =>
        Array.from({ length: count }, (_, index) => ({
          repository: "acme/gadgets",
          issue: 90 + index,
          provider,
          model: provider === "codex" ? "gpt-narrow" : "claude-broad",
          effort: "high",
          continuation: { attempt: 1 },
          startedAt: "2026-11-08T11:00:00Z",
          log: `/srv/factory/logs/issue-${90 + index}.log`,
          exited: false,
          ended: null,
        })),
    );
    const snapshot: Snapshot = {
      now,
      repositories: [
        {
          name: "acme/widgets",
          configuration: {
            version: 3,
            labels: {
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
            },
            contractResult: {
              marker: "repo-canon:issue-contract-state",
              author: "github-actions[bot]",
            },
            modelLabelPrefix: "model:",
            runKinds: {
              implement: { skill: "implement", arguments: "#{issue}" },
            },
          },
          authorization: { authorizedRoles: ["admin"], neverAuthorize: [] },
          paused: null,
          issues: [ready],
          claims: [],
          modelPolicy: null,
        },
      ],
      runs,
      usage: facts.usage,
      holds: {},
      owners: facts.owners ?? {},
      settings: {
        defaultModel: "claude-sonnet-5-5",
        retryModel: "claude-opus-5-5@xhigh",
        caps: { "claude-code": 2, codex: 1 },
        drainThreshold: pairPolicy.drainThreshold,
        pauseThreshold: pairPolicy.pauseThreshold,
        timeLimitMinutes: 240,
      },
    };
    const decisions = decideFactory(snapshot, registry);
    const launch = decisions.find(
      (decision) => decision.kind === "launch" && decision.issue === 4,
    );
    const label = JSON.stringify(facts);
    if (pick.state === "chosen model" && pick.chosenCannotLaunch !== null) {
      assert.equal(launch, undefined, label);
      continue;
    }
    assert.ok(launch?.kind === "launch", label);
    assert.deepEqual(
      {
        provider: launch.provider,
        model: launch.model,
        effort: launch.effort,
        standIn: launch.standIn?.reason ?? null,
      },
      {
        ...pick.runs,
        standIn: pick.state === "stand-in" ? pick.reason : null,
      },
      label,
    );
  }
});

test("a host with no pair shows no narrower model and otherwise unchanged text", async (t) => {
  const { path } = fixture(t);
  const json = await command([path, "--json"]);
  assert.deepEqual(JSON.parse(json.output[0]).narrowerModels, []);
  const text = (await command([path])).output[0];
  assert.doesNotMatch(text, /^narrower /m);
  const lines = text.split("\n");
  assert.ok(lines[1].startsWith("models="));
  assert.ok(lines[2].startsWith("host: implement"));
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

test("text and JSON project the host's shared implement counts with current limits and honest provenance", async (t) => {
  const { path, state } = fixture(t);
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.repositories = ["acme/widgets", "acme/gadgets", "acme/empty"];
  const runs: Run[] = [
    {
      repository: "acme/widgets",
      issue: 1,
      provider: "codex",
      model: "gpt-work",
      effort: "high",
      continuation: { attempt: 1 },
      startedAt: now.toISOString(),
      log: "/tmp/log",
      exited: false,
      ended: null,
    },
  ];
  runs.push({
    ...runs[0],
    repository: "acme/gadgets",
    issue: 2,
    provider: "claude-code",
  });
  runs.push({
    ...runs[0],
    issue: 3,
    continuation: { attempt: 1, runKind: "review" },
  });
  runs.push({
    ...runs[0],
    issue: 4,
    exited: true,
    ended: {
      paused: {
        cause: "usage limit",
        reset: null,
        at: now.toISOString(),
        until: now.toISOString(),
      },
    },
  });
  const snapshot = hostStatus(
    now.toISOString(),
    config.repositories.map((name: string) => ({
      name,
      paused: null,
      configuration: valid,
      modelPolicy: policy,
    })),
    [],
    [],
    undefined,
    runs,
  );
  mkdirSync(state);
  writeFileSync(join(state, "status.json"), JSON.stringify(snapshot));
  const before = readFileSync(join(state, "status.json"), "utf8");
  for (const implement of [
    undefined,
    { total: 2, perRepository: 1 },
    { total: 5, perRepository: 3 },
    { total: 0 },
  ]) {
    writeFileSync(path, JSON.stringify({ ...config, implement }));
    const result = await command([path, "--json"]);
    const { capacity } = JSON.parse(result.output[0]);
    assert.equal(capacity.observation.state, "last-observed");
    assert.equal(capacity.observation.at, now.toISOString());
    assert.deepEqual(capacity.host.runKinds, {
      implement: 2,
      triage: 0,
      review: 1,
    });
    assert.deepEqual(capacity.host.implement, {
      limit: implement?.total ?? null,
      running: 2,
      free: implement ? Math.max(0, implement.total - 2) : null,
    });
    assert.equal(capacity.repositories[0].implement.running, 1);
    assert.equal(capacity.repositories[2].implement.running, 0);
    assert.equal(
      capacity.repositories[0].implement.free,
      implement?.perRepository === undefined
        ? null
        : implement.perRepository - 1,
    );
    const text = await command([path]);
    assert.match(text.output[0], /host: implement limit=.*running=2/);
    assert.match(text.output[0], /acme\/widgets: implement limit=.*running=1/);
    assert.ok(
      text.output[0].includes(
        `capacity observation=${JSON.stringify(capacity.observation)}`,
      ),
    );
    assert.equal(readFileSync(join(state, "status.json"), "utf8"), before);
  }
  // Neither live usage nor a pending transaction can establish work capacity.
  writeFileSync(
    join(state, "events-state.json"),
    JSON.stringify({ version: 1, pending: {} }),
  );
  const pending = JSON.parse(
    (
      await command([path, "--json", "--live-usage"], {
        readUsage: async () => ({ used: 1, reset: null }),
      })
    ).output[0],
  );
  assert.equal(pending.capacity.host.implement.running, null);
  assert.equal(pending.capacity.host.implement.free, null);
  assert.equal(pending.capacity.observation.state, "unavailable");
});

for (const fault of [
  "missing",
  "legacy",
  "future",
  "inconsistent",
  "duplicate",
  "unreadable",
  "new repository",
])
  test(`implement capacity is unavailable for ${fault} observations`, async (t) => {
    const { path, state } = fixture(t);
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.implement = { total: 2, perRepository: 1 };
    config.repositories = ["acme/widgets"];
    writeFileSync(path, JSON.stringify(config));
    mkdirSync(state);
    const snapshot = hostStatus(
      now.toISOString(),
      [
        {
          name: "acme/widgets",
          paused: null,
          configuration: valid,
          modelPolicy: policy,
        },
      ],
      [],
    );
    if (fault === "future")
      snapshot.capacity.observedAt = "2100-01-01T00:00:00Z";
    if (fault === "inconsistent") snapshot.capacity.host.runKinds.implement = 1;
    if (fault === "duplicate")
      snapshot.capacity.repositories.push(snapshot.capacity.repositories[0]);
    if (fault === "new repository") snapshot.capacity.repositories = [];
    if (fault === "unreadable") mkdirSync(join(state, "status.json"));
    else if (fault !== "missing")
      writeFileSync(
        join(state, "status.json"),
        JSON.stringify(fault === "legacy" ? {} : snapshot),
      );
    const capacity = JSON.parse(
      (await command([path, "--json"])).output[0],
    ).capacity;
    assert.equal(capacity.observation.state, "unavailable");
    for (const counts of [capacity.host, ...capacity.repositories]) {
      assert.equal(counts.runKinds, null);
      assert.equal(counts.implement.running, null);
      assert.equal(counts.implement.free, null);
    }
    assert.equal(capacity.host.implement.limit, 2);
    assert.equal(capacity.repositories[0].implement.limit, 1);
  });

// A status file the factory's writer produces for the fixture's repositories,
// one valid and running with its model policy at the new path, and one paused
// on its own inputs with its policy at the old path.
function coverageSnapshot(repositories: string[]) {
  return hostStatus(
    now.toISOString(),
    repositories.map((name, index) =>
      index === 1
        ? {
            name,
            paused: {
              cause: "repository-input" as const,
              reason: "it has no .scriptorium/Dockerfile",
            },
            configuration: valid,
            modelPolicy: legacyPolicy,
          }
        : { name, paused: null, configuration: valid, modelPolicy: policy },
    ),
    [],
  );
}

test("coverage projects the status file's repository entries, as text and JSON, through a pending transaction", async (t) => {
  const { path, state } = fixture(t);
  const config = JSON.parse(readFileSync(path, "utf8"));
  mkdirSync(state);
  writeFileSync(
    join(state, "status.json"),
    JSON.stringify(coverageSnapshot(config.repositories)),
  );
  // A pending transaction concerns provider work, not coverage.
  writeFileSync(
    join(state, "events-state.json"),
    JSON.stringify({ version: 1, pending: {} }),
  );
  const { coverage } = JSON.parse((await command([path, "--json"])).output[0]);
  assert.deepEqual(coverage.observation, {
    state: "last-observed",
    source: "status.json",
    at: now.toISOString(),
  });
  assert.deepEqual(
    coverage.repositories,
    config.repositories.map((repository: string, index: number) => ({
      repository,
      configuration: valid,
      modelPolicy: index === 1 ? legacyPolicy : policy,
      paused:
        index === 1
          ? {
              cause: "repository-input",
              reason: "it has no .scriptorium/Dockerfile",
            }
          : null,
    })),
  );
  const text = (await command([path])).output[0].split("\n");
  for (const {
    repository,
    configuration,
    modelPolicy,
    paused,
  } of coverage.repositories)
    assert.ok(
      text.includes(
        `${repository}: configuration=${JSON.stringify(configuration)} modelPolicy=${JSON.stringify(modelPolicy)} paused=${paused === null ? "none" : JSON.stringify(paused)}`,
      ),
      text.join("\n"),
    );
  assert.ok(
    text.includes(
      `coverage observation=${JSON.stringify(coverage.observation)}`,
    ),
  );
});

for (const fault of [
  "missing",
  "unreadable",
  "future",
  "legacy",
  "inconsistent pause",
  "inconsistent configuration",
  "invalid configuration while running",
  "legacy model policy",
  "unknown model policy path",
  "rejected model policy while running",
  "model policy read for version 2",
  "model policy not read for version 3",
  "model policy read without the configuration",
  "duplicate",
  "new repository",
])
  test(`coverage is unavailable for a ${fault} status file`, async (t) => {
    const { path, state } = fixture(t);
    const config = JSON.parse(readFileSync(path, "utf8"));
    mkdirSync(state);
    const snapshot = coverageSnapshot(config.repositories);
    const [first, second] = snapshot.repositories as Record<string, unknown>[];
    if (fault === "future") snapshot.updatedAt = "2100-01-01T00:00:00Z";
    if (fault === "legacy")
      for (const entry of snapshot.repositories as Record<string, unknown>[]) {
        delete entry.configuration;
        delete entry.cause;
      }
    if (fault === "inconsistent pause") second.cause = "provider";
    if (fault === "inconsistent configuration")
      first.configuration = { state: "valid", version: 2, runKinds: [] };
    if (fault === "invalid configuration while running")
      first.configuration = { state: "invalid", problem: "broken" };
    if (fault === "legacy model policy") delete first.modelPolicy;
    if (fault === "unknown model policy path")
      first.modelPolicy = { state: "read", path: ".factory/model-policy.json" };
    if (fault === "rejected model policy while running")
      first.modelPolicy = { state: "rejected", problem: "broken" };
    if (fault === "model policy read for version 2")
      first.configuration = { ...valid, version: 2 };
    if (fault === "model policy not read for version 3")
      first.modelPolicy = { state: "not-read" };
    if (fault === "model policy read without the configuration")
      second.configuration = { state: "not-read", problem: "no clone" };
    if (fault === "duplicate")
      snapshot.repositories.push(snapshot.repositories[0]);
    if (fault === "new repository") snapshot.repositories.pop();
    if (fault === "unreadable") mkdirSync(join(state, "status.json"));
    else if (fault !== "missing")
      writeFileSync(join(state, "status.json"), JSON.stringify(snapshot));
    const json = (await command([path, "--json"])).output[0];
    const { coverage } = JSON.parse(json);
    assert.equal(coverage.observation.state, "unavailable");
    assert.equal(coverage.observation.at, null);
    assert.match(
      coverage.observation.problem,
      fault === "missing"
        ? /^missing record$/
        : fault === "unreadable"
          ? /^unreadable record$/
          : /^missing, legacy or inconsistent coverage observation$/,
    );
    assert.deepEqual(
      coverage.repositories,
      config.repositories.map((repository: string) => ({
        repository,
        configuration: null,
        modelPolicy: null,
        paused: null,
      })),
    );
    const text = (await command([path])).output[0];
    for (const repository of config.repositories)
      assert.ok(
        text.includes(
          `${repository}: configuration=unavailable modelPolicy=unavailable paused=unavailable`,
        ),
        text,
      );
  });

// A status file the factory's writer produces with health: acme/widgets fails
// with owner waits and acme/gadgets passes, beside three unresolved runs, one
// exactly at its limit when the command observes.
const failingSince = "2026-11-08T09:00:00.000Z";
const healthRuns: UnresolvedRun[] = [
  {
    repository: "acme/gadgets",
    issue: 3,
    runKind: "implement",
    startedAt: "2026-11-08T09:00:00.000Z",
    limitAt: now.toISOString(),
    phase: "stopping",
    resultPosted: false,
  },
  {
    repository: "acme/widgets",
    issue: 4,
    runKind: "triage",
    startedAt: "2026-11-08T07:00:00.000Z",
    limitAt: "2026-11-08T11:00:00.000Z",
    phase: "exited",
    resultPosted: false,
  },
  {
    repository: "acme/widgets",
    issue: 6,
    runKind: "review",
    startedAt: "2026-11-08T08:00:00.001Z",
    limitAt: "2026-11-08T12:00:00.001Z",
    phase: "running",
    resultPosted: false,
  },
];
const widgetsHealth = {
  pass: {
    failingSince,
    failure: "its platform reads failed: issues unavailable",
    lastPublication: {
      at: "2026-11-08T08:00:00.000Z",
      issue: 4,
      runKind: "triage" as const,
    },
    lastSettlement: null,
  },
  ownerWaits: {
    label: "state:owner",
    issues: [
      {
        number: 5,
        title: "Choose the format",
        url: "https://platform.test/acme/widgets/issues/5",
      },
    ],
  },
};
const gadgetsHealth = {
  pass: {
    failingSince: null,
    lastPublication: null,
    lastSettlement: {
      at: "2026-11-08T10:00:00.000Z",
      issue: 2,
      runKind: "implement" as const,
    },
  },
  ownerWaits: null,
};
function healthSnapshot(repositories: string[]) {
  return hostStatus(
    now.toISOString(),
    repositories.map((name, index) => ({
      name,
      paused: null,
      configuration: valid,
      modelPolicy: policy,
      ...(index === 0 ? widgetsHealth : gadgetsHealth),
    })),
    [],
    [],
    undefined,
    [],
    undefined,
    healthRuns,
  );
}

test("health projects the status file's pass health, owner waits and overdue runs, as text and JSON, through a pending transaction", async (t) => {
  const { path, state } = fixture(t);
  const config = JSON.parse(readFileSync(path, "utf8"));
  mkdirSync(state);
  writeFileSync(
    join(state, "status.json"),
    JSON.stringify(healthSnapshot(config.repositories)),
  );
  // A pending transaction concerns provider work, not health.
  writeFileSync(
    join(state, "events-state.json"),
    JSON.stringify({ version: 1, pending: {} }),
  );
  const before = readFileSync(join(state, "status.json"), "utf8");
  const budget = JSON.parse((await command([path, "--json"])).output[0]);
  assert.deepEqual(budget.health, {
    observation: {
      state: "last-observed",
      source: "status.json",
      at: now.toISOString(),
    },
    repositories: [
      { repository: "acme/widgets", ...widgetsHealth },
      { repository: "acme/gadgets", ...gadgetsHealth },
    ],
    // Ordered by limit; a run exactly at its limit is overdue, and one a
    // millisecond short of it is not.
    overdueRuns: [healthRuns[1], healthRuns[0]],
  });
  assert.equal(budget.version, 1);
  assert.equal(budget.capacity.observation.state, "unavailable");
  const text = (await command([path])).output[0].split("\n");
  const coverage = text.indexOf(
    `coverage observation=${JSON.stringify(budget.coverage.observation)}`,
  );
  assert.deepEqual(text.slice(coverage + 1, coverage + 7), [
    `acme/widgets: pass=${JSON.stringify(widgetsHealth.pass)} ownerWaits=${JSON.stringify(widgetsHealth.ownerWaits)}`,
    `acme/gadgets: pass=${JSON.stringify(gadgetsHealth.pass)} ownerWaits=null`,
    "overdue runs=2",
    "  acme/widgets#4: runKind=triage phase=exited startedAt=2026-11-08T07:00:00.000Z limitAt=2026-11-08T11:00:00.000Z resultPosted=false",
    "  acme/gadgets#3: runKind=implement phase=stopping startedAt=2026-11-08T09:00:00.000Z limitAt=2026-11-08T12:00:00.000Z resultPosted=false",
    `health observation=${JSON.stringify(budget.health.observation)}`,
  ]);
  // The command writes nothing.
  assert.equal(readFileSync(join(state, "status.json"), "utf8"), before);
});

for (const fault of [
  "missing",
  "unreadable",
  "future",
  "pre-coverage",
  "pre-health",
  "without unresolved runs",
  "inconsistent pass",
  "failure while passing",
  "inconsistent owner waits",
  "inconsistent run",
  "duplicate",
  "new repository",
])
  test(`health is unavailable for a ${fault} status file`, async (t) => {
    const { path, state } = fixture(t);
    const config = JSON.parse(readFileSync(path, "utf8"));
    mkdirSync(state);
    const snapshot = healthSnapshot(config.repositories);
    const [first, second] = snapshot.repositories as Record<string, any>[];
    if (fault === "future") snapshot.updatedAt = "2100-01-01T00:00:00Z";
    if (fault === "pre-coverage") delete first.configuration;
    if (fault === "pre-health")
      for (const entry of snapshot.repositories as Record<string, unknown>[]) {
        delete entry.pass;
        delete entry.ownerWaits;
      }
    if (fault === "without unresolved runs")
      delete (snapshot as Partial<typeof snapshot>).unresolvedRuns;
    if (fault === "inconsistent pass") first.pass.failingSince = "yesterday";
    if (fault === "failure while passing") second.pass.failure = "it broke";
    if (fault === "inconsistent owner waits")
      first.ownerWaits.issues.push(first.ownerWaits.issues[0]);
    if (fault === "inconsistent run")
      (snapshot.unresolvedRuns[0] as Record<string, unknown>).phase = "paused";
    if (fault === "duplicate")
      snapshot.repositories.push(snapshot.repositories[0]);
    if (fault === "new repository") snapshot.repositories.pop();
    if (fault === "unreadable") mkdirSync(join(state, "status.json"));
    else if (fault !== "missing")
      writeFileSync(join(state, "status.json"), JSON.stringify(snapshot));
    const { health } = JSON.parse((await command([path, "--json"])).output[0]);
    assert.equal(health.observation.state, "unavailable");
    assert.equal(health.observation.at, null);
    assert.match(
      health.observation.problem,
      fault === "missing"
        ? /^missing record$/
        : fault === "unreadable"
          ? /^unreadable record$/
          : /^missing, legacy or inconsistent health observation$/,
    );
    // Nulls establish nothing: no health, no failure, no empty list.
    assert.deepEqual(health.repositories, [
      { repository: "acme/widgets", pass: null, ownerWaits: null },
      { repository: "acme/gadgets", pass: null, ownerWaits: null },
    ]);
    assert.equal(health.overdueRuns, null);
    const text = (await command([path])).output[0].split("\n");
    for (const repository of config.repositories)
      assert.ok(
        text.includes(`${repository}: pass=unavailable ownerWaits=unavailable`),
        text.join("\n"),
      );
    assert.ok(text.includes("overdue runs=unavailable"), text.join("\n"));
  });

test("text and JSON show the last pass's credential health and detail as an additive field", async (t) => {
  const { path, state } = fixture(t);
  mkdirSync(state);
  const computedAt = new Date("2026-11-08T11:58:00.000Z");
  const later = "2026-11-09T12:00:00.000Z";
  const section = {
    observedAt: "2026-11-08T11:00:00.000Z",
    validUntil: later,
  };
  const provider = {
    ...section,
    renewalDueAt: later,
    lastRenewal: { at: "2026-11-08T10:00:00.000Z", outcome: "succeeded" },
  };
  const grantedPermissions: Record<string, string> = {
    actions: "read",
    checks: "read",
    contents: "write",
    issues: "read",
    metadata: "read",
    pull_requests: "write",
    statuses: "read",
  };
  const document = (change: (document: any) => void = () => {}) => {
    const value = {
      version: 1,
      providers: { "claude-code": { ...provider }, codex: { ...provider } },
      githubApp: { ...section, grantedPermissions: { ...grantedPermissions } },
    };
    change(value);
    return { document: value };
  };
  const expiries = { "claude-code": new Date(later), codex: new Date(later) };
  const cases = {
    healthy: { observations: document(), loginExpiries: expiries },
    expired: {
      observations: document(),
      loginExpiries: { ...expiries, codex: new Date("2026-11-08T11:00:00Z") },
    },
    "renewal due": {
      observations: document((value) => {
        value.providers.codex.renewalDueAt = section.observedAt;
      }),
      loginExpiries: expiries,
    },
    "renewal failed": {
      observations: document((value) => {
        value.providers["claude-code"].lastRenewal = {
          at: section.observedAt,
          outcome: "failed",
        };
      }),
      loginExpiries: expiries,
    },
    "missing permission": {
      observations: document((value) => {
        delete value.githubApp.grantedPermissions.statuses;
      }),
      loginExpiries: expiries,
    },
    "not configured": {
      observations: {
        document: null,
        problem: "credentialObservations is not configured",
      },
      loginExpiries: expiries,
    },
    "past validUntil": {
      observations: document((value) => {
        value.githubApp.validUntil = section.observedAt;
      }),
      loginExpiries: expiries,
    },
    "unreadable login": {
      observations: document(),
      loginExpiries: { ...expiries, "claude-code": null },
    },
  } as const;
  const expected = {
    healthy: "healthy",
    expired: "unhealthy",
    "renewal due": "unhealthy",
    "renewal failed": "unhealthy",
    "missing permission": "unhealthy",
    "not configured": "unknown",
    "past validUntil": "unknown",
    "unreadable login": "unknown",
  };
  const snapshot = hostStatus(
    now.toISOString(),
    [
      {
        name: "acme/widgets",
        paused: null,
        configuration: valid,
        modelPolicy: policy,
      },
      {
        name: "acme/gadgets",
        paused: null,
        configuration: valid,
        modelPolicy: policy,
      },
    ],
    [],
  );
  writeFileSync(join(state, "status.json"), JSON.stringify(snapshot));
  const { credentials: absent, ...before } = JSON.parse(
    (await command([path, "--json"])).output[0],
  );
  for (const [name, input] of Object.entries(cases)) {
    const credentials = credentialHealth({
      now: computedAt,
      version2: false,
      ...(input as Omit<
        Parameters<typeof credentialHealth>[0],
        "now" | "version2"
      >),
    });
    writeFileSync(
      join(state, "status.json"),
      JSON.stringify({ ...snapshot, credentials }),
    );
    const projected = JSON.parse(
      readFileSync(join(state, "status.json"), "utf8"),
    ).credentials;
    assert.equal(
      projected.health,
      expected[name as keyof typeof expected],
      name,
    );
    assert.equal(projected.observedAt, computedAt.toISOString(), name);
    const json = await command([path, "--json"]);
    assert.equal(json.code, 0, json.errors.join("\n"));
    const { credentials: shown, ...rest } = JSON.parse(json.output[0]);
    assert.equal(rest.version, 1);
    // Every existing field is unchanged.
    assert.deepEqual(rest, before, name);
    assert.deepEqual(shown, projected, name);
    const text = (await command([path])).output[0];
    assert.ok(
      text.includes(
        `credentials health=${projected.health} observedAt="${projected.observedAt}"`,
      ),
      text,
    );
    for (const [provider, detail] of Object.entries(projected.providers) as [
      string,
      any,
    ][])
      assert.ok(
        text.includes(
          `  ${provider}: health=${detail.health} loginExpiry=${detail.loginExpiry}`,
        ),
        text,
      );
  }
  const text = (await command([path])).output[0];
  assert.match(text, /claude-code: health=unknown loginExpiry=unknown/);

  writeFileSync(
    join(state, "status.json"),
    JSON.stringify({
      ...snapshot,
      credentials: credentialHealth({
        now: computedAt,
        version2: false,
        ...cases["missing permission"],
      }),
    }),
  );
  assert.match(
    (await command([path])).output[0],
    /\n {2}implement: health=unhealthy missingPermissions=\{"statuses":"read"\}\n/,
  );
  assert.deepEqual(absent.health, "unknown");
});

test("status reports credential health unknown when it cannot read the projection", async (t) => {
  const { path, state } = fixture(t);
  const unknown = async () => {
    const json = await command([path, "--json"]);
    assert.equal(json.code, 0, json.errors.join("\n"));
    const { credentials } = JSON.parse(json.output[0]);
    assert.equal(credentials.health, "unknown");
    assert.equal(credentials.observedAt, null);
    assert.deepEqual(credentials.providers.codex, {
      health: "unknown",
      loginExpiry: "unknown",
      renewalDueAt: "unknown",
      lastRenewal: "unknown",
    });
    assert.deepEqual(credentials.runKinds.implement, {
      health: "unknown",
      missingPermissions: "unknown",
    });
    const text = (await command([path])).output[0];
    assert.match(text, /credentials health=unknown observedAt=unavailable/);
    return credentials.problems;
  };
  assert.deepEqual(await unknown(), ["status.json: missing record"]);
  mkdirSync(state);
  writeFileSync(join(state, "status.json"), "{");
  assert.deepEqual(await unknown(), ["status.json: unreadable record"]);
  const snapshot = hostStatus(now.toISOString(), [], []);
  writeFileSync(join(state, "status.json"), JSON.stringify(snapshot));
  assert.deepEqual(await unknown(), [
    "status.json: missing, legacy or inconsistent credential observation",
  ]);
  for (const credentials of [
    { health: "fine", observedAt: now.toISOString() },
    {
      health: "healthy",
      observedAt: "2026-11-09T00:00:00.000Z",
      providers: {},
      runKinds: {},
      problems: [],
    },
  ]) {
    writeFileSync(
      join(state, "status.json"),
      JSON.stringify({ ...snapshot, credentials }),
    );
    await unknown();
  }
});
