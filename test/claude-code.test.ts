import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createRegistry } from "../src/providers.ts";
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
    /^claude --print .* --model 'claude-opus-5-5' --effort max -p -$/,
  );
  assert.deepEqual(first.run.agent.env, {
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-first",
  });
  assert.deepEqual(second.run.agent.env, {
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-renewed",
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

  // The fixture's fuller window is the five-hour one.
  assert.equal(await adapter.readUsage(), 42);
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

test("Claude Code usage is unreadable when the endpoint refuses or omits the windows", async (t) => {
  for (const [response, expected] of [
    [new Response("{}", { status: 401 }), null],
    [new Response('{"five_hour":null,"seven_day":null}'), null],
    [new Response('"unexpected"'), null],
    [new Response('{"seven_day":{"utilization":64}}'), 64],
  ] as const) {
    const ports = fakePorts({ fetch: async () => response });
    assert.equal(await claudeCode(t, ports).adapter.readUsage(), expected);
  }
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
