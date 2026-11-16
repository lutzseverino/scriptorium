import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createRegistry } from "../src/providers.ts";
import { codexUsage, readCodexUsage } from "../src/providers/codex.ts";
import { command, directory, fakePorts, rawRunLog, request } from "./fakes.ts";

const login = '{"tokens":{"access_token":"secret"}}';

function codex(t: TestContext, executable = "/nonexistent/codex") {
  const root = directory(t);
  const credential = join(root, "auth.json");
  writeFileSync(credential, login);
  const { ports, runs } = fakePorts({ codexExecutable: executable });
  const adapter = createRegistry(
    { codex: { credential } },
    { effort: "high" },
    ports,
  ).providers.get("codex")!;
  return { adapter, credential, runs, root };
}

test("a Codex launch runs the model and effort and mounts the login read-only in its home", async (t) => {
  const { adapter, credential, runs } = codex(t);
  const mounts = [
    { hostPath: "/srv/factory/gh", sandboxPath: "/home/agent/.gh" },
  ];
  await adapter.launch({
    ...request,
    model: "gpt-6.1",
    effort: "xhigh",
    mounts,
  });

  const [{ run, docker }] = runs;
  assert.match(
    command(run),
    /^codex exec .* -m 'gpt-6\.1' -c 'model_reasoning_effort="xhigh"'$/,
  );
  assert.deepEqual(run.agent.env, {});
  assert.deepEqual(docker, {
    imageName: request.image,
    mounts: [
      ...mounts,
      {
        hostPath: credential,
        sandboxPath: "/home/agent/.codex/auth.json",
        readonly: true,
      },
    ],
  });
  assert.deepEqual(run.branchStrategy, {
    type: "branch",
    branch: request.branch,
  });
});

test("a Codex launch tells the host its login's API key and tokens", async (t) => {
  const { adapter, credential } = codex(t);
  writeFileSync(
    credential,
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: "sk-key",
      tokens: { id_token: "id", access_token: "access", refresh_token: "r" },
      last_refresh: "2026-10-09T12:00:00Z",
    }),
  );
  const delivered: string[] = [];
  await adapter.launch({
    ...request,
    delivered: (secret) => delivered.push(secret),
  });
  assert.deepEqual(delivered, ["sk-key", "id", "access", "r"]);
});

test("a Codex launch with a login that is not JSON is refused before Sandcastle without quoting it", async (t) => {
  const { adapter, credential, runs } = codex(t);
  writeFileSync(credential, "sk-not-json");
  await assert.rejects(adapter.launch(request), {
    message: `the Codex login ${credential} is not readable JSON`,
  });
  assert.equal(runs.length, 0);
});

// A stand-in for `codex app-server` that records the Codex home it was given,
// writes state there as Codex does, and answers, refuses, or never replies,
// after an optional startup delay.
function fakeCodex(
  root: string,
  behavior: "answer" | "refuse" | "hang",
  startupMs = 0,
) {
  const seen = join(root, `seen-${behavior}.json`);
  const executable = join(root, `fake-codex-${behavior}`);
  writeFileSync(
    executable,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.CODEX_HOME;
const auth = path.join(home, "auth.json");
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
  home,
  args: process.argv.slice(2),
  homeMode: fs.statSync(home).mode & 0o777,
  authMode: fs.statSync(auth).mode & 0o777,
  auth: fs.readFileSync(auth, "utf8"),
}));
fs.mkdirSync(path.join(home, "sessions"));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${startupMs});
const reply = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (${JSON.stringify(behavior)} === "hang") return;
  if (message.method === "initialize") reply({ id: 0, result: {} });
  else if (message.method !== "account/rateLimits/read") return;
  else if (${JSON.stringify(behavior)} === "refuse")
    reply({ id: 1, error: { code: -32600, message: "not signed in" } });
  else reply({ id: 1, result: {
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1791990000 },
      secondary: { usedPercent: 64, windowDurationMins: 10080, resetsAt: 1792000800 },
    },
  } });
});
`,
  );
  chmodSync(executable, 0o755);
  return {
    executable,
    seen: () => JSON.parse(readFileSync(seen, "utf8")),
  };
}

test("each Codex usage read signs in from a private copy of the current login that it removes", async (t) => {
  const root = directory(t);
  const fake = fakeCodex(root, "answer");
  const { adapter, credential } = codex(t, fake.executable);
  chmodSync(credential, 0o444);
  const environment = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, "operator-codex-home");
  t.after(() => {
    if (environment === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = environment;
  });

  // The fuller window is the weekly one, resetting at its Unix seconds, and
  // every window keeps its length.
  const weekly = {
    used: 64,
    reset: "2026-10-14T18:00:00.000Z",
    windows: [
      { used: 31, reset: "2026-10-14T15:00:00.000Z", minutes: 300 },
      { used: 64, reset: "2026-10-14T18:00:00.000Z", minutes: 10080 },
    ],
  };
  assert.deepEqual(await adapter.readUsage(), weekly);
  const first = fake.seen();
  assert.deepEqual(first.args, ["app-server"]);
  assert.notEqual(first.home, process.env.CODEX_HOME);
  assert.equal(first.homeMode, 0o700);
  assert.equal(first.authMode, 0o600);
  assert.equal(first.auth, login);
  assert.equal(existsSync(first.home), false);
  assert.equal(readFileSync(credential, "utf8"), login);

  chmodSync(credential, 0o644);
  writeFileSync(credential, '{"tokens":{"access_token":"renewed"}}');
  assert.deepEqual(await adapter.readUsage(), weekly);
  assert.notEqual(fake.seen().home, first.home);
  assert.equal(fake.seen().auth, '{"tokens":{"access_token":"renewed"}}');
  assert.equal(existsSync(fake.seen().home), false);
});

// The refusing server starts slower than the timeout test's deadline, so the
// read reports the refusal only because it waits with the default deadline.
test("a Codex usage read removes its login copy after a refusal", async (t) => {
  const root = directory(t);
  const fake = fakeCodex(root, "refuse", 750);
  const { credential } = codex(t, fake.executable);
  await assert.rejects(readCodexUsage(credential, fake.executable), {
    message: "codex app-server refused the read (code -32600): not signed in",
  });
  assert.equal(existsSync(fake.seen().home), false);
});

// The deadline can end a slow-starting server before it records its home, so
// the read makes its login copy in a temporary directory of its own.
test("a Codex usage read removes its login copy after a timeout", async (t) => {
  const root = directory(t);
  const fake = fakeCodex(root, "hang");
  const { credential } = codex(t, fake.executable);
  const temporary = join(root, "tmp");
  mkdirSync(temporary);
  const environment = process.env.TMPDIR;
  process.env.TMPDIR = temporary;
  t.after(() => {
    if (environment === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = environment;
  });

  await assert.rejects(readCodexUsage(credential, fake.executable, 500), {
    message: "timed out",
  });
  assert.deepEqual(readdirSync(temporary), []);
});

const working = ["Reading the issue first.", "Bash(gh issue view 371)"];

test("Codex's usage-limit error at the end of a raw log is a usage limit, with any stated reset", (t) => {
  const { adapter } = codex(t);
  const error = (retry: string) =>
    `You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or ${retry}.`;
  for (const [detail, reset] of [
    // Its standard error, after the prompt it read.
    [
      [
        "Reading prompt from stdin...",
        `ERROR: ${error("try again at 3:45 PM")}`,
      ],
      "3:45 PM",
    ],
    // Its error event as the error result.
    [
      ["You've hit your usage limit. Try again in 2 days 3 hours 5 minutes."],
      "in 2 days 3 hours 5 minutes",
    ],
    // Its last output lines, its error event among them.
    [
      [
        '{"type":"turn.started"}',
        JSON.stringify({ type: "error", message: error("try again later") }),
        JSON.stringify({
          type: "turn.failed",
          error: { message: error("try again later") },
        }),
      ],
      null,
    ],
  ] as const)
    assert.deepEqual(
      adapter.usageLimit(rawRunLog("codex", working, [...detail])),
      { reset },
      detail.join("\n"),
    );
});

test("a Codex failure without its usage-limit error is no usage limit", (t) => {
  const { adapter } = codex(t);
  for (const log of [
    rawRunLog("codex", working, [
      "Reading prompt from stdin...",
      "ERROR: stream disconnected before completion",
    ]),
    rawRunLog("codex", [
      ...working,
      "The deploy hit its rate limit; I stopped.",
    ]),
    "",
  ])
    assert.equal(adapter.usageLimit(log), null);
});

test("a Codex reading with one window, such as the x5 plan's, reports only that window", () => {
  for (const limits of [
    {
      primary: null,
      secondary: {
        usedPercent: 40,
        windowDurationMins: 10080,
        resetsAt: 1792000800,
      },
    },
    {
      primary: {
        usedPercent: 40,
        windowDurationMins: 10080,
        resetsAt: 1792000800,
      },
    },
  ])
    assert.deepEqual(codexUsage({ rateLimits: limits }), {
      used: 40,
      reset: "2026-10-14T18:00:00.000Z",
      windows: [
        { used: 40, reset: "2026-10-14T18:00:00.000Z", minutes: 10080 },
      ],
    });
});

test("a Codex window without a reset or a length still reports its percentage", () => {
  assert.deepEqual(
    codexUsage({
      rateLimits: {
        primary: { usedPercent: 70, windowDurationMins: 300 },
        secondary: {
          usedPercent: 20,
          windowDurationMins: 0,
          resetsAt: 1792000800,
        },
      },
    }),
    {
      used: 70,
      reset: null,
      windows: [
        { used: 70, reset: null, minutes: 300 },
        { used: 20, reset: "2026-10-14T18:00:00.000Z", minutes: null },
      ],
    },
  );
});

test("Codex's login expiry is its access token's, and unknown without a readable one", async (t) => {
  const { adapter, credential } = codex(t);
  const jwt = (payload: unknown) =>
    [
      Buffer.from('{"alg":"none"}').toString("base64url"),
      Buffer.from(JSON.stringify(payload)).toString("base64url"),
      "synthetic-signature-secret",
    ].join(".");
  const exp = Date.parse("2026-11-16T12:00:00.000Z") / 1000;
  writeFileSync(
    credential,
    JSON.stringify({
      tokens: {
        access_token: jwt({ exp, sub: "synthetic" }),
        refresh_token: "synthetic-refresh-secret",
      },
    }),
  );
  assert.deepEqual(await adapter.loginExpiry(), new Date(exp * 1000));
  for (const content of [
    login,
    "synthetic-login-secret not JSON",
    '{"OPENAI_API_KEY":"synthetic-key-secret"}',
    JSON.stringify({ tokens: { access_token: jwt({ sub: "synthetic" }) } }),
    JSON.stringify({ tokens: { access_token: jwt({ exp: "later" }) } }),
  ]) {
    writeFileSync(credential, content);
    assert.equal(await adapter.loginExpiry(), null);
  }
});
