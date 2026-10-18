import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readHostConfiguration } from "../src/host-configuration.ts";
import { directory } from "./fakes.ts";

// Host configuration validation, driven by fixture files.
function fixture(name: string): string {
  return fileURLToPath(
    new URL(`fixtures/host-configuration/${name}.json`, import.meta.url),
  );
}

function refusal(name: string): string[] {
  return refused(fixture(name));
}

function refused(path: string): string[] {
  const warnings: string[] = [];
  try {
    readHostConfiguration(path, (warning) => warnings.push(warning));
  } catch (error) {
    assert.deepEqual(warnings, [], "an invalid configuration warns of nothing");
    return (error as Error).message.split("\n");
  }
  assert.fail(`${path} was accepted`);
}

// The configuration a file holds, and the warnings reading it gave.
function read(path: string) {
  const warnings: string[] = [];
  const configuration = readHostConfiguration(path, (warning) =>
    warnings.push(warning),
  );
  return { configuration, warnings };
}

test("a complete host configuration is read as written", () => {
  assert.deepEqual(read(fixture("valid")).warnings, []);
  assert.deepEqual(read(fixture("valid")).configuration, {
    repositories: ["acme/widgets", "acme/gadgets"],
    providers: {
      "claude-code": { cap: 2, credential: "/etc/factory/claude-token" },
      codex: { cap: 1, credential: "/etc/factory/codex-auth.json" },
    },
    models: { default: "claude-sonnet-5-5", retry: "claude-opus-5-5@xhigh" },
    timeLimitMinutes: 240,
    usage: {
      drainThreshold: 90,
      pauseThreshold: 95,
      afterDrain: "auto-resume",
    },
    pollSeconds: 300,
    readiness: { authorizedRoles: ["admin", "maintain"] },
    unpushablePaths: [".github/workflows/"],
    stateDirectory: "/var/lib/factory",
    gitIdentity: { name: "factory[bot]", email: "factory@example.com" },
    github: { tokenCommand: ["/usr/local/bin/factory-token", "--app", "7"] },
  });
});

test("Claude Code accepts an optional absolute usage credential without changing other settings", (t) => {
  const configuration = JSON.parse(readFileSync(fixture("valid"), "utf8"));
  configuration.providers["claude-code"].usageCredential =
    "/etc/factory/claude-usage.json";
  const path = join(directory(t), "host.json");
  writeFileSync(path, JSON.stringify(configuration));
  assert.deepEqual(read(path).configuration, configuration);

  for (const value of [null, "", 42, "relative/login.json"]) {
    configuration.providers["claude-code"].usageCredential = value;
    writeFileSync(path, JSON.stringify(configuration));
    assert.throws(
      () => readHostConfiguration(path, assert.fail),
      /providers\.claude-code\.usageCredential:/,
    );
  }
  delete configuration.providers["claude-code"].usageCredential;
  configuration.providers.codex.usageCredential = "/etc/factory/other.json";
  writeFileSync(path, JSON.stringify(configuration));
  assert.throws(
    () => readHostConfiguration(path, assert.fail),
    /providers\.codex\.usageCredential: is not a host configuration field/,
  );
});

test("every missing required field is named", () => {
  assert.deepEqual(refusal("missing"), [
    `The host configuration ${fixture("missing")} is invalid:`,
    "- providers.claude-code.cap: is missing",
    "- models.retry: is missing",
    "- usage.drainThreshold: is missing",
    "- pollSeconds: is missing",
    "- readiness.authorizedRoles: is missing",
    "- github: is missing",
  ]);
});

test("unknown fields and providers without an adapter are refused", () => {
  assert.deepEqual(refusal("unknown"), [
    `The host configuration ${fixture("unknown")} is invalid:`,
    "- labels: is not a host configuration field",
    "- providers.claude-code.env: is not a host configuration field",
    "- providers.cursor: has no adapter; choose claude-code or codex",
    "- usage.reserve: is not a host configuration field",
  ]);
});

test("malformed values are refused with every correction", () => {
  assert.deepEqual(refusal("malformed"), [
    `The host configuration ${fixture("malformed")} is invalid:`,
    '- repositories[1]: repeats "ACME/Widgets"',
    '- repositories[2]: "widgets" is not <owner>/<name>',
    "- providers.claude-code.cap: -1 is not a whole number of agents",
    '- providers.claude-code.credential: "claude-token" is not an absolute path',
    "- models.retry: is not a non-empty string",
    "- timeLimitMinutes: 0 is not a positive number of minutes a timer can wait",
    "- usage.drainThreshold: 120 is not a percentage from 0 to 100",
    "- usage.pauseThreshold: is not a number",
    '- usage.afterDrain: "later" is not one of auto-resume, owner-resume',
    "- pollSeconds: is not a number",
    '- readiness.authorizedRoles[0]: "owner" is not one of admin, maintain, write, triage, read',
    '- readiness.authorizedRoles[2]: repeats "admin"',
    '- unpushablePaths[0]: "/etc" is not a path inside the repository',
    '- unpushablePaths[1]: "../outside" is not a path inside the repository',
    "- unpushablePaths[2]: is not a non-empty string",
    '- stateDirectory: "state" is not an absolute path',
    "- gitIdentity.name: is not a non-empty string",
    "- github.tokenCommand: is empty",
  ]);
});

test("the usage thresholds may be off, and the pause threshold and after-drain policy have defaults", () => {
  const { configuration, warnings } = read(fixture("usage-defaults"));
  assert.deepEqual(configuration.usage, {
    drainThreshold: null,
    pauseThreshold: null,
    afterDrain: "auto-resume",
  });
  assert.deepEqual(warnings, []);
});

test("a pause threshold below the drain threshold and the owner-resume policy are refused", (t) => {
  assert.deepEqual(refusal("usage-unsupported"), [
    `The host configuration ${fixture("usage-unsupported")} is invalid:`,
    '- usage.afterDrain: "owner-resume" needs owner holds, which this factory release does not have yet; use "auto-resume"',
    "- usage.pauseThreshold: 90 is below usage.drainThreshold, 95",
  ]);
  // Equal thresholds are allowed: the drain and the pause start together.
  const equal = join(directory(t), "host.json");
  const valid = JSON.parse(readFileSync(fixture("valid"), "utf8"));
  writeFileSync(
    equal,
    JSON.stringify({
      ...valid,
      usage: { drainThreshold: 95, pauseThreshold: 95 },
    }),
  );
  assert.deepEqual(read(equal).configuration.usage, {
    drainThreshold: 95,
    pauseThreshold: 95,
    afterDrain: "auto-resume",
  });
});

test("for one release the legacy usageThreshold is read as the drain threshold, with a warning", () => {
  const { configuration, warnings } = read(fixture("legacy"));
  assert.deepEqual(configuration, {
    ...read(fixture("valid")).configuration,
    usage: {
      drainThreshold: 80,
      pauseThreshold: null,
      afterDrain: "auto-resume",
    },
  });
  assert.equal("usageThreshold" in configuration, false);
  assert.deepEqual(warnings, [
    `The host configuration ${fixture("legacy")}: usageThreshold is deprecated and read as usage.drainThreshold for this factory release; replace it with "usage": { "drainThreshold": 80 }`,
  ]);
});

test("the legacy usageThreshold is refused alongside usage, and named when invalid", (t) => {
  assert.deepEqual(refusal("legacy-and-usage"), [
    `The host configuration ${fixture("legacy-and-usage")} is invalid:`,
    "- usageThreshold: is the deprecated form of usage.drainThreshold and can't be set with usage; remove it",
  ]);
  const invalid = join(directory(t), "host.json");
  const legacy = JSON.parse(readFileSync(fixture("legacy"), "utf8"));
  writeFileSync(invalid, JSON.stringify({ ...legacy, usageThreshold: 120 }));
  assert.deepEqual(refused(invalid), [
    `The host configuration ${invalid} is invalid:`,
    "- usageThreshold: 120 is not a percentage from 0 to 100",
  ]);
});

test("models the configured providers cannot run are refused", () => {
  assert.deepEqual(refusal("unresolvable-models"), [
    `The host configuration ${fixture("unresolvable-models")} is invalid:`,
    "- models.default: model claude-sonnet-5-5 names no provider; name it <provider>/claude-sonnet-5-5, choose codex",
    '- models.retry: effort "max" is not one codex accepts: low, medium, high, xhigh',
  ]);
});

test("a file that is not JSON or does not exist is refused", (t) => {
  const truncated = join(directory(t), "host.json");
  writeFileSync(truncated, '{ "repositories": ["acme/widgets"],\n');
  assert.throws(() => readHostConfiguration(truncated, assert.fail), {
    message: new RegExp(
      `^The host configuration ${truncated} is not JSON: SyntaxError`,
    ),
  });
  assert.match(
    refusal("absent")[0],
    /^The host configuration .*absent\.json is unreadable: Error: ENOENT/,
  );
});

test("an invalid host configuration stops the process with its reason", () => {
  const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const stopped = spawnSync(process.execPath, [main, fixture("missing")], {
    encoding: "utf8",
  });
  assert.equal(stopped.status, 1);
  assert.equal(stopped.stdout, "");
  assert.equal(
    stopped.stderr,
    [
      `The host configuration ${fixture("missing")} is invalid:`,
      "- providers.claude-code.cap: is missing",
      "- models.retry: is missing",
      "- usage.drainThreshold: is missing",
      "- pollSeconds: is missing",
      "- readiness.authorizedRoles: is missing",
      "- github: is missing",
      "",
    ].join("\n"),
  );
  const usage = spawnSync(process.execPath, [main], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.equal(usage.stderr, "Usage: node src/main.ts <host configuration>\n");
});
