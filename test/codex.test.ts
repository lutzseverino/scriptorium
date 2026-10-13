import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createRegistry } from "../src/providers.ts";
import { readCodexUsage } from "../src/providers/codex.ts";
import { command, directory, fakePorts, request } from "./fakes.ts";

const login = '{"tokens":{"access_token":"secret"}}';

function codex(t: TestContext, executable = "/nonexistent/codex") {
  const root = directory(t);
  const credential = join(root, "auth.json");
  writeFileSync(credential, login);
  const { ports, runs } = fakePorts({ codexExecutable: executable });
  const adapter = createRegistry(
    { codex: { credential } },
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
// writes state there as Codex does, and answers, refuses, or never replies.
function fakeCodex(root: string, behavior: "answer" | "refuse" | "hang") {
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
const reply = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (${JSON.stringify(behavior)} === "hang") return;
  if (message.method === "initialize") reply({ id: 0, result: {} });
  else if (message.method !== "account/rateLimits/read") return;
  else if (${JSON.stringify(behavior)} === "refuse")
    reply({ id: 1, error: { message: "not signed in" } });
  else reply({ id: 1, result: {
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1 },
      secondary: { usedPercent: 64, windowDurationMins: 10080, resetsAt: 2 },
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

  // The fuller window is the weekly one.
  assert.equal(await adapter.readUsage(), 64);
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
  assert.equal(await adapter.readUsage(), 64);
  assert.notEqual(fake.seen().home, first.home);
  assert.equal(fake.seen().auth, '{"tokens":{"access_token":"renewed"}}');
  assert.equal(existsSync(fake.seen().home), false);
});

test("a Codex usage read removes its login copy after an error or a timeout", async (t) => {
  const root = directory(t);
  for (const [behavior, message] of [
    ["refuse", /not signed in/],
    ["hang", /timed out/],
  ] as const) {
    const fake = fakeCodex(root, behavior);
    const { credential } = codex(t, fake.executable);
    await assert.rejects(
      readCodexUsage(credential, fake.executable, 500),
      (error: Error) => {
        assert.match(error.message, message);
        assert.doesNotMatch(error.message, /secret/);
        return true;
      },
    );
    assert.equal(existsSync(fake.seen().home), false, behavior);
  }
});
