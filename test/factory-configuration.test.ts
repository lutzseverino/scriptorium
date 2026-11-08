import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { directory } from "./fakes.ts";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  factoryConfigurationPath,
  launchArguments,
  readFactoryConfiguration,
  runKind,
} from "../src/factory-configuration.ts";

function fixture(name: string): string {
  return fileURLToPath(
    new URL(`fixtures/factory-configuration/${name}.json`, import.meta.url),
  );
}

test("a repository's factory configuration is read without convention defaults", () => {
  assert.deepEqual(readFactoryConfiguration(fixture("valid")), {
    version: 2,
    labels: {
      ready: "queued",
      running: "working",
      failed: "broken",
      needsInput: "question",
      paused: "waiting",
    },
    contractResult: { marker: "contract:result", author: "validator[bot]" },
    modelLabelPrefix: "agent:",
    skill: "ship",
    arguments: "#{issue}",
  });
});

test("the configuration this repository uses is accepted", () => {
  const configured = fileURLToPath(
    new URL(`../${factoryConfigurationPath}`, import.meta.url),
  );
  const configuration = readFactoryConfiguration(configured);
  assert.equal(configuration.version, 2);
  assert.deepEqual(configuration.contractResult, {
    marker: "repo-canon:issue-contract-state",
    author: "github-actions[bot]",
  });
});

test("the contract result's marker and author are required, with no default", (t) => {
  const path = join(directory(t), "config.json");
  const configuration = JSON.parse(readFileSync(fixture("valid"), "utf8"));
  // A version 2 configuration from before the contract result was required.
  delete configuration.contractResult;
  writeFileSync(path, JSON.stringify(configuration));
  assert.throws(() => readFactoryConfiguration(path), {
    message: `The factory configuration ${path} is invalid:\n- contractResult: is missing`,
  });
  for (const [contractResult, problems] of [
    [
      {},
      [
        "contractResult.marker: is missing",
        "contractResult.author: is missing",
      ],
    ],
    [
      { marker: "", author: " validator[bot]", other: true },
      [
        "contractResult.other: is not a factory configuration field",
        "contractResult.marker: is not a non-empty trimmed string",
        "contractResult.author: is not a non-empty trimmed string",
      ],
    ],
    ["contract:result", ["contractResult.: is not an object"]],
  ] as const) {
    writeFileSync(path, JSON.stringify({ ...configuration, contractResult }));
    assert.throws(() => readFactoryConfiguration(path), {
      message: `The factory configuration ${path} is invalid:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    });
  }
});

test("version 1 prompt configurations are outside the compatibility window", (t) => {
  const path = join(directory(t), "config.json");
  const configuration = JSON.parse(readFileSync(fixture("valid"), "utf8"));
  delete configuration.skill;
  delete configuration.arguments;
  writeFileSync(
    path,
    JSON.stringify({
      ...configuration,
      version: 1,
      prompt: "{skillPrefix}ship #{issue}",
    }),
  );
  assert.throws(() => readFactoryConfiguration(path), {
    message: `The factory configuration ${path} is invalid:\n- prompt: is not a factory configuration field\n- skill: is missing\n- arguments: is missing\n- version: must be 2 or 3`,
  });

  writeFileSync(
    path,
    JSON.stringify({
      ...configuration,
      version: 2,
      skill: "ship",
      arguments: "#{issue}",
      prompt: "{skillPrefix}ship #{issue}",
    }),
  );
  assert.throws(() => readFactoryConfiguration(path), {
    message: `The factory configuration ${path} is invalid:\n- prompt: is not a factory configuration field`,
  });
});

test("skill names must be trimmed and arguments preserve whitespace", (t) => {
  const path = join(directory(t), "config.json");
  const configuration = JSON.parse(readFileSync(fixture("valid"), "utf8"));
  for (const skill of ["", " ship", "ship ", null, 7, [], {}]) {
    writeFileSync(path, JSON.stringify({ ...configuration, skill }));
    assert.throws(() => readFactoryConfiguration(path), /skill:/);
  }
  for (const args of [null, 7, [], {}]) {
    writeFileSync(path, JSON.stringify({ ...configuration, arguments: args }));
    assert.throws(() => readFactoryConfiguration(path), /arguments:/);
  }
  for (const args of ["", "fixed arguments", " #{issue}\n{issue} "]) {
    writeFileSync(path, JSON.stringify({ ...configuration, arguments: args }));
    assert.equal(
      runKind(readFactoryConfiguration(path), "implement")?.arguments,
      args,
    );
  }
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
    message: `The factory configuration ${fixture("missing")} is invalid:\n- version: is missing\n- contractResult: is missing\n- modelLabelPrefix: is missing\n- skill: is missing\n- arguments: is missing\n- labels.paused: is missing\n- labels.needsInput: is missing`,
  });
});

test("unknown fields at either level are invalid", () => {
  assert.throws(() => readFactoryConfiguration(fixture("unknown")), {
    message: `The factory configuration ${fixture("unknown")} is invalid:\n- fallback: is not a factory configuration field\n- labels.other: is not a factory configuration field`,
  });
});

test("malformed fields and an unsupported version are invalid", () => {
  assert.throws(() => readFactoryConfiguration(fixture("malformed")), {
    message: `The factory configuration ${fixture("malformed")} is invalid:\n- version: must be 2 or 3\n- labels.ready: is not a non-empty trimmed string\n- labels.running: is not a non-empty trimmed string\n- labels.failed: is not a non-empty trimmed string\n- labels.paused: is not a non-empty trimmed string\n- labels.needsInput: is not a non-empty trimmed string\n- contractResult.marker: is not a non-empty trimmed string\n- contractResult.author: is not a non-empty trimmed string\n- modelLabelPrefix: is not a non-empty trimmed string\n- skill: is not a non-empty trimmed string\n- arguments: is not a string`,
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
      "labels.needsInput: must differ from labels.paused, ignoring case",
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

test("comment templates are optional and individually configurable in version 2", (t) => {
  const path = join(directory(t), "config.json");
  const configuration = JSON.parse(readFileSync(fixture("valid"), "utf8"));
  for (const comments of [
    {},
    { pause: "Waiting: {cause}" },
    { failure: "{unpushableCount}", close: "Done.\n" },
    {
      awaitingMerge:
        "Held: {provider}/{model}@{effort} {attempt} {log} {label}",
    },
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

test("a release-hold label is optional, trimmed and distinct in version 2", (t) => {
  const path = join(directory(t), "config.json");
  const configuration = JSON.parse(readFileSync(fixture("valid"), "utf8"));
  configuration.labels.skip = "manual";
  configuration.labels.releaseHold = "release-hold";
  writeFileSync(path, JSON.stringify(configuration));
  assert.deepEqual(readFactoryConfiguration(path), configuration);
  for (const value of [
    "",
    " hold",
    "hold ",
    null,
    9,
    ...Object.values(configuration.labels)
      .slice(0, -1)
      .map((label) => String(label).toUpperCase()),
  ]) {
    configuration.labels.releaseHold = value;
    writeFileSync(path, JSON.stringify(configuration));
    assert.throws(() => readFactoryConfiguration(path), /labels.releaseHold:/);
  }
});

test("a factory hold label is optional, trimmed and distinct from every other label in version 2", (t) => {
  const path = join(directory(t), "config.json");
  const configuration = JSON.parse(readFileSync(fixture("valid"), "utf8"));
  writeFileSync(path, JSON.stringify(configuration));
  assert.deepEqual(readFactoryConfiguration(path).labels.hold, undefined);
  configuration.labels.skip = "manual";
  configuration.labels.releaseHold = "release-hold";
  configuration.labels.hold = "factory:hold";
  writeFileSync(path, JSON.stringify(configuration));
  assert.deepEqual(readFactoryConfiguration(path), configuration);
  for (const value of [
    "",
    " hold",
    "hold ",
    null,
    9,
    ...Object.values(configuration.labels)
      .slice(0, -1)
      .map((label) => String(label).toUpperCase()),
  ]) {
    configuration.labels.hold = value;
    writeFileSync(path, JSON.stringify(configuration));
    assert.throws(() => readFactoryConfiguration(path), /labels\.hold:/);
  }
});

test("version 3 maps run kinds to skills and names flat label roles, as Repo Canon ships it", () => {
  const configuration = readFactoryConfiguration(fixture("version-3"));
  assert.equal(configuration.version, 3);
  assert.deepEqual(runKind(configuration, "review"), {
    skill: "review",
    arguments: "#{pullRequest}",
    differentProvider: true,
  });
  assert.deepEqual(configuration.version === 3 && configuration.triageResult, {
    marker: "scriptorium:run",
    author: "lz-scriptorium[bot]",
  });
  assert.equal(configuration.labels.needsInput, undefined);
});

// A version 3 configuration with only the roles and the kind it requires.
const implementOnly = {
  version: 3,
  labels: {
    ready: "state:ready",
    running: "factory:running",
    paused: "factory:paused",
    failed: "factory:failed",
  },
  contractResult: { marker: "contract:result", author: "validator[bot]" },
  modelLabelPrefix: "model:",
  runKinds: { implement: { skill: "implement", arguments: "#{issue}" } },
};

function invalid(t: TestContext, value: unknown, problems: string[]) {
  const path = join(directory(t), "config.json");
  writeFileSync(path, JSON.stringify(value));
  assert.throws(() => readFactoryConfiguration(path), {
    message: `The factory configuration ${path} is invalid:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
  });
}

test("version 2 refuses version 3 fields rather than synthesizing run kinds or labels", (t) => {
  const configuration = JSON.parse(readFileSync(fixture("valid"), "utf8"));
  invalid(
    t,
    {
      ...configuration,
      runKinds: implementOnly.runKinds,
      triageResult: { marker: "triage", author: "factory[bot]" },
      labels: { ...configuration.labels, triage: "state:triage" },
    },
    [
      "runKinds: is not a factory configuration field",
      "triageResult: is not a factory configuration field",
      "labels.triage: is not a factory configuration field",
    ],
  );
});

test("only numeric versions 2 and 3 fall inside the compatibility window", (t) => {
  const path = join(directory(t), "config.json");
  for (const version of [0, 1, 4, 99, "2", "3", null, true]) {
    writeFileSync(path, JSON.stringify({ ...implementOnly, version }));
    assert.throws(
      () => readFactoryConfiguration(path),
      /version: must be 2 or 3/,
    );
  }
});

test("implement alone is a complete version 3 configuration", (t) => {
  const path = join(directory(t), "config.json");
  writeFileSync(path, JSON.stringify(implementOnly));
  const configuration = readFactoryConfiguration(path);
  assert.deepEqual(configuration, implementOnly);
  assert.equal(runKind(configuration, "triage"), undefined);
  assert.equal(runKind(configuration, "review"), undefined);
});

test("version 3 is validated against its own contract", (t) => {
  invalid(
    t,
    {
      ...implementOnly,
      skill: "implement",
      labels: { ...implementOnly.labels, needsInput: "factory:needs-input" },
      runKinds: { review: { skill: "review", arguments: "#{pullRequest}" } },
    },
    [
      "skill: is not a factory configuration field",
      "labels.needsInput: is not a factory configuration field",
      "runKinds.implement: is missing",
    ],
  );
  invalid(
    t,
    {
      ...implementOnly,
      runKinds: {
        ...implementOnly.runKinds,
        triage: { skill: " triage", arguments: "#{issue} {pullRequest}" },
        review: { skill: "review", arguments: 7, differentProvider: "yes" },
        merge: {},
      },
      triageResult: { marker: "", author: "factory[bot]", extra: true },
    },
    [
      "triageResult.extra: is not a factory configuration field",
      "triageResult.marker: is not a non-empty trimmed string",
      "runKinds.merge: is not a factory configuration field",
      "runKinds.triage.skill: is not a non-empty trimmed string",
      "runKinds.triage.arguments: names {pullRequest}, and a triage run has no pull request",
      "runKinds.review.arguments: is not a string",
      "runKinds.review.differentProvider: is not a boolean",
      "labels.triage: is required with runKinds.triage",
    ],
  );
  invalid(
    t,
    {
      ...implementOnly,
      labels: {
        ...implementOnly.labels,
        grill: "State:Ready",
        priorityHigh: " priority:high",
      },
    },
    [
      "labels.priorityHigh: is not a non-empty trimmed string",
      "labels.ready: must differ from labels.grill, ignoring case",
    ],
  );
  invalid(t, { ...implementOnly, version: 4 }, [
    "runKinds: is not a factory configuration field",
    "skill: is missing",
    "arguments: is missing",
    "version: must be 2 or 3",
    "labels.needsInput: is missing",
  ]);
});

test("a run kind's result label families and the run result frame's disclaimers are optional and validated", (t) => {
  const path = join(directory(t), "config.json");
  const configured = {
    ...implementOnly,
    runKinds: {
      implement: {
        skill: "implement",
        arguments: "#{issue}",
        resultLabels: ["type:", "priority:"],
      },
    },
    comments: {
      disclaimer: "> Written by the factory's agent.",
      triageDisclaimer: "> *Written by the factory's triage agent.*",
    },
  };
  writeFileSync(path, JSON.stringify(configured));
  assert.deepEqual(readFactoryConfiguration(path), configured);
  invalid(
    t,
    {
      ...implementOnly,
      runKinds: {
        implement: {
          ...implementOnly.runKinds.implement,
          resultLabels: "type:",
        },
        review: {
          skill: "review",
          arguments: "#{pullRequest}",
          resultLabels: [" type:", 3, "Priority:", "priority:"],
        },
      },
      comments: { disclaimer: "", triageDisclaimer: 1 },
    },
    [
      "runKinds.implement.resultLabels: is not an array",
      "runKinds.review.resultLabels[0]: is not a non-empty trimmed string",
      "runKinds.review.resultLabels[1]: is not a non-empty trimmed string",
      "runKinds.review.resultLabels: repeats a family, ignoring case",
      "comments.disclaimer: is not a non-empty trimmed string",
      "comments.triageDisclaimer: is not a non-empty trimmed string",
    ],
  );
});

test("arguments expand {issue}, and in version 3 {pullRequest}, which a launch without one cannot use", () => {
  const configuration = readFactoryConfiguration(fixture("version-3"));
  assert.equal(launchArguments(configuration, "review", 4, 42), "#42");
  assert.deepEqual(launchArguments(configuration, "review", 4), {
    error:
      "runKinds.review.arguments names {pullRequest}, and this launch has no pull request",
  });
  assert.equal(launchArguments(configuration, "implement", 4), "#4");
  const v2 = readFactoryConfiguration(fixture("valid"));
  if (v2.version === 2) v2.arguments = "#{issue} {pullRequest}";
  assert.equal(launchArguments(v2, "implement", 4, 42), "#4 {pullRequest}");
});
