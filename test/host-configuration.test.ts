import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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
  try {
    readHostConfiguration(fixture(name));
  } catch (error) {
    return (error as Error).message.split("\n");
  }
  assert.fail(`${name} was accepted`);
}

test("a complete host configuration is read as written", () => {
  assert.deepEqual(readHostConfiguration(fixture("valid")), {
    repositories: ["acme/widgets", "acme/gadgets"],
    providers: {
      "claude-code": { cap: 2, credential: "/etc/factory/claude-token" },
      codex: { cap: 1, credential: "/etc/factory/codex-auth.json" },
    },
    models: { default: "claude-sonnet-5-5", retry: "claude-opus-5-5@xhigh" },
    timeLimitMinutes: 240,
    usageThreshold: 80,
    pollSeconds: 300,
    readiness: { authorizedRoles: ["admin", "maintain"] },
    unpushablePaths: [".github/workflows/"],
    stateDirectory: "/var/lib/factory",
    gitIdentity: { name: "factory[bot]", email: "factory@example.com" },
    github: { tokenCommand: ["/usr/local/bin/factory-token", "--app", "7"] },
  });
});

test("every missing field is named, since none has a default", () => {
  assert.deepEqual(refusal("missing"), [
    `The host configuration ${fixture("missing")} is invalid:`,
    "- providers.claude-code.cap: is missing",
    "- models.retry: is missing",
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
    "- usageThreshold: 120 is not a percentage from 0 to 100",
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
  assert.throws(() => readHostConfiguration(truncated), {
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
