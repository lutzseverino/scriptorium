import assert from "node:assert/strict";
import { test } from "node:test";
import type { Comment, IssueTracker } from "@lutzseverino/postern";
import {
  isFactoryComment,
  issueComments,
  passContinuation,
} from "../src/run-comment.ts";

// The run comment writer over a fake issue tracker that keeps one issue's
// comments, written by the factory's bot account, and fails the writes the
// test asks it to.
function tracker(existing: Comment[] = []) {
  const comments = [...existing];
  const writes: string[] = [];
  const failing = new Set<string>();
  let next = 100;
  const fake = {
    async comments() {
      return comments.map((comment) => ({ ...comment }));
    },
    async createComment(_issue: number, body: string) {
      writes.push("create");
      if (failing.has("create")) throw new Error("create failed");
      const comment: Comment = {
        id: next,
        nodeId: `IC_${next}`,
        url: `https://platform.test/c/${next++}`,
        author: { login: "factory[bot]", bot: true },
        body,
        createdAt: "2026-11-08T00:00:00Z",
        updatedAt: "2026-11-08T00:00:00Z",
      };
      comments.push(comment);
      return { ...comment };
    },
    async updateComment(id: number, body: string) {
      writes.push("update");
      if (failing.has("update")) throw new Error("update failed");
      const comment = comments.find((comment) => comment.id === id)!;
      comment.body = body;
      return { ...comment };
    },
  } as unknown as IssueTracker;
  return { tracker: fake, comments, writes, failing };
}

const configuration = {
  labels: {
    ready: "ready",
    running: "running",
    paused: "paused",
    failed: "failed",
  },
  contractResult: { marker: "contract", author: "validator[bot]" },
  runKinds: { review: { skill: "review", arguments: "" } },
};
const run = (comment: Comment) =>
  comment.body.split("\n").at(-1)!.startsWith("<!-- scriptorium:run ");
const action = (comment: Comment) =>
  comment.body.split("\n").at(-1)!.startsWith("<!-- scriptorium:action ");
const facts = {
  provider: "codex",
  model: "gpt-5.5",
  effort: "high",
  attempt: 1,
};

test("a pass through every phase leaves one run comment, edited in place, and acts only when a person must", async () => {
  const fake = tracker();
  const { write } = issueComments(fake.tracker, configuration);
  await write(4, { phase: "triage", facts: { ...facts, state: "running" } });
  await write(
    4,
    {
      phase: "triage",
      facts: { state: "stopped", reason: "waits in `reporter`" },
    },
    { key: "stop:a", stopped: "reporter" },
  );
  // Each pass that finds the stop again tells nobody again.
  await write(
    4,
    {
      phase: "triage",
      facts: { state: "stopped", reason: "waits in `reporter`" },
    },
    { key: "stop:a", stopped: "reporter" },
  );
  await write(4, {
    phase: "triage",
    facts: { state: "done", link: "https://platform.test/r/1" },
    result: { body: "The brief." },
  });
  await write(4, { phase: "implement", facts: { ...facts, state: "running" } });
  await write(4, {
    phase: "implement",
    facts: { state: "paused", reason: "usage limit", reset: null },
  });
  await write(4, {
    phase: "implement",
    facts: { ...facts, state: "running", reason: undefined, reset: undefined },
  });
  await write(4, { phase: "implement", facts: { state: "done" } });
  await write(4, {
    phase: "review",
    facts: { ...facts, provider: "claude-code", state: "running", round: 1 },
  });
  await write(4, { phase: "merge", facts: { state: "merged" }, final: true });
  assert.equal(fake.comments.filter(run).length, 1);
  assert.equal(fake.comments.filter(action).length, 1);
  assert.match(
    fake.comments.find(action)!.body,
    /^The factory waits in `reporter` for an answer\. See \[the run comment\]\(https:\/\/platform\.test\/c\/100\)\.\n/,
  );
  const body = fake.comments.find(run)!.body;
  assert.match(body, /^\*\*Factory run: merged\*\*\n/);
  assert.match(
    body,
    /- \[x\] Triage: done · `codex\/gpt-5\.5@high`, attempt 1 · \[result\]\(https:\/\/platform\.test\/r\/1\)\n/,
  );
  assert.match(body, /- \[x\] Implement: done · `codex\/gpt-5\.5@high`/);
  assert.doesNotMatch(body, /paused|usage limit/);
  assert.match(
    body,
    // The merge finishes the review it ended.
    /- \[x\] Review: done · `claude-code\/gpt-5\.5@high`, attempt 1, round 1\n/,
  );
  assert.match(body, /- \[x\] Merge: merged\n/);
  // The latest result survives later edits that carry none.
  assert.match(
    body,
    /<summary>Latest run result<\/summary>\n\n<!-- scriptorium:run-body -->\nThe brief\.\n<!-- \/scriptorium:run-body -->/,
  );
});

test("a write after a final one starts the next pass, and a retried final write edits the same comment", async () => {
  const fake = tracker();
  const { write } = issueComments(fake.tracker, configuration);
  const failure = {
    phase: "implement" as const,
    facts: { state: "failed" as const, reason: "no pull request" },
    final: true as const,
  };
  const told = { key: "failed", failed: "failed", reason: "no pull request" };
  await write(4, { phase: "implement", facts: { ...facts, state: "running" } });
  fake.failing.add("create");
  await assert.rejects(write(4, failure, told));
  fake.failing.clear();
  // The retry finds the final run comment and posts its action once.
  await write(4, failure, told);
  await write(4, failure, told);
  assert.deepEqual(
    fake.comments.map((comment) => (run(comment) ? "run" : "action")),
    ["run", "action"],
  );
  assert.match(fake.comments[0].body, /^\*\*Factory run: failed\*\*\n/);
  assert.match(
    fake.comments[1].body,
    /^The factory run failed: no pull request\. Remove `failed` to run it again\. See \[the run comment\]\(https:\/\/platform\.test\/c\/100\)\.\n/,
  );
  // Removing the failed label to retry starts a new pass, and a new action.
  await write(4, { phase: "implement", facts: { ...facts, state: "running" } });
  await write(4, failure, told);
  assert.deepEqual(
    fake.comments.map((comment) => (run(comment) ? "run" : "action")),
    ["run", "action", "run", "action"],
  );
  assert.match(fake.comments[2].body, /^\*\*Factory run: failed\*\*\n/);
  assert.doesNotMatch(fake.comments[2].body, /Triage|Review: running/);
  assert.match(fake.comments[3].body, /\(https:\/\/platform\.test\/c\/102\)/);
});

test("an unchanged write edits nothing, and the marker holds its facts without closing its HTML comment", async () => {
  const fake = tracker();
  const { write } = issueComments(fake.tracker, {
    ...configuration,
    comments: { run: "{#merge}{state}: {reason}{/merge}" },
  });
  const update = {
    phase: "merge" as const,
    facts: { state: "awaiting merge" as const, reason: "a --> b <!-- c" },
  };
  await write(4, update);
  await write(4, update);
  assert.deepEqual(fake.writes, ["create"]);
  const [text, marker] = fake.comments[0].body.split("\n");
  assert.equal(text, "awaiting merge: a --> b <!-- c");
  assert.match(marker, /^<!-- scriptorium:run \{[^<>]*\} -->$/);
  assert.equal(
    JSON.parse(marker.slice("<!-- scriptorium:run ".length, -4)).phases.merge
      .reason,
    "a --> b <!-- c",
  );
});

test("only the factory's own marked comments count as its run and action comments", async () => {
  const marked = (body: string, bot = true): Comment => ({
    id: 7,
    nodeId: "IC_7",
    url: "https://platform.test/c/7",
    author: { login: bot ? "factory[bot]" : "owner", bot },
    body,
    createdAt: "2026-11-08T00:00:00Z",
    updatedAt: "2026-11-08T00:00:00Z",
  });
  const runBody = 'Text\n<!-- scriptorium:run {"phases":{}} -->';
  const actionBody =
    'Act\n<!-- scriptorium:action {"run":1,"occasion":"failed"} -->';
  assert.ok(isFactoryComment(marked(runBody)));
  assert.ok(isFactoryComment(marked(actionBody)));
  assert.ok(
    isFactoryComment(
      marked(
        "<!-- scriptorium:hold:readiness -->\nThe factory is holding this issue: a reason.",
        false,
      ),
    ),
  );
  for (const comment of [
    marked(runBody, false),
    marked(actionBody, false),
    marked(`${runBody}\nMore`),
    marked('<!-- scriptorium:run {"phases":{}} -->\nText'),
    marked('Text\n<!-- scriptorium:run {"phases":1} -->'),
    marked("Text\n<!-- scriptorium:run {broken} -->"),
  ])
    assert.equal(isFactoryComment(comment), false, comment.body);
  // A person's comment carrying a run marker is not the pass's comment.
  const fake = tracker([marked(runBody, false)]);
  await issueComments(fake.tracker, configuration).write(4, {
    phase: "implement",
    facts: { state: "running" },
  });
  assert.deepEqual(fake.writes, ["create"]);
});

test("a released stop's continuation lasts until the next write, and a later phase finishes the stopped one", async () => {
  const fake = tracker();
  const { write } = issueComments(fake.tracker, configuration);
  const resume = {
    since: "2026-11-08T00:00:00Z",
    pullRequests: [
      {
        number: 42,
        headBranch: "factory/issue-4",
        state: "open" as const,
        createdAt: "2026-11-08T00:00:00Z",
      },
    ],
  };
  await write(4, { phase: "triage", facts: { ...facts, state: "running" } });
  assert.equal(passContinuation(fake.comments), undefined);
  await write(4, {
    phase: "triage",
    facts: { state: "stopped", reason: "waits in `owner`" },
    resume,
  });
  assert.deepEqual(passContinuation(fake.comments), resume);
  await write(4, { phase: "implement", facts: { ...facts, state: "running" } });
  assert.equal(passContinuation(fake.comments), undefined);
  assert.match(
    fake.comments[0].body,
    /- \[x\] Triage: done · `codex\/gpt-5\.5@high`, attempt 1\n- \[ \] Implement: running/,
  );
  // A finished pass continues nothing.
  await write(4, {
    phase: "implement",
    facts: { state: "stopped" },
    resume,
  });
  await write(4, { phase: "merge", facts: { state: "merged" }, final: true });
  assert.equal(passContinuation(fake.comments), undefined);
});
