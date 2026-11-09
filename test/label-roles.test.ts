import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  claimLabels,
  exclusionReason,
  labelRoles,
  provisioned,
  transition,
  versionRoles,
  type Labels,
} from "../src/label-roles.ts";

// The one declaration of the factory's label roles, and the consumers that
// derive their role sets from it instead of repeating them.
const source = resolve(import.meta.dirname, "../src");
const read = (file: string) => readFileSync(join(source, file), "utf8");

// Each consumer, the declaration's helper it derives its role set from, and
// the function that uses it.
const consumers = [
  [
    "factory-configuration.ts",
    "versionRoles",
    "function readFactoryConfiguration",
  ],
  ["platform.ts", "provisioned", "async createStateLabels"],
  ["platform.ts", "claimLabels", "async readClosedClaims"],
  ["host.ts", "claimLabels", "async function readClaims"],
  ["host.ts", "askLabels", "async function apply"],
  ["factory.ts", "exclusionReason", "function continuationExclusions"],
  ["factory.ts", "exclusionReason", "function exclusion("],
  ["factory.ts", "priority", "function priorityFirst"],
  ["contract-result.ts", "configured", "function contractResultHold"],
  ["run-result.ts", "configured", "function parseRunResult"],
  ["run-result.ts", "stopLabels", "function stopStates"],
  ["run-ending.ts", "isStopped", "function settleEnding"],
] as const;

test("each label consumer imports its role set from the one declaration", () => {
  for (const [file, helper, consumer] of consumers) {
    const text = read(file);
    assert.match(
      text,
      new RegExp(
        `import \\{[^}]*\\b${helper}\\b[^}]*\\} from "\\./label-roles\\.ts"`,
      ),
      `${file} imports ${helper}`,
    );
    const start = text.indexOf(consumer);
    assert.notEqual(start, -1, `${file} has ${consumer}`);
    // The consumer's body: a platform method's, or a function's.
    const end =
      consumer.startsWith("async ") && !consumer.includes("function")
        ? "\n    },\n"
        : "\n}\n";
    const body = text.slice(start, text.indexOf(end, start));
    assert.match(
      body,
      new RegExp(`\\b${helper}\\(`),
      `${consumer} uses ${helper}`,
    );
  }
});

test("no other module repeats a list of label roles", () => {
  const names = Object.keys(labelRoles).join("|");
  for (const file of readdirSync(source, { recursive: true, encoding: "utf8" }))
    if (file.endsWith(".ts") && file !== "label-roles.ts") {
      const text = read(file);
      assert.doesNotMatch(
        text,
        /\[[^[\]]*\blabels\.\w+[^[\]]*\blabels\.\w+[^[\]]*\]/,
        `${file} lists configured labels`,
      );
      assert.doesNotMatch(
        text,
        new RegExp(`"(?:${names})",\\s*"(?:${names})"`),
        `${file} lists role names`,
      );
    }
});

// Configured names unlike any default, so only the declaration connects them.
const v2: Labels = {
  ready: "queued",
  running: "working",
  failed: "broken",
  needsInput: "question",
  paused: "waiting",
  skip: "manual",
};
const v3: Labels = {
  triage: "triaging",
  reporter: "asking-reporter",
  grill: "grilling",
  owner: "asking-owner",
  ready: "go",
  ownerReview: "owner-gate",
  running: "busy",
  paused: "resting",
  failed: "stuck",
  skip: "manual",
};

test("the factory provisions exactly the labels it writes, with their colours", () => {
  assert.deepEqual(provisioned(v2), [
    { role: "running", name: "working", color: "0052cc" },
    { role: "failed", name: "broken", color: "b60205" },
    { role: "paused", name: "waiting", color: "c5def5" },
    { role: "needsInput", name: "question", color: "fbca04" },
  ]);
  // Version 3's stops, readiness and gates belong to people and agents.
  assert.deepEqual(
    provisioned(v3).map(({ name }) => name),
    ["busy", "stuck", "resting"],
  );
});

test("versions require and accept their own roles", () => {
  const required = (version: 2 | 3) =>
    versionRoles(version)
      .filter(([, need]) => need === "required")
      .map(([name]) => name);
  assert.deepEqual(required(2), [
    "ready",
    "running",
    "failed",
    "paused",
    "needsInput",
  ]);
  assert.deepEqual(required(3), ["ready", "running", "failed", "paused"]);
  assert.ok(!versionRoles(3).some(([name]) => name === "needsInput"));
  assert.equal(versionRoles(3).length, 16);
});

test("transitions write the configured names and claims carry their labels", () => {
  assert.deepEqual(transition(v2, "claim"), { add: "working", remove: [] });
  assert.deepEqual(transition(v2, "release"), {
    add: null,
    remove: ["working", "waiting"],
  });
  assert.deepEqual(transition(v2, "fail"), {
    add: "broken",
    remove: ["working", "waiting"],
  });
  assert.deepEqual(transition(v2, "pause"), {
    add: "waiting",
    remove: ["working"],
  });
  assert.deepEqual(transition(v2, "unpause"), {
    add: "working",
    remove: ["waiting"],
  });
  assert.deepEqual(transition(v2, "complete"), {
    add: null,
    remove: ["broken"],
  });
  assert.deepEqual(claimLabels(v2), ["working", "waiting", "question"]);
  assert.deepEqual(claimLabels(v3), ["busy", "resting"]);
});

test("labels exclude their continuations in one precedence", () => {
  const reason = (
    labels: string[],
    continuing: Parameters<typeof exclusionReason>[2],
  ) => exclusionReason(labels, v3, continuing);
  assert.equal(
    reason(["manual", "grilling", "busy", "stuck"], "fresh"),
    "labelled `manual`; delivered outside the factory",
  );
  assert.equal(
    reason(["grilling", "busy", "stuck"], "fresh"),
    "labelled grilling; answer it and return the issue to go to run it again",
  );
  assert.equal(
    reason(["busy", "stuck"], "fresh"),
    "claimed by a running factory run",
  );
  assert.equal(
    reason(["resting"], "fresh"),
    "labelled resting; the factory resumes its run by itself",
  );
  assert.equal(
    reason(["stuck"], "retry"),
    "labelled stuck; remove the label to run it again",
  );
  // A claim's own labels never exclude its continuing work.
  for (const continuing of ["retry", "merge", "resume"] as const)
    assert.equal(reason(["busy", "resting"], continuing), null);
  assert.equal(reason(["manual"], "retry"), null);
  // A merge relaunch keeps version 2's own wording and precedence.
  assert.equal(
    reason(["manual", "stuck", "grilling"], "merge"),
    "labelled grilling; answer it and return the issue to go to run it again",
  );
  assert.equal(reason(["manual", "stuck"], "merge"), "labelled stuck");
  assert.equal(
    reason(["manual"], "merge"),
    "labelled manual; delivered outside the factory",
  );
  assert.equal(reason(["owner-gate", "go"], "fresh"), null);
  assert.equal(
    exclusionReason(["question"], v2, "resume"),
    "labelled question; answer the question and remove the label to run it again",
  );
});
