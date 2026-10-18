import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Usage, UsageHold } from "../src/factory.ts";
import type { UsagePolicy } from "../src/host-configuration.ts";
import {
  createOwner,
  queueResume,
  requestsDirectory,
  resumeProblem,
} from "../src/owner.ts";
import { directory } from "./fakes.ts";

const start = new Date("2026-10-09T12:00:00.000Z");
const reset = "2026-10-09T15:00:00.000Z";
const later = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

// The owner's host: new claims stop at 90% and running runs at 95%, and only
// the owner reopens claims.
const ownerResume: UsagePolicy = {
  drainThreshold: 90,
  pauseThreshold: 95,
  afterDrain: "owner-resume",
};

// The owner's control on a fake clock over one state directory; `restart`
// starts a new process on the same directory.
function owner(
  t: TestContext,
  policy: UsagePolicy = ownerResume,
  state = directory(t),
) {
  const clock = { now: start };
  const reports: string[] = [];
  function process() {
    return createOwner({
      providers: ["claude-code", "codex"],
      policy,
      now: () => clock.now,
      report: (line) => reports.push(line),
      stateDirectory: state,
    });
  }
  let instance = process();
  return {
    clock,
    reports,
    state,
    // A pass with each provider's fresh reading, a number read now, and its
    // usage hold.
    pass(
      usage: Record<string, number | Usage | null> = {},
      holds: Record<string, UsageHold | null> = {},
    ) {
      return instance.pass(
        Object.fromEntries(
          Object.entries(usage).map(([provider, reading]) => [
            provider,
            typeof reading === "number"
              ? { used: reading, at: clock.now.toISOString() }
              : reading,
          ]),
        ),
        holds,
      );
    },
    restart() {
      instance = process();
    },
    resume(provider: string, drainThreshold?: number) {
      return queueResume(state, {
        provider,
        ...(drainThreshold !== undefined && { drainThreshold }),
        requestedAt: clock.now.toISOString(),
      });
    },
    requests: () =>
      existsSync(requestsDirectory(state))
        ? readdirSync(requestsDirectory(state))
        : [],
  };
}

const hold92 = { since: start.toISOString(), used: 92 };

test("an owner-resume host's draining provider gets an owner hold that low and unknown usage and a restart keep", (t) => {
  const run = owner(t);
  assert.deepEqual(run.pass({ "claude-code": 89, codex: 10 }), {
    "claude-code": null,
    codex: null,
  });
  assert.deepEqual(run.pass({ "claude-code": 92, codex: 10 }), {
    "claude-code": { hold: hold92, reserve: null },
    codex: null,
  });
  assert.deepEqual(run.reports, [
    "claude-code drained at 92% usage, so it has an owner hold: it claims no new issue until the owner resumes it",
  ]);
  run.clock.now = later(10);
  for (const usage of [{ "claude-code": 10 }, { "claude-code": null }]) {
    assert.deepEqual(run.pass(usage)["claude-code"], {
      hold: hold92,
      reserve: null,
    });
    run.restart();
  }
  // A drain the pass sees only through its usage hold sets one too.
  const codexHold = {
    used: 96,
    at: start.toISOString(),
    since: start.toISOString(),
    until: reset,
  };
  assert.deepEqual(run.pass({}, { codex: codexHold }).codex, {
    hold: { since: later(10).toISOString(), used: 96 },
    reserve: null,
  });
  assert.equal(run.reports.length, 2);
});

test("an auto-resume host sets no owner hold, and a resume request there has none to lift", (t) => {
  const run = owner(t, { ...ownerResume, afterDrain: "auto-resume" });
  assert.deepEqual(run.pass({ "claude-code": 99 })["claude-code"], null);
  const id = run.resume("claude-code");
  assert.deepEqual(run.pass({ "claude-code": 99 })["claude-code"], null);
  assert.deepEqual(run.reports, [
    `resume request ${id} applied: claude-code had no owner hold`,
  ]);
  assert.deepEqual(run.requests(), []);
});

test("a resume request applies on the next pass, to its own provider only, and once", (t) => {
  const run = owner(t);
  run.pass({ "claude-code": 92, codex: 93 });
  const id = run.resume("claude-code");
  // Queued, it changes nothing until the running factory's next pass.
  assert.deepEqual(run.requests(), [id]);
  run.clock.now = later(5);
  assert.deepEqual(run.pass({ "claude-code": 10, codex: 10 }), {
    "claude-code": null,
    codex: { hold: { since: start.toISOString(), used: 93 }, reserve: null },
  });
  assert.equal(
    run.reports.at(-1),
    `resume request ${id} applied: lifted claude-code's owner hold from 92% at ${start.toISOString()}`,
  );
  assert.deepEqual(run.requests(), []);
  run.restart();
  assert.equal(run.pass({ "claude-code": 10, codex: 10 })["claude-code"], null);
});

test("a plain release while usage is still high meets the drain gate, not a new owner hold, until the provider drains again", (t) => {
  const run = owner(t);
  run.pass({ "claude-code": 92 });
  run.resume("claude-code");
  // The drain threshold holds claims by itself; the owner hold is gone.
  assert.equal(run.pass({ "claude-code": 92 })["claude-code"], null);
  run.restart();
  assert.equal(run.pass({ "claude-code": 93 })["claude-code"], null);
  run.clock.now = later(10);
  assert.equal(run.pass({ "claude-code": 80 })["claude-code"], null);
  run.clock.now = later(20);
  assert.deepEqual(run.pass({ "claude-code": 91 })["claude-code"], {
    hold: { since: later(20).toISOString(), used: 91 },
    reserve: null,
  });
});

test("a reserve raise lasts until a reading below the configured drain threshold, and the provider then drains at its configured threshold", (t) => {
  const run = owner(t);
  run.pass({ "claude-code": 92 });
  const id = run.resume("claude-code", 94);
  const granted = {
    drainThreshold: 94,
    since: later(1).toISOString(),
    until: reset,
  };
  run.clock.now = later(1);
  assert.deepEqual(
    run.pass({ "claude-code": { used: 92, at: start.toISOString(), reset } })[
      "claude-code"
    ],
    {
      hold: null,
      reserve: granted,
    },
  );
  assert.equal(
    run.reports.at(-1),
    `resume request ${id} applied: lifted claude-code's owner hold from 92% at ${start.toISOString()}, and raised its drain threshold once to 94% until usage reads below the configured 90% or its reset at ${reset} passes`,
  );
  // Up to the raise, claims stay open and no owner hold is set; the raise
  // survives a restart.
  run.restart();
  run.clock.now = later(5);
  assert.deepEqual(run.pass({ "claude-code": 93 })["claude-code"], {
    hold: null,
    reserve: granted,
  });
  run.clock.now = later(10);
  assert.equal(run.pass({ "claude-code": 89 })["claude-code"], null);
  assert.equal(
    run.reports.at(-1),
    "claude-code's reserve raise to 94% ended: usage 89% is below the configured 90% drain threshold; its configured drain threshold applies again",
  );
  run.clock.now = later(15);
  assert.deepEqual(run.pass({ "claude-code": 90 })["claude-code"], {
    hold: { since: later(15).toISOString(), used: 90 },
    reserve: null,
  });
});

test("a reserve raise ends once the provider's reset passes, and reaching the raise sets an owner hold meanwhile", (t) => {
  const run = owner(t);
  run.pass({ "claude-code": { used: 92, at: start.toISOString(), reset } });
  run.resume("claude-code", 94);
  run.pass({ "claude-code": { used: 92, at: start.toISOString(), reset } });
  run.clock.now = later(30);
  assert.deepEqual(run.pass({ "claude-code": 94 })["claude-code"], {
    hold: { since: later(30).toISOString(), used: 94 },
    reserve: { drainThreshold: 94, since: start.toISOString(), until: reset },
  });
  run.restart();
  run.clock.now = new Date(reset);
  assert.deepEqual(run.pass({})["claude-code"], {
    hold: { since: later(30).toISOString(), used: 94 },
    reserve: null,
  });
  assert.equal(
    run.reports.at(-1),
    `claude-code's reserve raise to 94% ended: the reset at ${reset} passed; its configured drain threshold applies again`,
  );
});

test("a reserve raise granted without a reset waits for the first reset its provider reports", (t) => {
  const run = owner(t);
  run.pass({ "claude-code": 92 });
  run.resume("claude-code", 95);
  assert.deepEqual(run.pass({ "claude-code": 92 })["claude-code"]?.reserve, {
    drainThreshold: 95,
    since: start.toISOString(),
    until: null,
  });
  run.clock.now = later(5);
  const reading = { used: 93, at: later(5).toISOString(), reset };
  assert.equal(
    run.pass({ "claude-code": reading })["claude-code"]?.reserve?.until,
    reset,
  );
});

test("an applied request is never applied again, even when the process stopped before removing it", (t) => {
  const run = owner(t);
  run.pass({ "claude-code": 92 });
  const id = run.resume("claude-code", 94);
  const queued = join(requestsDirectory(run.state), id);
  const copy = join(run.state, "copy.json");
  copyFileSync(queued, copy);
  run.pass({ "claude-code": 92 });
  // As if the process stopped after keeping the request's effect but before
  // removing its file.
  copyFileSync(copy, queued);
  run.clock.now = later(5);
  run.pass({ "claude-code": 89 });
  run.restart();
  run.clock.now = later(10);
  assert.equal(run.pass({ "claude-code": 92 })["claude-code"]?.reserve, null);
  assert.equal(
    run.reports.filter((line) => line.startsWith(`resume request ${id}`))
      .length,
    1,
  );
  assert.deepEqual(run.requests(), []);
});

test("requests apply oldest first, and one the configuration refuses is discarded", (t) => {
  const run = owner(t);
  run.pass({ "claude-code": 92, codex: 92 });
  mkdirSync(requestsDirectory(run.state), { recursive: true });
  const first = run.resume("claude-code", 96);
  run.clock.now = later(1);
  const second = run.resume("claude-code", 93);
  run.clock.now = later(2);
  const third = run.resume("gemini");
  writeFileSync(join(requestsDirectory(run.state), "zz-broken.json"), "{");
  run.pass({ "claude-code": 92, codex: 92 });
  assert.deepEqual(run.reports.slice(2, 5), [
    `resume request ${first} was discarded: the drain threshold can be raised only above its configured 90%, up to the 95% pause threshold`,
    `resume request ${second} applied: lifted claude-code's owner hold from 92% at ${start.toISOString()}, and raised its drain threshold once to 93% until usage reads below the configured 90% or its provider reports a reset that passes`,
    `resume request ${third} was discarded: the host configuration has no provider gemini; choose claude-code or codex`,
  ]);
  assert.match(
    run.reports[5],
    /^resume request zz-broken\.json was discarded: it is unreadable: SyntaxError/,
  );
  assert.equal(run.reports.length, 6);
  assert.deepEqual(run.requests(), []);
});

test("a reserve raise the configuration no longer allows ends", (t) => {
  const state = directory(t);
  const before = owner(t, ownerResume, state);
  before.pass({ "claude-code": 92 });
  before.resume("claude-code", 95);
  before.pass({ "claude-code": 92 });
  const after = owner(t, { ...ownerResume, pauseThreshold: 94 }, state);
  assert.deepEqual(after.pass({ "claude-code": 92 })["claude-code"], {
    hold: { since: start.toISOString(), used: 92 },
    reserve: null,
  });
  assert.deepEqual(after.reports, [
    "claude-code's reserve raise to 95% ended: the host configuration no longer allows it; its configured drain threshold applies again",
    "claude-code drained at 92% usage, so it has an owner hold: it claims no new issue until the owner resumes it",
  ]);
});

test("an unreadable owner record holds every provider of an owner-resume host until the owner resumes it", (t) => {
  const run = owner(t);
  writeFileSync(join(run.state, "owner.json"), "{");
  const unread = {
    hold: { since: start.toISOString(), used: null },
    reserve: null,
  };
  assert.deepEqual(run.pass({ "claude-code": 10, codex: 10 }), {
    "claude-code": unread,
    codex: unread,
  });
  run.restart();
  run.resume("codex");
  assert.deepEqual(run.pass({ "claude-code": 10, codex: 10 }), {
    "claude-code": unread,
    codex: null,
  });
  assert.match(
    readFileSync(join(run.state, "owner.json"), "utf8"),
    /"used": null/,
  );
});

test("a raise must lift a configured drain threshold, up to the pause threshold or 100", () => {
  const providers = ["claude-code", "codex"];
  const problem = (policy: Partial<UsagePolicy>, drainThreshold?: number) =>
    resumeProblem(
      providers,
      { ...ownerResume, ...policy },
      { provider: "claude-code", drainThreshold },
    );
  assert.equal(problem({}), null);
  assert.equal(problem({}, 95), null);
  assert.equal(problem({}, 90.5), null);
  assert.match(problem({}, 90)!, /only above its configured 90%/);
  assert.match(problem({}, 95.5)!, /up to the 95% pause threshold$/);
  assert.equal(problem({ pauseThreshold: null }, 100), null);
  assert.match(
    problem({ pauseThreshold: null }, 101)!,
    /up to 100%, as the host sets no pause threshold$/,
  );
  assert.equal(
    problem({ drainThreshold: null }, 95),
    "the host sets no drain threshold, so there is none to raise",
  );
});
