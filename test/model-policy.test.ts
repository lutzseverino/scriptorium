import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { modelPolicyPath, readModelPolicy } from "../src/model-policy.ts";
import { directory } from "./fakes.ts";

// The repository's optional model policy: preferences only, read strictly.
function policy(t: TestContext, text?: string): string {
  const root = directory(t);
  const path = join(root, modelPolicyPath);
  if (text !== undefined) {
    mkdirSync(join(root, ".github"), { recursive: true });
    writeFileSync(path, text);
  }
  return path;
}

test("a repository without a model policy has none", (t) => {
  assert.equal(readModelPolicy(policy(t)), null);
});

test("a policy names per-kind preferences, the issue label as a source, and its fallback", (t) => {
  const value = {
    version: 1,
    fallback: "host-default",
    runKinds: {
      triage: { provider: "provider-a", model: "model-triage" },
      implement: {
        initial: {
          provider: "provider-a",
          model: "model-impl",
          effort: "high",
        },
        retry: { source: "issue-label" },
      },
      review: { provider: "provider-b", model: "model-review" },
    },
  };
  assert.deepEqual(readModelPolicy(policy(t, JSON.stringify(value))), value);
  const empty = { version: 1, fallback: "wait", runKinds: { implement: {} } };
  assert.deepEqual(readModelPolicy(policy(t, JSON.stringify(empty))), empty);
});

test("a present policy that is unreadable or invalid never reads as absence", (t) => {
  assert.throws(() => readModelPolicy(policy(t, "{")), /is not JSON/);
  const problems = (value: unknown) => {
    try {
      readModelPolicy(policy(t, JSON.stringify(value)));
    } catch (error) {
      return (error as Error).message.split("\n").slice(1);
    }
    assert.fail("the policy is invalid");
  };
  assert.deepEqual(problems([]), ["- the policy: is not an object"]);
  assert.deepEqual(problems({ version: 2, fallback: "later", extra: 1 }), [
    "- extra: is not a model policy field",
    "- runKinds: is missing",
    "- version: must be 1",
    '- fallback: must be "wait" or "host-default"',
  ]);
  assert.deepEqual(
    problems({
      version: 1,
      fallback: "wait",
      runKinds: {
        triage: { source: "issue-label", provider: "provider-a" },
        review: { provider: " provider-a", model: "", effort: 7 },
        implement: { initial: { source: "default" }, later: {} },
        merge: {},
      },
    }),
    [
      "- runKinds.merge: is not a model policy field",
      "- runKinds.triage.provider: is not a model policy field",
      "- runKinds.review.provider: is not a non-empty trimmed string",
      "- runKinds.review.model: is not a non-empty trimmed string",
      "- runKinds.review.effort: is not a non-empty trimmed string",
      "- runKinds.implement.later: is not a model policy field",
      '- runKinds.implement.initial.source: must be "issue-label"',
    ],
  );
});
