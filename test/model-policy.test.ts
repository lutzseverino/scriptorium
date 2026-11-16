import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  legacyModelPolicyPath,
  modelPolicyPath,
  readModelPolicy,
} from "../src/model-policy.ts";
import { directory } from "./fakes.ts";

// The repository's optional model policy: preferences only, read strictly.
// `files` maps repository paths to their text; the root is returned.
function repository(t: TestContext, files: Record<string, string> = {}) {
  const root = directory(t);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
// The policy read from the new path.
const policy = (t: TestContext, text: string) =>
  readModelPolicy(repository(t, { [modelPolicyPath]: text }))?.policy;

const preferences = {
  version: 1,
  fallback: "wait",
  runKinds: { review: { provider: "provider-b", model: "model-review" } },
};

test("neither path: the repository has no model policy and launches take host defaults", (t) => {
  assert.equal(readModelPolicy(repository(t)), null);
});

test("only the new path: the policy is read from .scriptorium/model-policy.json", (t) => {
  assert.equal(modelPolicyPath, ".scriptorium/model-policy.json");
  assert.deepEqual(
    readModelPolicy(
      repository(t, { [modelPolicyPath]: JSON.stringify(preferences) }),
    ),
    { path: modelPolicyPath, policy: preferences },
  );
});

test("only the old path: for one configuration version the policy is read from .github/factory-model-policy.json", (t) => {
  assert.equal(legacyModelPolicyPath, ".github/factory-model-policy.json");
  assert.deepEqual(
    readModelPolicy(
      repository(t, { [legacyModelPolicyPath]: JSON.stringify(preferences) }),
    ),
    { path: legacyModelPolicyPath, policy: preferences },
  );
  // Its problems name the path they come from.
  assert.throws(
    () => readModelPolicy(repository(t, { [legacyModelPolicyPath]: "{" })),
    /^Error: The model policy \.github\/factory-model-policy\.json is not JSON: /,
  );
});

test("both paths: the configuration is rejected with an error naming both, whatever either holds", (t) => {
  const message =
    "The model policy is at both .scriptorium/model-policy.json and .github/factory-model-policy.json, and the factory does not choose between them: keep one policy, at .scriptorium/model-policy.json";
  for (const [current, legacy] of [
    [JSON.stringify(preferences), JSON.stringify(preferences)],
    [JSON.stringify(preferences), "{"],
    ["{", JSON.stringify(preferences)],
  ])
    assert.throws(
      () =>
        readModelPolicy(
          repository(t, {
            [modelPolicyPath]: current!,
            [legacyModelPolicyPath]: legacy!,
          }),
        ),
      { message },
    );
  // A present path that cannot be read still counts as present.
  assert.throws(
    () =>
      readModelPolicy(
        repository(t, {
          [`${modelPolicyPath}/unreadable`]: "directory",
          [legacyModelPolicyPath]: JSON.stringify(preferences),
        }),
      ),
    { message },
  );
});

test("a present policy that cannot be read names its path", (t) => {
  assert.throws(
    () =>
      readModelPolicy(
        repository(t, { [`${modelPolicyPath}/unreadable`]: "directory" }),
      ),
    /^Error: The model policy \.scriptorium\/model-policy\.json is unreadable: /,
  );
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
  assert.deepEqual(policy(t, JSON.stringify(value)), value);
  const empty = { version: 1, fallback: "wait", runKinds: { implement: {} } };
  assert.deepEqual(policy(t, JSON.stringify(empty)), empty);
});

test("a present policy that is unreadable or invalid never reads as absence", (t) => {
  assert.throws(() => policy(t, "{"), /is not JSON/);
  const problems = (value: unknown) => {
    try {
      policy(t, JSON.stringify(value));
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
