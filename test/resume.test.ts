import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { requestsDirectory } from "../src/owner.ts";
import { resume, resumeUsage } from "../src/resume.ts";
import { directory } from "./fakes.ts";

const now = new Date("2026-10-09T12:00:00.000Z");

// The valid host configuration fixture, with its state directory and usage
// policy replaced.
function configuration(t: TestContext, usage: object) {
  const root = directory(t);
  const path = join(root, "host.json");
  const valid = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "fixtures/host-configuration/valid.json"),
      "utf8",
    ),
  );
  const state = join(root, "state");
  writeFileSync(
    path,
    JSON.stringify({ ...valid, stateDirectory: state, usage }),
  );
  return { path, state };
}

function command(args: string[]) {
  const output: string[] = [];
  const errors: string[] = [];
  const status = resume(args, {
    now: () => now,
    print: (line) => output.push(line),
    error: (line) => errors.push(line),
  });
  return { status, output, errors };
}

const policy = { drainThreshold: 90, pauseThreshold: 95 };

test("the resume command queues one request in the state directory and says when it applies", (t) => {
  const { path, state } = configuration(t, policy);
  for (const option of [
    ["--drain-threshold", "94.5"],
    ["--drain-threshold=94.5"],
  ]) {
    const { status, output, errors } = command([
      ...option,
      path,
      "claude-code",
    ]);
    assert.equal(status, 0, errors.join("\n"));
    const id =
      /^Queued resume request (?<id>\S+) to lift claude-code's owner hold and raise its drain threshold once to 94\.5%\. The running factory applies it on its next pass, within 300 seconds of its current one, and logs "resume request \k<id> applied"\.$/.exec(
        output[0],
      )?.groups?.id;
    assert.match(id ?? "", /^2026-10-09T12-00-00\.000Z-[0-9a-f]{8}\.json$/);
    assert.ok(readdirSync(requestsDirectory(state)).includes(id!));
  }
  const requests = readdirSync(requestsDirectory(state));
  assert.equal(requests.length, 2);
  for (const id of requests)
    assert.deepEqual(
      JSON.parse(readFileSync(join(requestsDirectory(state), id), "utf8")),
      {
        provider: "claude-code",
        drainThreshold: 94.5,
        requestedAt: now.toISOString(),
      },
    );
});

test("the resume command refuses a malformed command or a request the configuration refuses, and queues nothing", (t) => {
  const { path, state } = configuration(t, policy);
  for (const [args, status, error] of [
    [[path], 2, "resume needs the host configuration and a provider"],
    [[path, "claude-code", "--force"], 2, "--force is not an option"],
    [
      [path, "claude-code", "--drain-threshold"],
      2,
      "--drain-threshold needs a percentage",
    ],
    [
      [path, "claude-code", "--drain-threshold", "high"],
      2,
      "--drain-threshold needs a percentage",
    ],
    [
      [path, "claude-code", "--drain-threshold=92", "--drain-threshold=93"],
      2,
      "--drain-threshold is given twice",
    ],
  ] as const)
    assert.deepEqual(command([...args]), {
      status,
      output: [],
      errors: [`${error}\nUsage: ${resumeUsage}`],
    });
  for (const [args, problem] of [
    [
      [path, "gemini"],
      "the host configuration has no provider gemini; choose claude-code or codex",
    ],
    [
      [path, "codex", "--drain-threshold", "96"],
      "the drain threshold can be raised only above its configured 90%, up to the 95% pause threshold",
    ],
  ] as const)
    assert.deepEqual(command([...args]), {
      status: 1,
      output: [],
      errors: [`The resume request was not queued: ${problem}`],
    });
  const missing = join(state, "missing.json");
  const unreadable = command([missing, "codex"]);
  assert.equal(unreadable.status, 1);
  assert.match(
    unreadable.errors[0],
    /^The host configuration .* is unreadable/,
  );
  assert.throws(() => readdirSync(requestsDirectory(state)), /ENOENT/);
});

test("without a pause threshold a raise may reach 100", (t) => {
  const { path } = configuration(t, { drainThreshold: 90 });
  assert.equal(
    command([path, "claude-code", "--drain-threshold", "100"]).status,
    0,
  );
  assert.deepEqual(
    command([path, "claude-code", "--drain-threshold", "101"]).errors,
    [
      "The resume request was not queued: the drain threshold can be raised only above its configured 90%, up to 100%, as the host sets no pause threshold",
    ],
  );
});
