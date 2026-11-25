import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { run, type BindMountSandboxHandle } from "@ai-hero/sandcastle";
import { createRegistry } from "../src/providers.ts";
import { createRedactor } from "../src/redaction.ts";
import { followRunLog, readLogEnd } from "../src/run-log.ts";
import { directory, fakePorts, request } from "./fakes.ts";

// Real Sandcastle parsing and file logging over a sandbox that emits scripted
// agent stdout and stderr. No Docker daemon or provider login is involved.
// A gap between lines outlasts Sandcastle's 50 ms text debounce and lets its
// unawaited log writes land, as between real agent events.
const settled = 100;

async function launchLog(
  t: TestContext,
  events: unknown[],
  provider = "codex",
  exitCode = 1,
  gap = 0,
) {
  const root = directory(t);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", root]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "base",
  ]);
  const credential = join(root, "credential");
  writeFileSync(
    credential,
    provider === "codex"
      ? '{"tokens":{"access_token":"synthetic-login-secret"}}'
      : "synthetic-login-secret",
  );
  const raw = join(root, "agent.log");
  const published = join(root, "published.log");
  const redactor = createRedactor();
  const log = await followRunLog(raw, published, redactor.redact);
  const sandbox = {
    name: "scripted-agent",
    env: {},
    sandboxHomedir: "/home/agent",
    tag: "bind-mount" as const,
    async create(): Promise<BindMountSandboxHandle> {
      return {
        worktreePath: root,
        async exec(command, options) {
          if (command.startsWith("git config --global "))
            return { stdout: "", stderr: "", exitCode: 0 };
          if (command.startsWith("git "))
            return {
              stdout: execSync(command, { cwd: root, encoding: "utf8" }),
              stderr: "",
              exitCode: 0,
            };
          assert.match(command, /^(codex exec|claude --print) /);
          const lines = events.map((event) =>
            typeof event === "string" ? event : JSON.stringify(event),
          );
          for (const line of lines) {
            options?.onLine?.(line);
            if (gap) await sleep(gap);
          }
          return {
            stdout: lines.join("\n"),
            stderr: "Reading prompt from stdin...\n",
            exitCode,
          };
        },
        async copyFileIn() {
          throw new Error("unexpected file copy");
        },
        async copyFileOut() {
          throw new Error("unexpected file copy");
        },
        async close() {},
      };
    },
  };
  const { ports } = fakePorts({ sandcastle: { run, docker: () => sandbox } });
  const adapter = createRegistry(
    { [provider]: { credential } },
    { effort: "high" },
    ports,
  ).providers.get(provider)!;
  const launched = adapter.launch({
    ...request,
    cwd: root,
    log: raw,
    delivered: redactor.add,
  });
  try {
    if (exitCode === 0) await launched;
    else
      await assert.rejects(
        launched,
        new RegExp(
          `${provider} exited with code ${exitCode}:\\s*Reading prompt from stdin`,
        ),
      );
  } finally {
    await log.close();
  }
  return {
    published: readFileSync(published, "utf8"),
    tail: await readLogEnd(raw),
    adapter,
  };
}

test("a failed Codex run publishes its turn failure before Sandcastle's stderr-only failure", async (t) => {
  const { published, tail } = await launchLog(t, [
    {
      type: "turn.failed",
      error: { message: "stream disconnected before completion" },
    },
  ]);
  assert.match(
    published,
    /stream disconnected before completion\nAgent invocation failed: codex exited with code 1:\s*Reading prompt from stdin/,
  );
  assert.match(tail, /stream disconnected before completion/);
});

test("Codex error events are published in arrival order, including repeats", async (t) => {
  const { published } = await launchLog(t, [
    { type: "error", message: "reconnecting" },
    { type: "turn.failed", error: { message: "connection lost" } },
    { type: "error", message: "reconnecting" },
    { type: "error", message: "retries exhausted" },
  ]);
  assert.match(
    published,
    /Agent started\nreconnecting\nconnection lost\nreconnecting\nretries exhausted\nAgent invocation failed:/,
  );
});

test("captured Codex errors use the launch's delivered secrets for published-log redaction", async (t) => {
  const { published, tail } = await launchLog(t, [
    { type: "error", message: "rejected synthetic-login-secret" },
    {
      type: "turn.failed",
      error: { message: "failed with synthetic-login-secret" },
    },
  ]);
  assert.match(published, /rejected <REDACTED>\nfailed with <REDACTED>\n/);
  assert.doesNotMatch(published, /synthetic-login-secret/);
  assert.match(
    tail,
    /rejected synthetic-login-secret\nfailed with synthetic-login-secret\n/,
  );
});

test("a Codex usage limit carried only by a turn failure retains its reset", async (t) => {
  const { adapter, tail } = await launchLog(t, [
    {
      type: "turn.failed",
      error: { message: "You've hit your usage limit. Try again at 3:45 PM." },
    },
  ]);
  assert.deepEqual(adapter.usageLimit(tail), { reset: "3:45 PM" });
});

test("a successful Codex log retains messages and commands, adding only error messages", async (t) => {
  const { published } = await launchLog(
    t,
    [
      { type: "turn.started" },
      { type: "error", message: "retrying connection" },
      "not JSON",
      "{broken JSON",
      null,
      { type: "error", message: { text: "not a message" } },
      { type: "turn.failed" },
      { type: "turn.failed", error: { message: 123 } },
      {
        type: "item.completed",
        item: { type: "agent_message", text: "Reading the issue first.\n" },
      },
      {
        type: "item.started",
        item: { type: "command_execution", command: "gh issue view 311" },
      },
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "gh issue view 311",
          aggregated_output: "private command output",
          exit_code: 0,
        },
      },
      { type: "turn.completed" },
    ],
    "codex",
    0,
    settled,
  );
  assert.equal(
    published.slice(
      published.indexOf("Agent started\n"),
      published.indexOf("Agent stopped\n"),
    ),
    "Agent started\nretrying connection\nReading the issue first.\nBash(gh issue view 311)\n",
  );
  assert.doesNotMatch(
    published,
    /"type"|private command output|not JSON|not a message/,
  );
});

test("a Codex error after an unterminated agent message starts its own line", async (t) => {
  const { published } = await launchLog(
    t,
    [
      {
        type: "item.completed",
        item: { type: "agent_message", text: "Reading the issue first." },
      },
      { type: "error", message: "reconnecting" },
      {
        type: "item.started",
        item: { type: "command_execution", command: "gh issue view 311" },
      },
    ],
    "codex",
    0,
    settled,
  );
  assert.match(
    published,
    /Agent started\nReading the issue first\.\nreconnecting\n\n?Bash\(gh issue view 311\)\n/,
  );
});

test("Claude Code logging retains its messages and commands without capturing raw errors or output", async (t) => {
  const { published } = await launchLog(
    t,
    [
      { type: "error", message: "Codex-shaped error" },
      { type: "turn.failed", error: { message: "Codex-shaped failure" } },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Reading the issue first.\n" }],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "gh issue view 311" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", content: "private command output" }],
        },
      },
    ],
    "claude-code",
    0,
    settled,
  );
  assert.equal(
    published.slice(
      published.indexOf("Agent started\n"),
      published.indexOf("Agent stopped\n"),
    ),
    "Agent started\nReading the issue first.\nBash(gh issue view 311)\n",
  );
  assert.doesNotMatch(published, /"type"|private command output|Codex-shaped/);
});
