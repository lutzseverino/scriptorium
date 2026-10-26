import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { directory } from "./fakes.ts";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  factoryConfigurationPath,
  readFactoryConfiguration,
} from "../src/factory-configuration.ts";

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
      paused: "waiting",
    },
    modelLabelPrefix: "agent:",
    prompt: "Handle #{issue} using {skillPrefix}ship",
  });
});

test("the configuration this repository adopted from Repo Canon is accepted", () => {
  const adopted = fileURLToPath(
    new URL(`../${factoryConfigurationPath}`, import.meta.url),
  );
  assert.equal(readFactoryConfiguration(adopted).version, 1);
});

test("a skip label is optional, trimmed and distinct from every other label", (t) => {
  const path = join(directory(t), "config.json");
  const configuration = JSON.parse(readFileSync(fixture("valid"), "utf8"));
  configuration.labels.skip = "manual-delivery";
  writeFileSync(path, JSON.stringify(configuration));
  assert.deepEqual(readFactoryConfiguration(path), configuration);

  for (const skip of ["", " manual", "manual ", null, 7]) {
    configuration.labels.skip = skip;
    writeFileSync(path, JSON.stringify(configuration));
    assert.throws(() => readFactoryConfiguration(path), {
      message: `The factory configuration ${path} is invalid:\n- labels.skip: is not a non-empty trimmed string`,
    });
  }
  for (const name of ["ready", "running", "failed", "needsInput", "paused"]) {
    configuration.labels.skip = configuration.labels[name].toUpperCase();
    writeFileSync(path, JSON.stringify(configuration));
    assert.throws(() => readFactoryConfiguration(path), {
      message: `The factory configuration ${path} is invalid:\n- labels.skip: must differ from labels.${name}, ignoring case`,
    });
  }
});

test("missing fields are refused instead of supplied from defaults", () => {
  assert.throws(() => readFactoryConfiguration(fixture("missing")), {
    message: `The factory configuration ${fixture("missing")} is invalid:\n- version: is missing\n- modelLabelPrefix: is missing\n- prompt: is missing\n- labels.needsInput: is missing\n- labels.paused: is missing`,
  });
});

test("unknown fields at either level are invalid", () => {
  assert.throws(() => readFactoryConfiguration(fixture("unknown")), {
    message: `The factory configuration ${fixture("unknown")} is invalid:\n- fallback: is not a factory configuration field\n- labels.other: is not a factory configuration field`,
  });
});

test("malformed fields and an unsupported version are invalid", () => {
  assert.throws(() => readFactoryConfiguration(fixture("malformed")), {
    message: `The factory configuration ${fixture("malformed")} is invalid:\n- version: must be 1\n- labels.ready: is not a non-empty trimmed string\n- labels.running: is not a non-empty trimmed string\n- labels.failed: is not a non-empty trimmed string\n- labels.needsInput: is not a non-empty trimmed string\n- labels.paused: is not a non-empty trimmed string\n- modelLabelPrefix: is not a non-empty trimmed string\n- prompt: must contain {skillPrefix} and {issue}`,
  });
});

test("state labels cannot alias readiness, which the factory never writes", () => {
  assert.throws(() => readFactoryConfiguration(fixture("overlapping-labels")), {
    message: `The factory configuration ${fixture("overlapping-labels")} is invalid:\n- labels.failed: must differ from labels.ready, ignoring case`,
  });
});

// The fifth required label, written into an otherwise valid configuration.
function withPaused(t: TestContext, paused?: unknown): string {
  const configuration = JSON.parse(readFileSync(fixture("valid"), "utf8"));
  if (paused === undefined) delete configuration.labels.paused;
  else configuration.labels.paused = paused;
  const path = join(directory(t), "config.json");
  writeFileSync(path, JSON.stringify(configuration));
  return path;
}

test("the paused label is required, trimmed and distinct from the other four", (t) => {
  for (const [paused, problem] of [
    [undefined, "labels.paused: is missing"],
    ["", "labels.paused: is not a non-empty trimmed string"],
    [" waiting", "labels.paused: is not a non-empty trimmed string"],
    [
      "Working",
      "labels.paused: must differ from labels.running, ignoring case",
    ],
    [
      "QUESTION",
      "labels.paused: must differ from labels.needsInput, ignoring case",
    ],
  ] as const) {
    const path = withPaused(t, paused);
    assert.throws(() => readFactoryConfiguration(path), {
      message: `The factory configuration ${path} is invalid:\n- ${problem}`,
    });
  }
  assert.equal(
    readFactoryConfiguration(withPaused(t, "waiting")).labels.paused,
    "waiting",
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

test("comment templates are optional and individually configurable in version 1", (t) => {
  const path = join(directory(t), "config.json");
  const configuration = JSON.parse(readFileSync(fixture("valid"), "utf8"));
  for (const comments of [
    {},
    { pause: "Waiting: {cause}" },
    { failure: "{unpushableCount}", close: "Done.\n" },
    { awaitingMerge: "Held: {provider}/{model}@{effort} {attempt} {log} {label}" },
  ]) {
    writeFileSync(path, JSON.stringify({ ...configuration, comments }));
    assert.deepEqual(readFactoryConfiguration(path), {
      ...configuration,
      comments,
    });
  }
});

test("every supplied comment template is validated before any comment is needed", (t) => {
  const path = join(directory(t), "config.json");
  const configuration = JSON.parse(readFileSync(fixture("valid"), "utf8"));
  for (const comments of [
    null,
    [],
    "text",
    1,
    { other: "unknown" },
    { pause: "" },
    { failure: null },
    { close: {} },
    ...["", null, 1, [], {}].map((awaitingMerge) => ({ awaitingMerge })),
    { awaitingMerge: "{failure}" },
    { awaitingMerge: "{#provider}{unknown}{/provider}" },
    { awaitingMerge: "{#log}never closed" },
    { awaitingMerge: "{/log}" },
    { awaitingMerge: "{#log}{#provider}{/log}{/provider}" },
    { pause: "{failure}" },
    { failure: "{reset}" },
    { close: "{provider}" },
    { pause: "{#reset}never closed" },
    { failure: "{/log}" },
    { close: "{#tickets}{unknown}{/tickets}" },
  ]) {
    writeFileSync(path, JSON.stringify({ ...configuration, comments }));
    assert.throws(() => readFactoryConfiguration(path), /comments\./);
  }
});
