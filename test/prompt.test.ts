import assert from "node:assert/strict";
import { test } from "node:test";
import { prompt, type PromptFacts } from "../src/prompt.ts";
import { repositoryHold } from "../src/repository-holds.ts";
import type { Continuation } from "../src/factory.ts";
import { holdKeys } from "../src/hold-comments.ts";

const facts: PromptFacts = {
  invocation: "/ship #4",
  runClone: "/host/run-clones/issue-4",
  credentialLimits: "Supplied credential: contents read, pull requests read.",
  retryTail: "last line supplied by the host\n",
  holds: [],
  resultPath: "/run/factory/result/result.json",
};

test("prompt refers run-clone recovery to the run's working directory without changing the record", () => {
  const continuation: Continuation = {
    attempt: 2,
    recovery: {
      branch: "factory/issue-4",
      head: "abc",
      worktree: facts.runClone,
    },
  };
  const original = structuredClone(continuation);
  const rendered = prompt(continuation, facts);
  assert.ok(!rendered.includes(facts.runClone));
  assert.match(
    rendered,
    /Recovery state: {"branch":"factory\/issue-4","head":"abc","worktree":"\."}/,
  );
  assert.match(
    rendered,
    /The preserved worktree is your current working directory\./,
  );
  assert.match(rendered, /committed, staged, unstaged and untracked changes/);
  assert.match(rendered, /Revalidate recovered work before publication/);
  assert.deepEqual(continuation, original);
});

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
  assert.doesNotMatch(
    rendered,
    /The preserved worktree is your current working directory/,
  );
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

test("prompt keeps recovery without a worktree unchanged", () => {
  const rendered = prompt(
    { attempt: 2, recovery: { branch: "factory/issue-4", head: "abc" } },
    facts,
  );
  assert.match(
    rendered,
    /Recovery state: {"branch":"factory\/issue-4","head":"abc"}\. Continue from this preserved branch and worktree/,
  );
  assert.doesNotMatch(
    rendered,
    /The preserved worktree is your current working directory/,
  );
});

test("prompt transmits host model facts unchanged across triage continuations", () => {
  const models = {
    effort: "medium",
    defaults: {
      triage: { provider: "codex", model: "gpt-work", effort: "low" },
    },
    catalog: [
      {
        identity: "codex/gpt-work",
        provider: "codex",
        model: "gpt-work",
        guidance: "Routine work",
        effort: "low",
        effectiveEffort: "low",
      },
    ],
  };
  for (const continuation of [
    { attempt: 1, runKind: "triage" as const },
    { attempt: 1, runKind: "triage" as const, relaunch: true },
  ] satisfies Continuation[]) {
    const rendered = prompt(continuation, { ...facts, models });
    assert.ok(rendered.includes(`Host models: ${JSON.stringify(models)}`));
    assert.equal(rendered, prompt(continuation, { ...facts, models }));
    assert.doesNotMatch(rendered, /choose.*model|cheaper|best.*fit/);
  }
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

test("every continuation tells the run that a refreshed token reaches only new GitHub CLI calls", () => {
  const createdAt = "2026-10-09T11:00:00Z";
  const target = {
    number: 40,
    headCommit: "abc",
    baseBranch: "main",
    createdAt,
  };
  const continuations: Record<string, Continuation> = {
    implement: { attempt: 1 },
    triage: { attempt: 1, runKind: "triage" },
    review: { attempt: 1, runKind: "review", target },
    retry: { attempt: 2, retry: { failure: "agent exited", log: "" } },
    "merge relaunch": { attempt: 1, mergeRelaunch: target },
    "review hand-back": { attempt: 1, target, handBacks: 1 },
    "needs-input resume": {
      attempt: 1,
      inputResume: {
        pullRequests: [
          { number: 40, state: "open", headBranch: "b", createdAt },
        ],
      },
    },
    recovery: {
      attempt: 1,
      recovery: { branch: "factory/issue-4", head: "abc" },
    },
  };
  const upload =
    "Use only the supplied credentials for their documented purposes. FACTORY_ATTACHMENT_UPLOAD_TOKEN_FILE names the upload credential.";
  for (const [name, continuation] of Object.entries(continuations))
    for (const credentialLimits of [facts.credentialLimits, upload]) {
      const rendered = prompt(continuation, { ...facts, credentialLimits });
      assert.ok(rendered.includes(credentialLimits), name);
      const [rotation, ...others] = rendered
        .split("\n")
        .filter((line) => line.includes("GitHub credential is replaced"));
      assert.equal(others.length, 0, name);
      assert.match(
        rotation,
        /Each new GitHub CLI or Git call reads the current token when it starts.*a process that is already running keeps the token it started with/,
        name,
      );
      assert.match(
        rotation,
        /not keep a GitHub CLI process running through a long wait.*gh pr checks --watch.*gh run watch.*repeating separate short calls/,
        name,
      );
      // The instruction sets no time value of its own.
      assert.doesNotMatch(rotation, /\d|minute|second|hour/, name);
    }
});
