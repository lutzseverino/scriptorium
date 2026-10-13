import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import type { RunOptions } from "@ai-hero/sandcastle";
import type { DockerOptions } from "@ai-hero/sandcastle/sandboxes/docker";
import { sandboxEnvironment } from "../src/github-token.ts";
import { createHost, type HostPorts } from "../src/host.ts";
import type { HostConfiguration } from "../src/host-configuration.ts";
import { createRegistry } from "../src/providers.ts";
import { directory } from "./fakes.ts";

// The host runner, run against a stateful GitHub CLI fake, real Git clones
// of local bare remotes, the provider registry over a fake Sandcastle, and a
// temporary state directory.

type IssueSpec = {
  number: number;
  state?: "OPEN" | "CLOSED";
  createdAt?: string;
  labels?: string[];
  parent?: number;
  subIssues?: { number: number; state?: string }[];
  blockedBy?: { number: number; state: string }[];
  pullRequests?: string[];
  comments?: string[];
};

const environment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.test",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function write(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

const toolchain = "FROM debian:bookworm-slim\n";

// A bare remote whose default branch holds `files`.
function remote(t: TestContext, files: Record<string, string>): string {
  const root = directory(t);
  const bare = join(root, "remote.git");
  const work = join(root, "work");
  git(root, ["init", "--quiet", "--bare", "--initial-branch=main", bare]);
  git(root, ["init", "--quiet", "--initial-branch=main", work]);
  write(work, files);
  git(work, ["add", "."]);
  git(work, ["commit", "--quiet", "-m", "base"]);
  git(work, ["push", "--quiet", bare, "main"]);
  return bare;
}

function fakeGitHub(
  repositories: Record<string, IssueSpec[]>,
  tokens: Record<string, string>,
) {
  const state = Object.fromEntries(
    Object.entries(repositories).map(([name, issues]) => [
      name,
      issues.map((issue) => ({
        state: "OPEN",
        createdAt: `2026-10-0${issue.number}T00:00:00Z`,
        labels: ["ready-for-agent"],
        subIssues: [],
        blockedBy: [],
        pullRequests: [],
        comments: [] as string[],
        ...issue,
      })),
    ]),
  );
  const find = (repository: string, number: number | string) => {
    const issue = state[repository].find(
      (candidate) => candidate.number === Number(number),
    );
    assert.ok(issue, `${repository}#${number} exists`);
    return issue;
  };
  const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
  const field = (args: string[], name: string) =>
    args
      .find(
        (arg, index) => args[index - 1] === "-F" && arg.startsWith(`${name}=`),
      )
      ?.slice(name.length + 1);
  const names = (labels: string[]) => ({
    nodes: labels.map((name) => ({ name })),
  });

  // Edits GitHub refuses, as `<owner>/<name>#<n>`.
  const refused = new Set<string>();

  async function gh(token: string, args: string[]): Promise<string> {
    const repository =
      args[0] === "api"
        ? `${field(args, "owner")}/${field(args, "name")}`
        : value(args, "--repo");
    assert.equal(token, tokens[repository], `${repository}'s token`);
    if (args[0] === "api") {
      const query = args.find((arg) => arg.startsWith("query="))!;
      if (query.includes("closedByPullRequestsReferences")) {
        const issue = find(repository, field(args, "number")!);
        assert.equal(field(args, "branch"), `factory/issue-${issue.number}`);
        return JSON.stringify({
          data: {
            repository: {
              issue: {
                state: issue.state,
                closedByPullRequestsReferences: {
                  nodes: issue.pullRequests.map((pullRequest) => ({
                    state: pullRequest,
                    createdAt: "2026-10-09T12:00:00Z",
                    isCrossRepository: false,
                  })),
                },
              },
              pullRequests: { nodes: [] },
            },
          },
        });
      }
      const local = (number: number) => ({
        number,
        repository: { nameWithOwner: repository },
      });
      return JSON.stringify([
        {
          data: {
            repository: {
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: state[repository]
                  .filter((issue) => issue.state === "OPEN")
                  .map((issue) => ({
                    number: issue.number,
                    createdAt: issue.createdAt,
                    labels: names(issue.labels),
                    parent: issue.parent ? local(issue.parent) : null,
                    subIssues: {
                      nodes: issue.subIssues.map((child) => ({
                        ...local(child.number),
                        state: child.state ?? "OPEN",
                      })),
                    },
                    blockedBy: { nodes: issue.blockedBy },
                    labelEvents: { nodes: [] },
                    linkEvents: { nodes: [] },
                  })),
              },
            },
          },
        },
      ]);
    }
    if (args[0] === "issue" && args[1] === "list")
      return JSON.stringify(
        state[repository]
          .filter(
            (issue) =>
              issue.state === "CLOSED" &&
              issue.labels.includes(value(args, "--label")),
          )
          .map(({ number }) => ({ number })),
      );
    const issue = find(repository, args[2]);
    if (args[1] === "edit") {
      if (refused.has(`${repository}#${issue.number}`))
        throw new Error("GitHub refused the edit");
      for (let index = 5; index < args.length; index += 2)
        if (args[index] === "--add-label") issue.labels.push(args[index + 1]);
        else if (args[index] === "--remove-label")
          issue.labels = issue.labels.filter(
            (label) => label !== args[index + 1],
          );
        else throw new Error(`unexpected gh issue edit flag ${args[index]}`);
      return "";
    }
    if (args[1] === "comment") {
      issue.comments.push(value(args, "--body"));
      return "";
    }
    if (args[1] === "close") {
      issue.comments.push(value(args, "--comment"));
      issue.state = "CLOSED";
      return "";
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  }

  return { gh, find, refused };
}

// Sandcastle that records each run, with the token the sandbox would read,
// until the test finishes it or its sandbox is removed.
function fakeSandcastle() {
  const launched: {
    options: RunOptions;
    docker: DockerOptions;
    hosts: string;
    finish(error?: Error): void;
    removed: boolean;
  }[] = [];
  let docker: DockerOptions;
  return {
    launched,
    sandcastle: {
      docker(options: DockerOptions) {
        docker = options;
        return { name: "docker" } as unknown as RunOptions["sandbox"];
      },
      run(options: RunOptions) {
        const github = docker.mounts?.find(
          (mount) => mount.sandboxPath === "/run/factory/github",
        );
        return new Promise((resolve, reject) => {
          launched.push({
            options,
            docker,
            hosts: github
              ? readFileSync(join(github.hostPath, "hosts.yml"), "utf8")
              : "",
            finish: (error) => (error ? reject(error) : resolve(undefined)),
            removed: false,
          });
          options.signal?.addEventListener("abort", () =>
            reject(options.signal!.reason),
          );
        });
      },
    },
  };
}

const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

const settled = () => new Promise((resolve) => setImmediate(resolve));

function host(
  t: TestContext,
  {
    repositories,
    remotes,
    tokens = {},
    configuration = {},
    caps = { "claude-code": 2, codex: 1 },
    imageFailures = [],
  }: {
    repositories: Record<string, IssueSpec[]>;
    remotes: Record<string, string>;
    tokens?: Record<string, string | Error>;
    configuration?: Partial<HostConfiguration>;
    caps?: { "claude-code": number; codex: number };
    imageFailures?: Error[];
  },
) {
  const root = directory(t);
  const claudeToken = join(root, "claude-token");
  const codexLogin = join(root, "codex-auth.json");
  writeFileSync(claudeToken, "claude-secret\n");
  writeFileSync(codexLogin, "{}\n");
  const tokenOf = Object.fromEntries(
    Object.keys(repositories).map((name) => [
      name,
      tokens[name] ?? `ghs_${name.replace("/", "_")}`,
    ]),
  );
  const github = fakeGitHub(
    repositories,
    Object.fromEntries(
      Object.entries(tokenOf).filter(([, token]) => typeof token === "string"),
    ) as Record<string, string>,
  );
  const { sandcastle, launched } = fakeSandcastle();
  const resolved: HostConfiguration = {
    repositories: Object.keys(repositories),
    providers: {
      "claude-code": { cap: caps["claude-code"], credential: claudeToken },
      codex: { cap: caps.codex, credential: codexLogin },
    },
    models: { default: "claude-sonnet-5-5", retry: "gpt-5.5" },
    timeLimitMinutes: 240,
    usageThreshold: 80,
    pollSeconds: 300,
    readiness: { authorizedRoles: ["admin"] },
    unpushablePaths: [".github/workflows/"],
    stateDirectory: join(root, "state"),
    gitIdentity: { name: "Factory", email: "factory@example.test" },
    github: { tokenCommand: ["unused"] },
    ...configuration,
  };
  const registry = createRegistry(resolved.providers, {
    sandcastle,
    fetch: () => {
      throw new Error("the host reads usage through its port");
    },
    codexExecutable: "/nonexistent/codex",
  });
  const builds: string[] = [];
  const reports: string[] = [];
  const clock = { now: new Date("2026-10-09T12:00:00Z") };
  // Sandbox removals and issue edits, in order.
  const events: string[] = [];
  const ports: HostPorts = {
    async gh(token, args) {
      if (args[0] === "issue" && args[1] === "edit")
        events.push(
          `edit ${value(args, "--repo")}#${args[2]} ${args.slice(5).join(" ")}`,
        );
      return github.gh(token, args);
    },
    git: async (_token, cwd, args) => git(cwd, args),
    async token(repository) {
      const token = tokenOf[repository];
      if (token instanceof Error) throw token;
      return token;
    },
    remoteUrl: (repository) => remotes[repository],
    async buildImage(dockerfile) {
      builds.push(dockerfile);
      if (imageFailures.length > 0) throw imageFailures.shift();
      return `factory-sandbox:${builds.length}`;
    },
    readUsage: async () => null,
    launch: (provider, request) =>
      registry.providers.get(provider)!.launch(request),
    // The sandboxes are the launches whose agents have not finished; a
    // removed one never finishes.
    stopSandboxes() {
      events.push("stop sandboxes");
      for (const launch of launched) launch.removed = true;
    },
    now: () => clock.now,
    report: (line) => reports.push(line),
  };
  const instance = createHost(resolved, registry, ports);
  const state = resolved.stateDirectory;
  return {
    ...instance,
    // A new process on the same host, state directory and GitHub.
    restart: () => createHost(resolved, registry, ports),
    events,
    github,
    launched,
    builds,
    reports,
    clock,
    state,
    clone: (name: string) => join(state, "repositories", name, "clone"),
    status: () => JSON.parse(readFileSync(join(state, "status.json"), "utf8")),
  };
}

const factoryFiles = {
  ".factory/Dockerfile": toolchain,
  "README.md": "base\n",
  ".github/workflows/old.yml": "old\n",
};

test("one process launches each repository's ready issues from that repository's clone", async (t) => {
  const widgets = remote(t, factoryFiles);
  const gadgets = remote(t, {
    ...factoryFiles,
    ".factory/Dockerfile": "FROM ubuntu:24.04\n",
  });
  const run = host(t, {
    repositories: {
      "acme/widgets": [{ number: 4 }],
      "acme/gadgets": [
        { number: 3, labels: ["ready-for-agent", "model:gpt-5.5"] },
      ],
    },
    remotes: { "acme/widgets": widgets, "acme/gadgets": gadgets },
  });
  await run.tick();
  assert.deepEqual(run.builds, [toolchain, "FROM ubuntu:24.04\n"]);
  assert.deepEqual(run.github.find("acme/widgets", 4).labels, [
    "ready-for-agent",
    "factory:running",
  ]);
  assert.deepEqual(run.github.find("acme/gadgets", 3).labels, [
    "ready-for-agent",
    "model:gpt-5.5",
    "factory:running",
  ]);
  assert.deepEqual(
    run.launched.map(({ options, docker }) => ({
      name: options.name,
      cwd: options.cwd,
      agent: options.agent.name,
      prompt: options.prompt,
      branch: options.branchStrategy,
      log: options.logging,
      image: docker.imageName,
    })),
    [
      {
        name: "acme/gadgets#3",
        cwd: run.clone("acme/gadgets"),
        agent: "codex",
        prompt: "$implement #3",
        branch: { type: "branch", branch: "factory/issue-3" },
        log: {
          type: "file",
          path: join(
            run.state,
            "repositories/acme/gadgets/logs/issue-3-attempt-1.log",
          ),
        },
        image: "factory-sandbox:2",
      },
      {
        name: "acme/widgets#4",
        cwd: run.clone("acme/widgets"),
        agent: "claude-code",
        prompt: "/implement #4",
        branch: { type: "branch", branch: "factory/issue-4" },
        log: {
          type: "file",
          path: join(
            run.state,
            "repositories/acme/widgets/logs/issue-4-attempt-1.log",
          ),
        },
        image: "factory-sandbox:1",
      },
    ],
  );
  assert.equal(
    readFileSync(join(run.clone("acme/widgets"), "README.md"), "utf8"),
    "base\n",
  );
  const record = JSON.parse(
    readFileSync(
      join(run.state, "repositories/acme/widgets/runs/issue-4-attempt-1.json"),
      "utf8",
    ),
  );
  assert.equal(record.attempt, 1);
  assert.equal(record.exited, false);
});

test("a sandbox reads its repository's token from a mounted file that outlives no run", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  await run.tick();
  const [launch] = run.launched;
  const github = launch.docker.mounts!.find(
    (mount) => mount.sandboxPath === "/run/factory/github",
  )!;
  assert.equal(github.readonly, true);
  assert.match(launch.hosts, /oauth_token: "ghs_acme_widgets"/);
  assert.deepEqual(launch.docker.env, sandboxEnvironment);
  assert.equal(
    JSON.stringify(launch.options).includes("ghs_acme_widgets"),
    false,
    "the token reaches the sandbox only through the file",
  );
  assert.equal(
    existsSync(join(run.clone("acme/widgets"), ".sandcastle", ".env")),
    false,
  );
  launch.finish();
  for (let wait = 0; wait < 100 && existsSync(github.hostPath); wait++)
    await settled();
  assert.equal(existsSync(github.hostPath), false);
});

test("each clone ignores Sandcastle's directory locally and follows its remote", async (t) => {
  const widgets = remote(t, factoryFiles);
  const run = host(t, {
    repositories: { "acme/widgets": [] },
    remotes: { "acme/widgets": widgets },
  });
  await run.tick();
  const clone = run.clone("acme/widgets");
  write(clone, { ".sandcastle/worktrees/factory-issue-4/file": "work\n" });
  assert.equal(git(clone, ["status", "--porcelain"]), "");
  assert.equal(git(clone, ["config", "user.name"]).trim(), "Factory");
  assert.equal(
    git(clone, ["config", "user.email"]).trim(),
    "factory@example.test",
  );
  const work = join(dirname(widgets), "work");
  write(work, { "README.md": "advanced\n" });
  git(work, ["commit", "--quiet", "-am", "advance"]);
  git(work, ["push", "--quiet", widgets, "main"]);
  await run.tick();
  assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "advanced\n");
  assert.equal(
    readFileSync(join(clone, ".git/info/exclude"), "utf8").match(
      /^\/\.sandcastle\/$/gm,
    )?.length,
    1,
  );
});

test("the status file lists each repository's state and its held issues", async (t) => {
  const run = host(t, {
    repositories: {
      "acme/widgets": [
        { number: 4 },
        { number: 5, blockedBy: [{ number: 4, state: "OPEN" }] },
      ],
      "acme/gadgets": [{ number: 2 }],
      "acme/tools": [{ number: 1 }],
    },
    remotes: {
      "acme/widgets": remote(t, factoryFiles),
      "acme/gadgets": remote(t, { "README.md": "no factory\n" }),
      "acme/tools": remote(t, factoryFiles),
    },
    tokens: {
      "acme/tools": new Error("the token command for acme/tools failed with 1"),
    },
  });
  await run.tick();
  assert.deepEqual(run.status(), {
    updatedAt: "2026-10-09T12:00:00.000Z",
    repositories: [
      {
        repository: "acme/widgets",
        state: "running",
        held: [{ issue: 5, reason: "blocked by #4" }],
      },
      {
        repository: "acme/gadgets",
        state: "paused",
        reason: "it has no .factory/Dockerfile",
        held: [
          {
            issue: 2,
            reason: "acme/gadgets is paused: it has no .factory/Dockerfile",
          },
        ],
      },
      {
        repository: "acme/tools",
        state: "paused",
        reason: "the token command for acme/tools failed with 1",
        held: [],
      },
    ],
  });
  assert.deepEqual(
    run.launched.map(({ options }) => options.name),
    ["acme/widgets#4"],
  );
  assert.deepEqual(run.github.find("acme/gadgets", 2).labels, [
    "ready-for-agent",
  ]);
  assert.ok(
    run.reports.includes(
      "acme/gadgets is paused: it has no .factory/Dockerfile",
    ),
    run.reports.join("\n"),
  );
  assert.ok(
    run.reports.includes("acme/widgets#5 skipped: blocked by #4"),
    run.reports.join("\n"),
  );
});

test("an image that does not build pauses only its repository until it builds", async (t) => {
  const run = host(t, {
    repositories: {
      "acme/widgets": [{ number: 4 }],
      "acme/gadgets": [{ number: 3 }],
    },
    remotes: {
      "acme/widgets": remote(t, factoryFiles),
      "acme/gadgets": remote(t, factoryFiles),
    },
    imageFailures: [new Error("apt-get exited with 100")],
  });
  await run.tick();
  assert.deepEqual(
    run.launched.map(({ options }) => options.name),
    ["acme/gadgets#3"],
  );
  assert.deepEqual(run.status().repositories[0], {
    repository: "acme/widgets",
    state: "paused",
    reason: "its sandbox image did not build: Error: apt-get exited with 100",
    held: [
      {
        issue: 4,
        reason:
          "acme/widgets is paused: its sandbox image did not build: Error: apt-get exited with 100",
      },
    ],
  });
  assert.deepEqual(run.github.find("acme/widgets", 4).labels, [
    "ready-for-agent",
  ]);
  await run.tick();
  assert.deepEqual(
    run.launched.map(({ options }) => options.name),
    ["acme/gadgets#3", "acme/widgets#4"],
  );
  assert.equal(run.status().repositories[0].state, "running");
});

test("a failed write stops only its repository's decisions for the pass", async (t) => {
  const run = host(t, {
    repositories: {
      "acme/widgets": [{ number: 4 }, { number: 5 }],
      "acme/gadgets": [{ number: 6 }],
    },
    remotes: {
      "acme/widgets": remote(t, factoryFiles),
      "acme/gadgets": remote(t, factoryFiles),
    },
    caps: { "claude-code": 3, codex: 1 },
  });
  run.github.refused.add("acme/widgets#4");
  await run.tick();
  assert.deepEqual(
    run.launched.map(({ options }) => options.name),
    ["acme/gadgets#6"],
  );
  assert.deepEqual(run.github.find("acme/widgets", 5).labels, [
    "ready-for-agent",
  ]);
  assert.ok(
    run.reports.includes(
      "acme/widgets#4 claim failed, so acme/widgets waits for the next pass: Error: GitHub refused the edit",
    ),
    run.reports.join("\n"),
  );
});

test("a failed first run retries with its failure and log tail after the provider's invocation", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  await run.tick();
  const log = (run.launched[0].options.logging as { path: string }).path;
  writeFileSync(log, "first line\nlast line\n");
  run.launched[0].finish(new Error("agent crashed"));
  await settled();
  await run.tick();
  assert.equal(run.launched.length, 2);
  assert.equal(run.launched[1].options.agent.name, "codex");
  assert.equal(
    run.launched[1].options.prompt,
    [
      "$implement #4",
      "First attempt failure: the run ended without an open pull request",
      "First attempt log tail:\nfirst line\nlast line\n",
    ].join("\n\n"),
  );
  run.launched[1].finish();
  await settled();
  await run.tick();
  const [comment] = run.github.find("acme/widgets", 4).comments;
  assert.equal(
    comment,
    [
      "The factory run failed: the run ended without an open pull request.",
      "",
      "- Model: `codex/gpt-5.5@high`, attempt 2",
      `- Log: \`${join(run.state, "repositories/acme/widgets/logs/issue-4-attempt-2.log")}\` on the factory host`,
      "",
      "Remove `factory:failed` to let the factory pick this issue up again.",
    ].join("\n"),
  );
  assert.deepEqual(run.github.find("acme/widgets", 4).labels, [
    "ready-for-agent",
    "factory:failed",
  ]);
});

test("a run whose pull request is open leaves the host and frees its cap slot", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }, { number: 5 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
    caps: { "claude-code": 1, codex: 1 },
  });
  await run.tick();
  assert.deepEqual(run.status().repositories[0].held, [
    { issue: 5, reason: "claude-code already runs its cap of 1 agent" },
  ]);
  run.github.find("acme/widgets", 4).pullRequests.push("OPEN");
  run.launched[0].finish();
  await settled();
  const decisions = await run.tick();
  assert.deepEqual(
    decisions.filter((decision) => decision.kind !== "skip"),
    [
      { kind: "keep", repository: "acme/widgets", issue: 4 },
      { kind: "claim", repository: "acme/widgets", issue: 5 },
      {
        kind: "launch",
        repository: "acme/widgets",
        issue: 5,
        provider: "claude-code",
        model: "claude-sonnet-5-5",
        effort: "high",
        attempt: 1,
      },
    ],
  );
  assert.deepEqual(run.github.find("acme/widgets", 4).labels, [
    "ready-for-agent",
    "factory:running",
  ]);
  await run.tick();
  assert.equal(run.launched.length, 2, "the awaiting claim holds no slot");
});

for (const scenario of [
  "absent",
  "behind",
  "pushed",
  "pushed workflow with local docs",
  "pushed workflow with local workflow",
  "contains",
  "ordinary",
  "removed",
  "reverted",
  "base advanced",
]) {
  test(`an ended run's unpushable changes are read from real Git with remote ${scenario}`, async (t) => {
    const bare = remote(t, factoryFiles);
    const run = host(t, {
      repositories: { "acme/widgets": [{ number: 4 }] },
      remotes: { "acme/widgets": bare },
    });
    await run.tick();
    // The agent works in Sandcastle's worktree of the clone.
    const clone = run.clone("acme/widgets");
    const work = join(clone, ".sandcastle/worktrees/factory-issue-4");
    git(clone, ["worktree", "add", "--quiet", "-b", "factory/issue-4", work]);
    const commit = (files: Record<string, string>, message: string) => {
      write(work, files);
      git(work, ["add", "."]);
      git(work, ["commit", "--quiet", "-m", message]);
    };
    const push = () =>
      git(work, ["push", "--quiet", "origin", "HEAD:factory/issue-4"]);
    if (scenario === "behind") push();
    commit(
      {
        [scenario === "ordinary" ? "README.md" : ".github/workflows/new.yml"]:
          "changed\n",
      },
      "change",
    );
    if (scenario.startsWith("pushed workflow with")) {
      push();
      commit(
        {
          [scenario === "pushed workflow with local docs"
            ? "README.md"
            : ".github/workflows/old.yml"]: "local change\n",
        },
        "local change",
      );
    }
    if (scenario === "removed") {
      git(work, ["rm", "--quiet", ".github/workflows/old.yml"]);
      git(work, ["commit", "--quiet", "-m", "delete workflow"]);
    }
    if (scenario === "reverted") git(work, ["revert", "--no-edit", "HEAD"]);
    if (scenario === "base advanced")
      git(work, ["push", "--quiet", "origin", "HEAD:main"]);
    if (["pushed", "contains"].includes(scenario)) push();
    if (scenario === "contains") {
      const head = git(work, ["rev-parse", "HEAD"]).trim();
      git(work, ["commit", "--quiet", "--allow-empty", "-m", "successor"]);
      push();
      git(work, ["reset", "--quiet", "--hard", head]);
    }
    run.launched[0].finish();
    await settled();
    const decisions = await run.tick();
    const failing = [
      "absent",
      "behind",
      "pushed workflow with local workflow",
      "removed",
      "reverted",
      "base advanced",
    ].includes(scenario);
    if (failing) {
      const paths =
        scenario === "pushed workflow with local workflow"
          ? [".github/workflows/old.yml"]
          : [
              ".github/workflows/new.yml",
              ...(scenario === "removed" ? [".github/workflows/old.yml"] : []),
            ];
      assert.deepEqual(decisions[0], {
        kind: "fail",
        repository: "acme/widgets",
        issue: 4,
        failure:
          "the run's branch changes paths the factory's GitHub App can't push",
        unpushedChanges: paths,
        log: join(
          run.state,
          "repositories/acme/widgets/logs/issue-4-attempt-1.log",
        ),
      });
      const [comment] = run.github.find("acme/widgets", 4).comments;
      for (const path of paths)
        assert.ok(comment.includes(`- Unpushable: \`${path}\``), comment);
      assert.match(
        comment,
        /A person with permission to push these paths must deliver the change\./,
      );
      assert.match(comment, /claude-code\/claude-sonnet-5-5@high/);
      assert.equal(run.launched.length, 1);
    } else {
      assert.equal(decisions[0].kind, "launch");
      assert.equal(decisions[0].kind === "launch" && decisions[0].attempt, 2);
      run.launched[1].finish();
    }
  });
}

const recordOf = (state: string, issue: number, attempt: number) =>
  JSON.parse(
    readFileSync(
      join(
        state,
        `repositories/acme/widgets/runs/issue-${issue}-attempt-${attempt}.json`,
      ),
      "utf8",
    ),
  );

test("the first pass removes the sandboxes an earlier process left before it claims anything", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  await run.tick();
  await run.tick();
  assert.deepEqual(run.events, [
    "stop sandboxes",
    "edit acme/widgets#4 --add-label factory:running",
  ]);
});

test("a stop signal records the running runs as interrupted and removes their sandboxes without waiting for them", async (t) => {
  const run = host(t, {
    repositories: {
      "acme/widgets": [{ number: 4 }, { number: 5, labels: [] }],
    },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  await run.tick();
  const [launch] = run.launched;
  const tokens = launch.docker.mounts!.find(
    (mount) => mount.sandboxPath === "/run/factory/github",
  )!.hostPath;
  run.clock.now = new Date("2026-10-09T12:30:00Z");
  run.interrupt();
  assert.deepEqual(run.events, [
    "stop sandboxes",
    "edit acme/widgets#4 --add-label factory:running",
    "stop sandboxes",
  ]);
  assert.equal(launch.removed, true);
  assert.equal(existsSync(tokens), false);
  const interrupted = {
    attempt: 1,
    ended: { interrupted: true },
    exited: true,
    exitedAt: "2026-10-09T12:30:00.000Z",
    interrupted: true,
    settled: false,
  };
  const pick = (record: Record<string, unknown>) =>
    Object.fromEntries(
      Object.keys(interrupted).map((name) => [name, record[name]]),
    );
  assert.deepEqual(pick(recordOf(run.state, 4, 1)), interrupted);
  // The process claims and launches nothing more, and an agent that ends
  // after the signal leaves its interrupted record as it is.
  run.github.find("acme/widgets", 5).labels.push("ready-for-agent");
  assert.deepEqual(await run.tick(), []);
  assert.deepEqual(run.github.find("acme/widgets", 5).labels, [
    "ready-for-agent",
  ]);
  assert.equal(run.launched.length, 1);
  launch.finish();
  await settled();
  assert.deepEqual(pick(recordOf(run.state, 4, 1)), interrupted);
});

test("after a restart an interrupted run relaunches as the same attempt on its branch", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  await run.tick();
  const firstLog = (run.launched[0].options.logging as { path: string }).path;
  writeFileSync(firstLog, "first attempt\n");
  run.launched[0].finish(new Error("agent crashed"));
  await settled();
  await run.tick();
  const retried = run.launched[1];
  run.interrupt();

  const restarted = run.restart();
  const decisions = await restarted.tick();
  assert.deepEqual(decisions, [
    {
      kind: "launch",
      repository: "acme/widgets",
      issue: 4,
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
      attempt: 2,
      retry: {
        failure: "the run ended without an open pull request",
        log: firstLog,
      },
      relaunch: true,
    },
  ]);
  assert.deepEqual(run.events, [
    "stop sandboxes",
    "edit acme/widgets#4 --add-label factory:running",
    "stop sandboxes",
    "stop sandboxes",
  ]);
  const relaunched = run.launched[2];
  assert.equal(relaunched.options.agent.name, "codex");
  assert.equal(relaunched.options.prompt, retried.options.prompt);
  assert.deepEqual(relaunched.options.branchStrategy, {
    type: "branch",
    branch: "factory/issue-4",
  });
  assert.deepEqual(relaunched.options.logging, retried.options.logging);
  assert.deepEqual(run.github.find("acme/widgets", 4).labels, [
    "ready-for-agent",
    "factory:running",
  ]);
  assert.equal(recordOf(run.state, 4, 1).settled, true);
  const record = recordOf(run.state, 4, 2);
  assert.equal(record.attempt, 2);
  assert.equal(record.interrupted, false);

  // The relaunch ends as the second attempt, so it fails without a retry.
  relaunched.finish();
  await settled();
  await restarted.tick();
  assert.match(
    run.github.find("acme/widgets", 4).comments[0],
    /`codex\/gpt-5\.5@high`, attempt 2/,
  );
  assert.equal(run.launched.length, 3);
});
