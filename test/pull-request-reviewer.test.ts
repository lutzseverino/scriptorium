import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { directory } from "./fakes.ts";

// Drive both the CLI-backed and Postern-backed installed skill commands,
// observing requests separately from the check/reviewer wait's exit status.
const skill = resolve(import.meta.dirname, "../.agents/skills/babysit");
const reviewer = JSON.parse(
  readFileSync(
    new URL("../.github/pull-request-reviewer.json", import.meta.url),
    "utf8",
  ),
);
const app = "lz-scriptorium[bot]";
const policy = { version: 1, author: app };

function github(t: TestContext, author = "app/lz-scriptorium") {
  const root = directory(t);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "--initial-branch=main");
  git("remote", "add", "origin", "https://github.com/example/repository.git");
  const snapshot = () => {
    git("add", ".github");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "Snapshot review configuration",
    );
  };
  mkdirSync(join(root, ".github"));
  writeFileSync(
    join(root, ".github/pull-request-reviewer.json"),
    JSON.stringify(reviewer),
  );
  writeFileSync(
    join(root, ".github/factory-review-policy.json"),
    JSON.stringify(policy),
  );
  snapshot();
  const opened = new Date(Date.now() - 1000).toISOString();
  const state = {
    author: { login: author },
    headRefOid: "1".repeat(40),
    headRefName: "factory/issue-47",
    createdAt: opened,
    pushedAt: opened,
    statusCheckRollup: [
      {
        __typename: "CheckRun",
        name: "Test",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        startedAt: opened,
      },
    ],
    comments: [] as {
      user: { login: string };
      body: string;
      created_at: string;
    }[],
    reviews: [] as Record<string, unknown>[],
  };
  const save = () =>
    writeFileSync(join(root, "state.json"), JSON.stringify(state));
  save();
  writeFileSync(join(root, "requests.json"), "[]");
  writeFileSync(
    join(root, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync("state.json", "utf8"));
let result;
if (args[0] === "auth" && args[1] === "token") {
  process.stdout.write("synthetic-test-credential");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") result = state;
else if (args[0] === "pr" && args[1] === "comment") {
  const requests = JSON.parse(fs.readFileSync("requests.json", "utf8"));
  const body = args.includes("--body-file") ? fs.readFileSync(0, "utf8") : args[args.indexOf("--body") + 1];
  requests.push(body);
  fs.writeFileSync("requests.json", JSON.stringify(requests));
  state.comments.push({ user: { login: "factory[bot]" }, body, created_at: new Date().toISOString() });
  fs.writeFileSync("state.json", JSON.stringify(state));
  result = {};
} else if (args[0] === "api" && args[1].includes("/activity?")) result = [{ after: state.headRefOid, timestamp: state.pushedAt }];
else if (args[0] === "api" && args[1].includes("/actions/runs?")) result = [{ workflow_runs: [] }];
else if (args[0] === "api" && args[1].includes("/issues/")) result = [state.comments];
else if (args[0] === "api" && args[1].includes("/reviews?")) result = [state.reviews];
else if (args[0] === "api" && args[1].includes("/comments?")) result = [[]];
else { process.stderr.write("Unexpected gh arguments: " + JSON.stringify(args)); process.exit(1); }
process.stdout.write(JSON.stringify(result));
`,
    { mode: 0o755 },
  );
  const run = (command: string, ...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        new URL("./fixtures/babysit-github.mjs", import.meta.url).href,
        join(skill, command),
        "47",
        ...args,
      ],
      {
        cwd: root,
        env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
  return {
    root,
    state,
    save,
    push(head: string) {
      Object.assign(
        state,
        JSON.parse(readFileSync(join(root, "state.json"), "utf8")),
      );
      state.headRefOid = head;
      state.pushedAt = new Date(Date.now() + 1000).toISOString();
      save();
    },
    snapshot,
    run,
    wait: () => run("wait.mjs", "--limit", "0.01", "--interval", "0.001"),
    requests: () =>
      JSON.parse(readFileSync(join(root, "requests.json"), "utf8")),
  };
}

function assertSkipped(result: ReturnType<typeof spawnSync>) {
  assert.ok(result.status === 0 || result.status === 6, String(result.stderr));
  assert.match(String(result.stdout), /checks passed/);
  assert.doesNotMatch(
    String(result.stdout),
    /reviewer reviewed|did not respond|did not review/,
  );
}

test("factory PRs settle without an external reviewer response wait", (t) => {
  const gh = github(t);
  const result = gh.wait();
  assertSkipped(result);
});

test("factory PRs post no review requests initially or after fixes and resumed rebases", (t) => {
  const gh = github(t);
  for (const [index, fixes] of [false, true, false].entries()) {
    if (index === 2)
      writeFileSync(
        join(gh.root, ".github/pull-request-reviewer.json"),
        JSON.stringify({
          ...reviewer,
          request: { ...reviewer.request, onOpen: false },
        }),
      );
    gh.snapshot();
    const result = gh.run("request.mjs", ...(fixes ? ["--fixes-review"] : []));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(gh.requests(), []);
    assertSkipped(gh.wait());
    gh.push(String(index + 2).repeat(40));
  }
});

test("an owner login resembling the app retains its reviewer wait", (t) => {
  const gh = github(t, "lz-scriptorium");
  assert.equal(gh.wait().status, 5);
});

test("owner PRs retain opening, explicit request, fix request and completion behavior", (t) => {
  const gh = github(t, "owner");
  assert.equal(gh.run("request.mjs").status, 0);
  assert.deepEqual(gh.requests(), []); // onOpen is already a request.
  let waiting = gh.wait();
  assert.equal(waiting.status, 5, waiting.stderr);
  assert.match(waiting.stdout, /still waiting on reviewer/);
  gh.push("2".repeat(40));
  assert.equal(gh.run("request.mjs", "--fixes-review").status, 0);
  assert.deepEqual(gh.requests(), [reviewer.request.comment]);

  // An owner PR with automatic requests disabled gets one explicit request.
  writeFileSync(
    join(gh.root, ".github/pull-request-reviewer.json"),
    JSON.stringify({
      ...reviewer,
      request: { ...reviewer.request, onOpen: false },
    }),
  );
  gh.snapshot();
  gh.state.comments = [];
  gh.save();
  assert.equal(gh.run("request.mjs").status, 0);
  assert.equal(gh.run("request.mjs").status, 0);
  assert.equal(gh.requests().length, 2);
  gh.state.reviews.push({
    id: 1,
    user: { login: reviewer.account },
    commit_id: gh.state.headRefOid,
    state: "APPROVED",
    body: "",
    submitted_at: new Date().toISOString(),
  });
  gh.save();
  const reviewed = gh.wait();
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.match(reviewed.stdout, /reviewer reviewed/);
});

test("factory review policy preserves pending, failing and missing-check waits", (t) => {
  const gh = github(t);
  gh.state.statusCheckRollup[0].status = "IN_PROGRESS";
  gh.save();
  const pending = gh.wait();
  assert.equal(pending.status, 5, pending.stderr);
  assert.match(pending.stdout, /still waiting on checks/);
  assert.doesNotMatch(pending.stdout, /and reviewer/);
  gh.state.statusCheckRollup[0].status = "COMPLETED";
  gh.state.statusCheckRollup[0].conclusion = "FAILURE";
  gh.save();
  const failed = gh.wait();
  assert.equal(failed.status, 2, failed.stderr);
  assert.match(failed.stdout, /1 check failed/);
  gh.state.statusCheckRollup = [];
  gh.save();
  assert.equal(gh.wait().status, 5);
});

test("owner fix requests still stop at the configured total request bound", (t) => {
  const gh = github(t, "owner");
  for (let fix = 0; fix < 5; fix++) {
    gh.push(String(fix + 2).repeat(40));
    assert.equal(gh.run("request.mjs", "--fixes-review").status, 0);
  }
  assert.equal(gh.requests().length, 3); // Opening plus three requests = four.
});

test("app review exception is opt-in and does not convert arriving reviews to approval", (t) => {
  const gh = github(t, app); // REST author form also matches.
  gh.state.reviews.push({
    id: 1,
    user: { login: reviewer.account },
    commit_id: gh.state.headRefOid,
    state: "CHANGES_REQUESTED",
    body: "A finding arrived manually.",
    submitted_at: new Date().toISOString(),
  });
  gh.save();
  const skipped = gh.wait();
  assertSkipped(skipped);
  rmSync(join(gh.root, ".github/factory-review-policy.json"));
  gh.snapshot();
  gh.state.reviews = [];
  gh.save();
  assert.equal(gh.wait().status, 5);
});
