// Exercise the pinned CLI's real Bash tool against a local scripted API.
// No provider credential or live model is used, and delivery is text only.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { createRegistry } from "../src/providers.ts";
import { command, directory, fakePorts, request } from "./fakes.ts";

const dockerfile = readFileSync(
  new URL("../src/agent-layer.Dockerfile", import.meta.url),
  "utf8",
);
const pinned = /claude_version=([^;]+);/.exec(dockerfile)![1];
let installed = "";
try {
  installed = execFileSync("claude", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  /* CLI exercises are optional on hosts without the pinned binary. */
}

for (const { exit, timeout } of [
  { exit: 0, timeout: 30_000 },
  { exit: 7, timeout: 30_000 },
  { exit: 0, timeout: 100 },
])
  test(
    `pinned Claude consumes foreground validation exit ${exit}, timeout ${timeout}, despite conflicting settings`,
    {
      skip:
        !installed.startsWith(`${pinned} `) && `requires Claude Code ${pinned}`,
      timeout: 60_000,
    },
    async (t) => {
      const root = directory(t);
      mkdirSync(join(root, ".claude"));
      writeFileSync(
        join(root, ".claude/settings.json"),
        JSON.stringify({
          env: {
            CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0",
            BASH_DEFAULT_TIMEOUT_MS: "1",
            BASH_MAX_TIMEOUT_MS: "1",
          },
        }),
      );
      const credential = join(root, "setup-token");
      writeFileSync(credential, "synthetic-setup-token");
      const ports = fakePorts();
      const adapter = createRegistry(
        { "claude-code": { credential } },
        ports.ports,
      ).providers.get("claude-code")!;
      await adapter.launch({ ...request, idleTimeoutSeconds: 60 });
      const launch = ports.runs[0].run;
      let toolResults: any[] = [];
      let turns = 0;
      const server = createServer(async (req, res) => {
        let data = "";
        for await (const chunk of req) data += chunk;
        if (!req.url?.startsWith("/v1/messages")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
          return;
        }
        const body = JSON.parse(data);
        const bash = body.tools?.find((tool: any) => tool.name === "Bash");
        // Both explicit backgrounding and TaskOutput notification waiting are
        // unavailable, even with project env settings trying to enable them.
        assert.ok(bash);
        assert.equal(bash.input_schema.properties.run_in_background, undefined);
        assert.ok(!body.tools.some((tool: any) => tool.name === "TaskOutput"));
        const results = body.messages.flatMap((message: any) =>
          Array.isArray(message.content)
            ? message.content.filter(
                (block: any) => block.type === "tool_result",
              )
            : [],
        );
        toolResults = results;
        const turn = ++turns;
        const block =
          turn === 1
            ? {
                type: "tool_use",
                id: "background",
                name: "Bash",
                input: {
                  command: "touch background-started",
                  run_in_background: true,
                },
              }
            : turn === 2
              ? {
                  type: "tool_use",
                  id: "validation",
                  name: "Bash",
                  input: {
                    command: `sleep 12; printf 'VALIDATION_FINISHED\\n'; exit ${exit}`,
                    description: "Run validation",
                    timeout,
                  },
                }
              : {
                  type: "text",
                  text: results.at(-1)?.is_error
                    ? "VALIDATION_FAILED_OWNER_HANDOFF"
                    : "VALIDATION_PASSED_DELIVERY",
                };
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (event: string, value: object) =>
          res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
        send("message_start", {
          type: "message_start",
          message: {
            id: `msg_${turns}`,
            type: "message",
            role: "assistant",
            content: [],
            model: body.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        });
        send("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block:
            block.type === "text"
              ? { type: "text", text: "" }
              : { ...block, input: {} },
        });
        send("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta:
            block.type === "text"
              ? { type: "text_delta", text: block.text }
              : {
                  type: "input_json_delta",
                  partial_json: JSON.stringify(block.input),
                },
        });
        send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: block.type === "text" ? "end_turn" : "tool_use",
            stop_sequence: null,
          },
          usage: { output_tokens: 10 },
        });
        send("message_stop", { type: "message_stop" });
        res.end();
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      t.after(() => server.close());
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      // Whitelist a fresh environment and home: no inherited provider login,
      // subscription, proxy or connector is used by this isolated exercise.
      const child = spawn("sh", ["-c", command(launch)], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          CLAUDE_CONFIG_DIR: join(root, "config"),
          CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:
            launch.agent.env!.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          ANTHROPIC_API_KEY: "synthetic-local-api-key",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      t.after(() => child.kill("SIGKILL"));
      child.stdin.end(
        "Run validation, inspect its result, then deliver or hand off.",
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const status = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      assert.equal(status, 0, stderr);
      assert.equal(turns, 3);
      assert.equal(toolResults.length, 2);
      assert.match(
        JSON.stringify(toolResults[0].content),
        /unexpected parameter `run_in_background`/,
      );
      assert.equal(existsSync(join(root, "background-started")), false);
      const validation = toolResults[1];
      const failed = exit !== 0 || timeout === 100;
      if (timeout !== 100)
        assert.match(JSON.stringify(validation.content), /VALIDATION_FINISHED/);
      else
        assert.doesNotMatch(
          JSON.stringify(validation.content),
          /VALIDATION_FINISHED/,
        );
      assert.equal(Boolean(validation.is_error), failed);
      if (exit !== 0)
        assert.match(JSON.stringify(validation.content), /Exit code 7/);
      assert.doesNotMatch(
        JSON.stringify(validation),
        /running in background|task_id/i,
      );
      assert.match(
        stdout,
        failed
          ? /VALIDATION_FAILED_OWNER_HANDOFF/
          : /VALIDATION_PASSED_DELIVERY/,
      );
      if (failed) assert.doesNotMatch(stdout, /VALIDATION_PASSED_DELIVERY/);
    },
  );
