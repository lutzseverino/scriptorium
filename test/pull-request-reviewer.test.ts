import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { directory } from "./fakes.ts";

// Drive both the CLI-backed and Postern-backed installed skill commands,
// observing requests separately from the check/reviewer wait's exit status.
const skill = resolve(import.meta.dirname, "../.agents/skills/babysit");
const platform = await import(pathToFileURL(join(skill, "platform.mjs")).href);
const pinnedChecks = {
  skip:
    typeof platform.pinnedFiles === "function"
      ? false
      : "installed platform.mjs lacks the pinnedFiles contract",
};
const readiness = {
  skip:
    typeof platform.readyForReviewTime === "function"
      ? false
      : "installed platform.mjs lacks the readyForReviewTime contract",
};

type TransportRead = {
  operation: string;
  variables?: Record<string, string>;
  page: string | null;
};
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
  writeFileSync(
    join(root, ".github/required-checks.json"),
    JSON.stringify({ version: 1, checks: ["Test"] }),
  );
  snapshot();
  const opened = new Date(Date.now() - 1000).toISOString();
  const state = {
    author: { login: author },
    isDraft: false,
    configurationFailure: null as "revision" | "files" | null,
    advanceDefaultTo: null as string | null,
    fileResponses: {} as Record<string, unknown>,
    timelinePages: [[]] as Record<string, unknown>[][],
    timelineFailurePage: null as number | null,
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
  writeFileSync(join(root, "transport.json"), "[]");
  writeFileSync(
    join(root, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync("state.json", "utf8"));
let result;
if (args.join(" ") === "repo set-default --view") process.exit(0);
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
    git,
    configuration(path: string, text: string | null) {
      if (text === null) rmSync(join(root, path));
      else writeFileSync(join(root, path), text);
    },
    reads: (): TransportRead[] =>
      JSON.parse(readFileSync(join(root, "transport.json"), "utf8")),
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

// Run both commands where a valid configuration would make request.mjs post a
// fix request, so an empty request log shows that it stopped before writing.
// wait.mjs never posts; its exit status and diagnostic carry the stop.
function assertBothStopBeforeRequest(
  gh: ReturnType<typeof github>,
  status: number,
  diagnostic: RegExp,
) {
  gh.push("2".repeat(40));
  const results = [gh.run("request.mjs", "--fixes-review"), gh.run("wait.mjs")];
  for (const result of results) {
    assert.equal(result.status, status, result.stderr);
    assert.match(result.stderr, diagnostic);
  }
  assert.deepEqual(gh.requests(), []);
  return results;
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

test("a push alone neither requests review nor starts a reviewer wait for the new head", (t) => {
  const gh = github(t, "owner");
  gh.push("2".repeat(40));
  const request = gh.run("request.mjs");
  assert.equal(request.status, 0, request.stderr);
  assert.deepEqual(gh.requests(), []);
  const wait = gh.wait();
  assert.equal(wait.status, 4, wait.stderr);
  assert.match(wait.stdout, /review not requested for this head/);
});

for (const path of [
  ".github/factory-review-policy.json",
  ".github/pull-request-reviewer.json",
]) {
  for (const [kind, text] of [
    ["invalid JSON", "{"],
    ["invalid declaration", '{"version":999}'],
  ] as const) {
    test(`${path} with ${kind} stops both commands before requesting review`, (t) => {
      const gh = github(t, "owner");
      gh.configuration(path, text);
      gh.snapshot();
      for (const result of assertBothStopBeforeRequest(
        gh,
        7,
        /Owner handoff required: invalid trusted/,
      )) {
        assert.ok(result.stderr.includes(path));
        assert.ok(result.stderr.includes(gh.git("rev-parse", "main").trim()));
      }
    });
  }
}

for (const stage of ["revision", "files"] as const) {
  test(`unreadable trusted configuration ${stage} stops both commands before requesting review`, (t) => {
    const gh = github(t, "owner");
    gh.state.configurationFailure = stage;
    gh.save();
    assertBothStopBeforeRequest(
      gh,
      1,
      /Could not read trusted review configuration/,
    );
  });
}

for (const [kind, blob] of [
  [
    "truncated",
    { __typename: "Blob", text: JSON.stringify(policy), isTruncated: true },
  ],
  ["incomplete metadata", { __typename: "Blob", text: JSON.stringify(policy) }],
  ["non-blob", { __typename: "Tree" }],
] as const) {
  test(`${kind} configuration is a read error rather than optional absence`, (t) => {
    const gh = github(t, "owner");
    gh.state.fileResponses[".github/factory-review-policy.json"] = blob;
    gh.save();
    assertBothStopBeforeRequest(
      gh,
      1,
      /Could not read complete .github\/factory-review-policy.json/,
    );
  });
}

test("explicit optional-file absence retains checks-only behavior", (t) => {
  const gh = github(t, "owner");
  gh.configuration(".github/factory-review-policy.json", null);
  gh.configuration(".github/pull-request-reviewer.json", null);
  gh.snapshot();
  const request = gh.run("request.mjs");
  assert.equal(request.status, 0, request.stderr);
  assert.match(request.stdout, /no reviewer configured/);
  const wait = gh.wait();
  assert.equal(wait.status, 0, wait.stderr);
  assert.match(wait.stdout, /checks passed/);
  assert.doesNotMatch(wait.stdout, /reviewer reviewed|external review skipped/);
  assert.deepEqual(gh.requests(), []);
});

test("proposed and dirty configuration cannot override the committed default branch", (t) => {
  const gh = github(t);
  const revision = gh.git("rev-parse", "main").trim();
  gh.git("checkout", "-b", "proposed");
  gh.configuration(".github/factory-review-policy.json", '{"version":999}');
  gh.configuration(".github/pull-request-reviewer.json", "{");
  gh.configuration(
    ".github/required-checks.json",
    '{"version":1,"checks":["Proposed"]}',
  );
  gh.snapshot();
  gh.configuration(".github/factory-review-policy.json", "{");
  const request = gh.run("request.mjs");
  assert.equal(request.status, 0, request.stderr);
  assert.ok(request.stdout.includes(revision));
  assertSkipped(gh.wait());
  const reads = gh.reads().filter((read) => read.variables?.revision);
  assert.ok(reads.length > 0);
  for (const read of reads) {
    assert.equal(read.variables!.revision, revision);
    for (const [alias, expression] of Object.entries(read.variables!)) {
      if (["owner", "name", "revision"].includes(alias)) continue;
      assert.ok(expression.startsWith(`${revision}:`));
    }
  }
  assert.deepEqual(gh.requests(), []);
});

test("a default-branch advance during resolution keeps every configuration file at the selected SHA", (t) => {
  const gh = github(t);
  const revision = gh.git("rev-parse", "main").trim();
  gh.git("checkout", "-b", "next-default");
  gh.configuration(".github/factory-review-policy.json", "{");
  gh.configuration(".github/pull-request-reviewer.json", "{");
  gh.configuration(".github/required-checks.json", "{");
  gh.snapshot();
  gh.state.advanceDefaultTo = gh.git("rev-parse", "HEAD").trim();
  gh.save();
  const wait = gh.wait();
  assertSkipped(wait);
  assert.ok(wait.stdout.includes(revision));
  const reads = gh.reads().filter((read) => read.variables?.revision);
  assert.equal(reads.length, 1);
  assert.equal(reads[0]!.variables!.revision, revision);
  const next = gh.run("request.mjs");
  assert.equal(next.status, 7, next.stderr);
  assert.ok(next.stderr.includes(gh.state.advanceDefaultTo));
  assert.deepEqual(gh.requests(), []);
});

for (const [kind, text] of [
  ["missing", null],
  ["invalid JSON", "{"],
  ["invalid declaration", '{"version":1,"checks":[]}'],
] as const) {
  test(
    `wait requires a valid pinned check declaration: ${kind}`,
    pinnedChecks,
    (t) => {
      const gh = github(t);
      gh.configuration(".github/required-checks.json", text);
      gh.snapshot();
      const request = gh.run("request.mjs");
      assert.equal(request.status, 0, request.stderr);
      assert.ok(
        gh
          .reads()
          .flatMap((read) => Object.values(read.variables ?? {}))
          .every(
            (value) =>
              typeof value !== "string" ||
              !value.endsWith(":.github/required-checks.json"),
          ),
      );
      const wait = gh.wait();
      assert.equal(wait.status, 7, wait.stderr);
      assert.match(
        wait.stderr,
        /Owner handoff required: invalid trusted .github\/required-checks.json/,
      );
      assert.deepEqual(gh.requests(), []);
    },
  );
}

test(
  "every declared check needs positive success even for a matching app author",
  pinnedChecks,
  (t) => {
    const gh = github(t);
    gh.configuration(
      ".github/required-checks.json",
      '{"version":1,"checks":["Test","Security"]}',
    );
    gh.snapshot();
    let wait = gh.wait();
    assert.equal(wait.status, 5, wait.stderr); // Test succeeds; Security is absent.
    assert.match(wait.stdout, /still waiting on checks/);
    assert.doesNotMatch(wait.stdout, /reviewer reviewed|checks passed/);
    const security = {
      ...gh.state.statusCheckRollup[0]!,
      name: "Security",
      conclusion: "SKIPPED",
    };
    gh.state.statusCheckRollup.push(security);
    gh.save();
    wait = gh.wait();
    assert.equal(wait.status, 2, wait.stderr); // Skipping fails the positive-success requirement.
    security.status = "IN_PROGRESS";
    gh.save();
    assert.equal(gh.wait().status, 5);
    security.status = "COMPLETED";
    security.conclusion = "FAILURE";
    gh.save();
    wait = gh.wait();
    assert.equal(wait.status, 2, wait.stderr);
    assert.match(wait.stdout, /1 check failed/);
    security.conclusion = "SUCCESS";
    gh.save();
    assertSkipped(gh.wait());
    assert.deepEqual(gh.requests(), []);
  },
);

function transition(event: string, time: number) {
  return { event, created_at: new Date(time).toISOString() };
}

test(
  "the latest ready event on a later page supplies automatic request timing after re-drafting",
  readiness,
  (t) => {
    const gh = github(t, "owner");
    const now = Date.now();
    const opened = now - 60 * 60_000;
    const pushed = now - 10 * 60_000;
    gh.state.createdAt = new Date(opened).toISOString();
    gh.state.pushedAt = new Date(pushed).toISOString();
    gh.state.isDraft = true;
    gh.state.timelinePages = [
      [
        transition("ready_for_review", opened + 60_000),
        transition("convert_to_draft", pushed),
      ],
      [
        transition("ready_for_review", now - 1000),
        transition("convert_to_draft", now),
      ],
      [transition("ready_for_review", opened + 120_000)], // Older entry cannot replace latest.
    ];
    gh.save();
    const request = gh.run("request.mjs", "--fixes-review");
    assert.equal(request.status, 0, request.stderr);
    assert.match(request.stdout, /review already requested for this head/);
    assert.deepEqual(gh.requests(), []);
    const wait = gh.wait();
    assert.equal(wait.status, 5, wait.stderr);
    assert.match(wait.stdout, /still waiting on reviewer/);
    assert.deepEqual(
      gh
        .reads()
        .filter((read) => read.operation.endsWith("/timeline"))
        .map((read) => read.page),
      [null, "2", "3", null, "2", "3"],
    );
  },
);

test(
  "readiness transitions do not consume additional total-request slots",
  readiness,
  (t) => {
    const gh = github(t, "owner");
    gh.configuration(
      ".github/pull-request-reviewer.json",
      JSON.stringify({
        ...reviewer,
        bounds: { ...reviewer.bounds, reviewRequests: 2 },
      }),
    );
    gh.snapshot();
    for (let index = 0; index < 4; index++) {
      gh.state.timelinePages[0]!.push(
        transition("ready_for_review", Date.now()),
      );
      gh.save();
      const request = gh.run("request.mjs");
      assert.equal(request.status, 0, request.stderr);
      assert.deepEqual(gh.requests(), []);
    }
    gh.push("2".repeat(40));
    assert.equal(gh.run("request.mjs", "--fixes-review").status, 0);
    assert.equal(gh.requests().length, 1); // Opening plus explicit request reaches two.
    gh.push("3".repeat(40));
    const bounded = gh.run("request.mjs", "--fixes-review");
    assert.equal(bounded.status, 0, bounded.stderr);
    assert.match(bounded.stdout, /review request bound reached/);
    assert.equal(gh.requests().length, 1);
  },
);

for (const failure of [
  "unreadable later page",
  "malformed ready-event timestamp",
] as const) {
  test(
    `${failure} fails both commands instead of falling back to opening time`,
    readiness,
    (t) => {
      const gh = github(t, "owner");
      gh.state.timelinePages = [
        [transition("ready_for_review", Date.now())],
        [],
      ];
      if (failure === "unreadable later page") gh.state.timelineFailurePage = 2;
      else
        gh.state.timelinePages[1]!.push({
          event: "ready_for_review",
          created_at: "invalid",
        });
      gh.save();
      assertBothStopBeforeRequest(
        gh,
        1,
        failure === "unreadable later page"
          ? /GitHub could not be reached/
          : /Could not read a ready-for-review time/,
      );
    },
  );
}

for (const mode of ["explicit-only reviewer", "matching app policy"] as const) {
  test(
    `${mode} does not depend on automatic readiness timing`,
    readiness,
    (t) => {
      const gh = github(t, mode === "matching app policy" ? app : "owner");
      if (mode === "explicit-only reviewer") {
        gh.configuration(
          ".github/pull-request-reviewer.json",
          JSON.stringify({
            ...reviewer,
            request: { ...reviewer.request, onOpen: false },
          }),
        );
        gh.snapshot();
      }
      gh.state.timelineFailurePage = 1;
      gh.save();
      const request = gh.run("request.mjs");
      assert.equal(request.status, 0, request.stderr);
      const wait = gh.wait();
      if (mode === "matching app policy") {
        assertSkipped(wait);
        assert.deepEqual(gh.requests(), []);
      } else {
        assert.equal(wait.status, 5, wait.stderr);
        assert.match(wait.stdout, /still waiting on reviewer/);
        assert.deepEqual(gh.requests(), [reviewer.request.comment]);
      }
      assert.ok(
        gh.reads().every((read) => !read.operation.endsWith("/timeline")),
      );
    },
  );
}
