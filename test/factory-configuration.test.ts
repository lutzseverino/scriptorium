import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { directory } from "./fakes.ts";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFactoryConfiguration } from "../src/factory-configuration.ts";

function fixture(name: string): string {
  return fileURLToPath(
    new URL(`fixtures/factory-configuration/${name}.json`, import.meta.url),
  );
}

test("a repository's factory configuration is read without convention defaults", () => {
  assert.deepEqual(readFactoryConfiguration(fixture("valid")), {
    version: 1,
    labels: {
      ready: "queued",
      running: "working",
      failed: "broken",
      needsInput: "question",
    },
    modelLabelPrefix: "agent:",
    prompt: "Handle #{issue} using {skillPrefix}ship",
  });
});

test("missing fields are refused instead of supplied from defaults", () => {
  assert.throws(() => readFactoryConfiguration(fixture("missing")), {
    message: `The factory configuration ${fixture("missing")} is invalid:\n- version: is missing\n- modelLabelPrefix: is missing\n- prompt: is missing\n- labels.needsInput: is missing`,
  });
});

test("unknown fields at either level are invalid", () => {
  assert.throws(() => readFactoryConfiguration(fixture("unknown")), {
    message: `The factory configuration ${fixture("unknown")} is invalid:\n- fallback: is not a factory configuration field\n- labels.other: is not a factory configuration field`,
  });
});

test("malformed fields and an unsupported version are invalid", () => {
  assert.throws(() => readFactoryConfiguration(fixture("malformed")), {
    message: `The factory configuration ${fixture("malformed")} is invalid:\n- version: must be 1\n- labels.ready: is not a non-empty trimmed string\n- labels.running: is not a non-empty trimmed string\n- labels.failed: is not a non-empty trimmed string\n- labels.needsInput: is not a non-empty trimmed string\n- modelLabelPrefix: is not a non-empty trimmed string\n- prompt: must contain {skillPrefix} and {issue}`,
  });
});

test("state labels cannot alias readiness, which the factory never writes", () => {
  assert.throws(
    () => readFactoryConfiguration(fixture("overlapping-labels")),
    /labels: must name four distinct labels/,
  );
});

test("unreadable and non-JSON configurations have a stated reason", (t) => {
  const path = join(directory(t), "config.json");
  assert.throws(
    () => readFactoryConfiguration(path),
    /factory configuration.*unreadable/,
  );
  writeFileSync(path, "{\n");
  assert.throws(
    () => readFactoryConfiguration(path),
    /factory configuration.*not JSON/,
  );
});

for (const name of [
  "empty",
  "malformed-objects",
  "missing-labels",
  "null",
  "array",
])
  test(`${name} fixture is invalid`, () => {
    assert.throws(
      () => readFactoryConfiguration(fixture(name)),
      /factory configuration.*invalid/,
    );
  });
