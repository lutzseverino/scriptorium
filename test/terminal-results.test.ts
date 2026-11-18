import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import type { Comment, IssueTracker } from "@lutzseverino/postern";
import { issueComments } from "../src/run-comment.ts";
import { resultPost } from "../src/run-result.ts";
import type { FactoryConfiguration } from "../src/factory-configuration.ts";

const configuration: FactoryConfiguration = {
  version: 2,
  labels: {
    ready: "ready",
    running: "running",
    failed: "failed",
    needsInput: "answer",
    paused: "paused",
  },
  contractResult: { marker: "contract", author: "validator[bot]" },
  modelLabelPrefix: "model:",
  skill: "implement",
  arguments: "",
};

const facts = {
  id: "first-run",
  kind: "implement" as const,
  provider: "codex",
  model: "model",
  effort: "high",
  attempt: 1,
};

function command(input: unknown, args = ["--author", "factory[bot]"]) {
  const result = spawnSync(
    process.execPath,
    ["src/main.ts", "results", ...args],
    {
      cwd: new URL("..", import.meta.url),
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.ifError(result.error);
  return result;
}

test("external readers obtain a published result and ignore presentation edits", () => {
  const post = resultPost(
    { outcome: "done", body: "Delivered." },
    facts,
    configuration,
  );
  const comment = {
    body: post.comment,
    author: { login: "factory[bot]" },
    id: 1,
    updatedAt: "2026-11-15T00:00:00Z",
  };
  const first = command([comment]);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), {
    version: 1,
    results: [{ run: "first-run", outcome: "done" }],
  });
  const edited = command([
    {
      ...comment,
      body: comment.body.replace("Delivered.", "Delivered with more detail."),
      updatedAt: "2026-11-16T00:00:00Z",
    },
  ]);
  assert.equal(edited.status, 0, edited.stderr);
  assert.deepEqual(JSON.parse(edited.stdout), JSON.parse(first.stdout));
});

test("an existing report publishes distinct results and retains identities through later edits and retries", async () => {
  const comments: Comment[] = [];
  const tracker = {
    async comments() {
      return structuredClone(comments);
    },
    async createComment(_issue: number, body: string) {
      const comment: Comment = {
        id: comments.length + 1,
        nodeId: "IC_report",
        url: "https://platform.test/report",
        author: { login: "factory[bot]", bot: true },
        body,
        createdAt: "2026-11-16T00:00:00Z",
        updatedAt: "2026-11-16T00:00:00Z",
      };
      comments.push(comment);
      return structuredClone(comment);
    },
    async updateComment(id: number, body: string) {
      const comment = comments.find((entry) => entry.id === id)!;
      comment.body = body;
      return structuredClone(comment);
    },
  } as unknown as IssueTracker;
  const observe = () => {
    const observed = command(comments);
    assert.equal(observed.status, 0, observed.stderr);
    return JSON.parse(observed.stdout);
  };
  const { write } = issueComments(tracker, configuration);
  await write(4, { phase: "implement", facts: { state: "running" } });
  const original = comments[0].id;
  assert.deepEqual(observe(), { version: 1, results: [] });
  const first = {
    body: "Delivered.",
    terminal: { run: "first-run", outcome: "done" as const },
  };
  await write(4, {
    phase: "implement",
    facts: { state: "done" },
    result: first,
  });
  assert.equal(comments.length, 1);
  assert.equal(comments[0].id, original);
  assert.deepEqual(observe(), {
    version: 1,
    results: [{ run: "first-run", outcome: "done" }],
  });
  // Recreate the writer as after a restart, and change only presentation.
  const restarted = issueComments(tracker, configuration);
  await restarted.write(4, {
    phase: "review",
    facts: { state: "running", reason: "Review in progress" },
    result: { ...first, body: "More detail about delivery." },
  });
  assert.deepEqual(observe().results, [{ run: "first-run", outcome: "done" }]);
  // A later run has the same outcome and body but a distinct identity.
  await restarted.write(4, {
    phase: "review",
    facts: { state: "done" },
    result: { ...first, terminal: { run: "second-run", outcome: "done" } },
  });
  await restarted.write(4, {
    phase: "merge",
    facts: { state: "merged" },
    final: true,
  });
  assert.deepEqual(observe().results, [
    { run: "first-run", outcome: "done" },
    { run: "second-run", outcome: "done" },
  ]);
  assert.equal(comments.length, 1);
  // A duplicate standalone publication does not create a third result.
  comments.push({
    ...comments[0],
    id: 2,
    body: resultPost(
      { outcome: "done", body: first.body },
      facts,
      configuration,
    ).comment,
  });
  assert.equal(observe().results.length, 2);
});

test("trust comes from the supplied author, never result text or bot marking", () => {
  const body = resultPost(
    { outcome: "stop", state: "answer", body: "Which?" },
    facts,
    configuration,
  ).comment;
  const observed = command([
    { body, author: null },
    { body, author: { login: "outsider[bot]", bot: true } },
    { body, author: { login: "factory", bot: false } },
  ]);
  assert.equal(observed.status, 0, observed.stderr);
  assert.deepEqual(JSON.parse(observed.stdout).results, []);
  const trusted = command(
    [{ body, author: { login: "FACTORY[bot]", bot: false } }],
    ["--author", "app/factory"],
  );
  assert.equal(trusted.status, 0, trusted.stderr);
  assert.deepEqual(JSON.parse(trusted.stdout).results, [
    { run: "first-run", outcome: "stop" },
  ]);
});

test("a piped observation larger than a pipe buffer arrives complete", () => {
  const runs = Array.from(
    { length: 2000 },
    (_, index) => `run-${String(index).padStart(4, "0")}-${"a".repeat(200)}`,
  );
  const observed = command(
    runs.map((id) => ({
      author: { login: "factory[bot]" },
      body: resultPost(
        { outcome: "done", body: "Delivered." },
        { ...facts, id },
        configuration,
      ).comment,
    })),
  );
  assert.equal(observed.status, 0, observed.stderr);
  assert.ok(observed.stdout.length > 65_536);
  assert.deepEqual(
    JSON.parse(observed.stdout).results.map(
      (result: { run: string }) => result.run,
    ),
    runs,
  );
});

test("a reader that writes comments later through a pipe is still observed", async () => {
  const child = spawn(
    process.execPath,
    ["src/main.ts", "results", "--author", "factory[bot]"],
    {
      cwd: new URL("..", import.meta.url),
      timeout: 10_000,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) =>
    child.on("close", resolve),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  child.stdin.end(
    JSON.stringify([
      {
        author: { login: "factory[bot]" },
        body: resultPost(
          { outcome: "done", body: "Delivered." },
          facts,
          configuration,
        ).comment,
      },
    ]),
  );
  assert.equal(await exited, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), {
    version: 1,
    results: [{ run: "first-run", outcome: "done" }],
  });
});

test("invalid input and conflicting outcomes fail without a successful observation", () => {
  for (const input of [{}, [null], [{ body: "text" }]]) {
    const observed = command(input);
    assert.equal(observed.status, 1);
    assert.equal(observed.stdout, "");
    assert.ok(observed.stderr.length > 0);
  }
  for (const args of [[], ["--author", ""], ["--author", "factory", "--other"]])
    assert.equal(command([], args).status, 2);
  const observed = command(
    (["done", "failed"] as const).map((outcome) => ({
      author: { login: "factory[bot]" },
      body: resultPost(
        {
          outcome,
          body: "Result.",
          ...(outcome === "failed" && { reason: "Failed" }),
        },
        facts,
        configuration,
      ).comment,
    })),
  );
  assert.equal(observed.status, 1);
  assert.equal(observed.stdout, "");
  assert.match(observed.stderr, /Conflicting outcomes/);
});
