import assert from "node:assert/strict";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { test } from "node:test";
import { createRegistry } from "../src/providers.ts";
import { UsageReadError } from "../src/providers/usage.ts";
import { command, directory, fakePorts, rawRunLog, request } from "./fakes.ts";

const usage = readFileSync(
  new URL("fixtures/claude-usage.json", import.meta.url),
  "utf8",
);

function claudeCode(t: import("node:test").TestContext, ports = fakePorts()) {
  const credential = join(directory(t), "claude-token");
  writeFileSync(credential, "sk-ant-oat01-first\n");
  const adapter = createRegistry(
    { "claude-code": { credential } },
    { effort: "high" },
    ports.ports,
  ).providers.get("claude-code")!;
  return { adapter, credential, runs: ports.runs };
}

test("a Claude Code launch runs the model and effort with the token file's current token", async (t) => {
  const { adapter, credential, runs } = claudeCode(t);
  const mounts = [
    { hostPath: "/srv/factory/gh", sandboxPath: "/home/agent/.gh" },
  ];
  await adapter.launch({
    ...request,
    model: "claude-opus-5-5",
    effort: "max",
    mounts,
  });
  writeFileSync(credential, "sk-ant-oat01-renewed");
  await adapter.launch({ ...request, model: "claude-sonnet-5-5" });

  const [first, second] = runs;
  assert.match(
    command(first.run),
    /^claude --print .* --model 'claude-opus-5-5' --effort max .* -p -$/,
  );
  assert.deepEqual(first.run.agent.env, {
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-first",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  });
  assert.deepEqual(second.run.agent.env, {
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-renewed",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  });
  // The token travels in the agent's environment; the sandbox gets only the
  // host's mounts.
  assert.deepEqual(first.docker, { imageName: request.image, mounts });
  assert.deepEqual(second.docker, { imageName: request.image, mounts: [] });
  assert.equal(first.run.prompt, request.prompt);
  assert.deepEqual(first.run.branchStrategy, {
    type: "branch",
    branch: request.branch,
  });
  assert.deepEqual(first.run.logging, { type: "file", path: request.log });
  assert.equal(first.run.idleTimeoutSeconds, request.idleTimeoutSeconds);
  const settings = /--settings '([^']+)'/.exec(command(first.run));
  assert.ok(settings, "launch policy overrides project and user env settings");
  assert.deepEqual(JSON.parse(settings[1]), {
    env: {
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      BASH_DEFAULT_TIMEOUT_MS: "1800000",
      BASH_MAX_TIMEOUT_MS: "3600000",
    },
  });
});

test("a Claude Code launch tells the host the token it delivers", async (t) => {
  const { adapter } = claudeCode(t);
  const delivered: string[] = [];
  await adapter.launch({
    ...request,
    delivered: (secret) => delivered.push(secret),
  });
  assert.deepEqual(delivered, ["sk-ant-oat01-first"]);
});

test("a launch returns completion and recovery identities without raw output or resume closures", async (t) => {
  const ports = fakePorts();
  ports.ports.sandcastle.run = async () => ({
    completionSignal: "<promise>COMPLETE</promise>",
    branch: request.branch,
    preservedWorktreePath: "/srv/repo/.sandcastle/worktrees/factory-issue-7",
    iterations: [
      { sessionId: "session-7", sessionFilePath: "/srv/sessions/7.jsonl" },
    ],
    stdout: "private raw output",
    commits: [],
  });
  const { adapter } = claudeCode(t, ports);
  assert.deepEqual(await adapter.launch(request), {
    completionSignal: "<promise>COMPLETE</promise>",
    branch: request.branch,
    preservedWorktreePath: "/srv/repo/.sandcastle/worktrees/factory-issue-7",
    sessionId: "session-7",
    sessionFilePath: "/srv/sessions/7.jsonl",
  });
});

test("a Claude Code launch with an empty token file is refused before Sandcastle", async (t) => {
  const { adapter, credential, runs } = claudeCode(t);
  writeFileSync(credential, "\n");
  await assert.rejects(adapter.launch(request), {
    message: `the Claude Code token file ${credential} is empty`,
  });
  assert.equal(runs.length, 0);
});

test("Claude Code usage is read from its endpoint with the token file, not the environment", async (t) => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const ports = fakePorts({
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
      });
      return new Response(usage, { status: 200 });
    },
  });
  const { adapter } = claudeCode(t, ports);
  const environment = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-environment";
  t.after(() => {
    if (environment === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = environment;
  });

  // The fixture's fuller window is the five-hour one, with its reset; its
  // model-specific windows are not read.
  assert.deepEqual(await adapter.readUsage(), {
    used: 42,
    reset: "2026-10-13T15:00:00.000Z",
    windows: [
      { used: 42, reset: "2026-10-13T15:00:00.000Z", minutes: 300 },
      { used: 17.5, reset: "2026-10-17T09:00:00.000Z", minutes: 10080 },
    ],
  });
  assert.deepEqual(calls, [
    {
      url: "https://api.anthropic.com/api/oauth/usage",
      headers: {
        authorization: "Bearer sk-ant-oat01-first",
        "anthropic-beta": "oauth-2025-04-20",
      },
    },
  ]);
});

test("a renewed Claude usage login is reread independently of the launch token", async (t) => {
  const root = directory(t);
  const credential = join(root, "setup-token");
  const usageCredential = join(root, "usage.json");
  const tokens: string[] = [];
  const ports = fakePorts({
    fetch: async (_url, init) => {
      tokens.push(new Headers(init?.headers).get("authorization")!);
      return new Response(
        '{"five_hour":{"utilization":12},"seven_day":{"utilization":73}}',
      );
    },
  });
  const adapter = createRegistry(
    { "claude-code": { credential, usageCredential } },
    { effort: "high" },
    ports.ports,
  ).providers.get("claude-code")!;
  const login = (accessToken: string) =>
    JSON.stringify({
      claudeAiOauth: { accessToken, expiresAt: Date.now() + 3_600_000 },
    });
  writeFileSync(usageCredential, login("synthetic-usage-first"));
  // A usage read needs no launch credential and no refresh token.
  const reading = {
    used: 73,
    reset: null,
    windows: [
      { used: 12, reset: null, minutes: 300 },
      { used: 73, reset: null, minutes: 10080 },
    ],
  };
  assert.deepEqual(await adapter.readUsage(), reading);
  writeFileSync(`${usageCredential}.next`, login("synthetic-usage-renewed"));
  renameSync(`${usageCredential}.next`, usageCredential);
  assert.deepEqual(await adapter.readUsage(), reading);
  assert.deepEqual(tokens, [
    "Bearer synthetic-usage-first",
    "Bearer synthetic-usage-renewed",
  ]);

  writeFileSync(credential, "synthetic-launch-token");
  writeFileSync(usageCredential, "malformed synthetic-usage-secret");
  const delivered: string[] = [];
  await adapter.launch({
    ...request,
    delivered: (secret) => delivered.push(secret),
  });
  assert.deepEqual(delivered, ["synthetic-launch-token"]);
  assert.deepEqual(ports.runs[0].run.agent.env, {
    CLAUDE_CODE_OAUTH_TOKEN: "synthetic-launch-token",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  });
  assert.deepEqual(ports.runs[0].docker.mounts, []);
});

test("unusable Claude usage logins fail safely without a request or launch-token fallback", async (t) => {
  const root = directory(t);
  const credential = join(root, "setup-token");
  const usageCredential = join(root, "usage.json");
  writeFileSync(credential, "synthetic-launch-secret");
  let requests = 0;
  const ports = fakePorts({
    fetch: async () => {
      requests++;
      return new Response("{}");
    },
  });
  const adapter = createRegistry(
    { "claude-code": { credential, usageCredential } },
    { effort: "high" },
    ports.ports,
  ).providers.get("claude-code")!;
  for (const content of [
    undefined,
    "synthetic-login-secret not JSON",
    "null",
    "[]",
    "{}",
    JSON.stringify({
      claudeAiOauth: { accessToken: "synthetic-login-secret" },
    }),
    ...[null, "", 42, "token with spaces"].map((accessToken) =>
      JSON.stringify({
        claudeAiOauth: { accessToken, expiresAt: Date.now() + 3_600_000 },
      }),
    ),
    ...[null, "tomorrow", "9999999999999", 0, Date.now() - 1].map((expiresAt) =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "synthetic-login-secret",
          expiresAt,
          refreshToken: "synthetic-refresh-secret",
        },
      }),
    ),
  ]) {
    if (content === undefined) rmSync(usageCredential, { force: true });
    else writeFileSync(usageCredential, content);
    await assert.rejects(adapter.readUsage(), (error) => {
      assert.ok(error instanceof UsageReadError);
      assert.doesNotMatch(inspect(error), /synthetic-.*secret/);
      return true;
    });
  }
  assert.equal(requests, 0);
  await adapter.launch(request);
  assert.equal(ports.runs.length, 1);
});

test("Claude Code usage is unknown when the endpoint's answer omits the windows", async (t) => {
  for (const [response, expected] of [
    [new Response('{"five_hour":null,"seven_day":null}'), null],
    [new Response('"unexpected"'), null],
    [
      new Response('{"seven_day":{"utilization":64}}'),
      {
        used: 64,
        reset: null,
        windows: [{ used: 64, reset: null, minutes: 10080 }],
      },
    ],
    [
      new Response(
        '{"five_hour":{"utilization":64,"resets_at":"soon"},"seven_day":{"utilization":12,"resets_at":"2026-10-17T09:00:00Z"}}',
      ),
      {
        used: 64,
        reset: null,
        windows: [
          { used: 64, reset: null, minutes: 300 },
          { used: 12, reset: "2026-10-17T09:00:00.000Z", minutes: 10080 },
        ],
      },
    ],
  ] as const) {
    const ports = fakePorts({ fetch: async () => response });
    assert.deepEqual(await claudeCode(t, ports).adapter.readUsage(), expected);
  }
});

test("a Claude account without a five-hour window reports its seven-day window with its length", async (t) => {
  const ports = fakePorts({
    fetch: async () =>
      new Response(
        '{"five_hour":null,"seven_day":{"utilization":31,"resets_at":"2026-10-17T09:00:00Z"},"seven_day_opus":{"utilization":90,"resets_at":"2026-10-17T09:00:00Z"}}',
      ),
  });
  assert.deepEqual(await claudeCode(t, ports).adapter.readUsage(), {
    used: 31,
    reset: "2026-10-17T09:00:00.000Z",
    windows: [{ used: 31, reset: "2026-10-17T09:00:00.000Z", minutes: 10080 }],
  });
});

test("a refused Claude Code usage read names its status and Retry-After, never its body or the token", async (t) => {
  for (const [status, retryAfter] of [
    [401, undefined],
    [403, undefined],
    [403, "1148"],
    [403, "Thu, 15 Oct 2026 16:25:00 GMT"],
    [403, "malformed"],
    [429, "1148"],
    [429, "Thu, 15 Oct 2026 16:25:00 GMT"],
    [503, undefined],
  ] as const) {
    const ports = fakePorts({
      fetch: async () =>
        new Response('{"error":{"message":"sk-ant-oat01-first is limited"}}', {
          status,
          headers:
            retryAfter === undefined ? {} : { "retry-after": retryAfter },
        }),
    });
    await assert.rejects(
      claudeCode(t, ports).adapter.readUsage(),
      (error: unknown) => {
        assert.ok(error instanceof UsageReadError);
        assert.equal(
          error.message,
          `the usage endpoint answered HTTP ${status}`,
        );
        assert.equal(error.status, status);
        assert.equal(error.retryAfter, retryAfter);
        assert.doesNotMatch(String(error), /sk-ant|limited/);
        return true;
      },
    );
  }
});

test("a Claude Code usage answer that is not JSON fails without quoting it", async (t) => {
  const ports = fakePorts({
    fetch: async () =>
      new Response("sk-ant-oat01-first <html>", { status: 200 }),
  });
  await assert.rejects(claudeCode(t, ports).adapter.readUsage(), (error) => {
    assert.ok(error instanceof UsageReadError);
    assert.equal(error.message, "the usage endpoint's answer is not JSON");
    assert.equal(error.retryAfter, undefined);
    return true;
  });
});

test("a Claude Code transport failure hides credentials and response details", async (t) => {
  const ports = fakePorts({
    fetch: async () => {
      throw new TypeError(
        "fetch failed: synthetic-token-secret response-body",
        {
          cause: new Error("synthetic-refresh-secret"),
        },
      );
    },
  });
  await assert.rejects(claudeCode(t, ports).adapter.readUsage(), (error) => {
    assert.ok(error instanceof UsageReadError);
    assert.equal(error.message, "the Claude Code usage request failed");
    assert.doesNotMatch(inspect(error), /synthetic-|response-body/);
    return true;
  });
});

const working = [
  "I'll read the issue and its discussion first.",
  "Bash(gh issue view 371 --comments)",
];

test("Claude Code's limit errors at the end of a raw log are usage limits, with any stated reset", (t) => {
  const { adapter } = claudeCode(t);
  for (const [error, reset] of [
    ["You've hit your session limit · resets 12:50pm (UTC)", "12:50pm (UTC)"],
    [
      "You've hit your weekly limit · resets Oct 20, 3pm (Europe/Berlin)",
      "Oct 20, 3pm (Europe/Berlin)",
    ],
    [
      "You’ve hit your limit · resets 3pm (America/New_York)",
      "3pm (America/New_York)",
    ],
    ["5-hour limit reached ∙ resets 3pm", "3pm"],
    ["Claude AI usage limit reached|1760356800", null],
    [
      "Claude usage limit reached. Your limit will reset at 3pm (UTC).",
      "3pm (UTC)",
    ],
  ] as const) {
    // Claude Code shows its limit as the session's last text and as its
    // error result, which Sandcastle's failure line carries.
    assert.deepEqual(
      adapter.usageLimit(
        rawRunLog("claude-code", [...working, error], [error]),
      ),
      { reset },
      error,
    );
    // An agent that exits cleanly after the limit still ends on it.
    assert.deepEqual(
      adapter.usageLimit(rawRunLog("claude-code", [...working, error])),
      { reset },
      error,
    );
  }
});

test("a Claude Code failure without its limit error, or prose about limits, is no usage limit", (t) => {
  const { adapter } = claudeCode(t);
  for (const log of [
    rawRunLog("claude-code", working, [
      'API Error: 500 {"type":"error","error":{"type":"api_error"}}',
    ]),
    rawRunLog("claude-code", [
      ...working,
      "The tests failed because you've hit your session limit · resets 12:50pm (UTC) in the fixture.",
      "GitHub's API rate limit reached, so I stopped.",
    ]),
    // A limit long before the end is no limit the run ended on.
    rawRunLog("claude-code", [
      "You've hit your session limit · resets 12:50pm (UTC)",
      ...Array.from({ length: 40 }, (_, line) => `Bash(echo ${line})`),
    ]),
    "",
  ])
    assert.equal(adapter.usageLimit(log), null);
});

test("Claude Code's login expiry is its usage login copy's, and unknown without a readable one", async (t) => {
  const root = directory(t);
  const credential = join(root, "setup-token");
  const usageCredential = join(root, "usage.json");
  writeFileSync(credential, "synthetic-launch-secret");
  const adapter = (usage?: string) =>
    createRegistry(
      {
        "claude-code": {
          credential,
          ...(usage !== undefined && { usageCredential: usage }),
        },
      },
      { effort: "high" },
      fakePorts().ports,
    ).providers.get("claude-code")!;
  // The setup token carries no expiry.
  assert.equal(await adapter().loginExpiry(), null);
  const expiresAt = Date.parse("2026-11-16T12:00:00.000Z");
  // An expired copy still reports its expiry.
  for (const at of [expiresAt, 1]) {
    writeFileSync(
      usageCredential,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "synthetic-login-secret",
          refreshToken: "synthetic-refresh-secret",
          expiresAt: at,
        },
      }),
    );
    assert.deepEqual(
      await adapter(usageCredential).loginExpiry(),
      new Date(at),
    );
  }
  for (const content of [
    undefined,
    "synthetic-login-secret not JSON",
    "null",
    JSON.stringify({ claudeAiOauth: { expiresAt: "tomorrow" } }),
    JSON.stringify({ claudeAiOauth: { expiresAt: 1e20 } }),
  ]) {
    if (content === undefined) rmSync(usageCredential, { force: true });
    else writeFileSync(usageCredential, content);
    assert.equal(await adapter(usageCredential).loginExpiry(), null);
  }
});
