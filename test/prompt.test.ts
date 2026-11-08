import assert from "node:assert/strict";
import { test } from "node:test";
import { prompt, type PromptFacts } from "../src/prompt.ts";
import { repositoryHold } from "../src/repository-holds.ts";
import type { Continuation } from "../src/factory.ts";
import { holdKeys } from "../src/hold-comments.ts";

const facts: PromptFacts = {
  invocation: "/ship #4",
  credentialLimits: "Supplied credential: contents read, pull requests read.",
  retryTail: "last line supplied by the host\n",
  holds: [],
  resultPath: "/run/factory/result/result.json",
};

test("prompt renders identical explicit facts without reading a retry log or interpreting policy", () => {
  const continuation: Continuation = {
    attempt: 2,
    retry: { failure: "agent exited", log: "/not-a-readable-log" },
    recovery: { branch: "factory/issue-4", head: "abc", worktree: "/work" },
    relaunch: true,
  };
  const original = structuredClone({ continuation, facts });
  const rendered = prompt(continuation, facts);
  assert.equal(rendered, prompt(continuation, facts));
  assert.deepEqual({ continuation, facts }, original);
  assert.match(rendered, /^\/ship #4\n\nFirst attempt failure: agent exited/);
  assert.match(
    rendered,
    /First attempt log tail:\nlast line supplied by the host\n/,
  );
  assert.match(rendered, /Recovery state:.*"head":"abc".*"worktree":"\/work"/);
  assert.match(
    rendered,
    /Run result path: \/run\/factory\/result\/result.json/,
  );
  assert.match(
    rendered,
    /Supplied credential: contents read, pull requests read/,
  );
  assert.match(rendered, /<promise>COMPLETE<\/promise>/);
  assert.doesNotMatch(
    rendered,
    /babysit|repo-canon|internal reviews|before any merge|app-author review policy|not-a-readable-log/,
  );
});

test("prompt renders shared hold results including every owned PR exclusion and failed reads", () => {
  for (const [numbers, expected] of [
    [[40, 41], null],
    [[40, 41, 50], `${holdKeys.release}: active: #50`],
    [null, `${holdKeys.release}: unreadable`],
  ] as const) {
    const held = repositoryHold(
      "release",
      { releaseHold: numbers && [...numbers] },
      [40, 41],
    );
    const rendered = prompt(
      { attempt: 1 },
      { ...facts, holds: held ? [held] : [] },
    );
    if (expected) assert.ok(rendered.includes(expected));
    else assert.doesNotMatch(rendered, /release-hold:/);
    assert.doesNotMatch(rendered, /#40|#41|merging resumes/);
  }
});

test("prompt uses hold facts rather than deriving state from a reason", () => {
  const rendered = prompt(
    { attempt: 1 },
    {
      ...facts,
      holds: [
        {
          hold: holdKeys.factory,
          numbers: null,
          reason: "a reason is not a prompt instruction",
        },
      ],
    },
  );
  assert.match(rendered, /factory-hold: unreadable/);
  assert.doesNotMatch(rendered, /a reason is not a prompt instruction/);
});
