import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import type { RunOptions } from "@ai-hero/sandcastle";
import type { DockerOptions } from "@ai-hero/sandcastle/sandboxes/docker";
import { sandboxEnvironment } from "../src/github-token.ts";
import { createHost, type HostPorts } from "../src/host.ts";
import type { HostConfiguration } from "../src/host-configuration.ts";
import { createRegistry } from "../src/providers.ts";
import { UsageReadError } from "../src/providers/usage.ts";
import { directory } from "./fakes.ts";

// The host runner, run against a stateful GitHub CLI fake, real Git clones
// of local bare remotes, the provider registry over a fake Sandcastle, and a
// temporary state directory.

// One event of an issue's timeline, the one shape every timeline fixture
// takes. `edited` is a body edit and `renamed` a title edit. An actor whose
// login ends in `[bot]` is a bot or app, and a null actor an account GitHub
// no longer knows.
type TimelineEvent = { at: string } & (
  | { event: "labeled"; label: string; actor: string | null }
  | { event: "edited" | "renamed" | "commented" }
  | { event: "linked"; subIssue: number }
);

// The GraphQL timeline item type each fixture event appears as; a body edit
// is no timeline item.
const itemTypes = {
  labeled: "LABELED_EVENT",
  renamed: "RENAMED_TITLE_EVENT",
  commented: "ISSUE_COMMENT",
  linked: "SUB_ISSUE_ADDED_EVENT",
  edited: null,
} as const;

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
  // Events after the issue's creation, when the owner applied its labels.
  timeline?: TimelineEvent[];
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

// GitHub, which accepts only the token the command last printed for each
// repository and reads each account's repository role from `roles`.
function fakeGitHub(
  repositories: Record<string, IssueSpec[]>,
  tokens: Record<string, string | Error>,
  roles: Record<string, string | Error>,
) {
  const state = Object.fromEntries(
    Object.entries(repositories).map(([name, issues]) => [
      name,
      issues.map((spec) => {
        const issue = {
          state: "OPEN",
          createdAt: `2026-10-0${spec.number}T00:00:00Z`,
          labels: ["ready-for-agent"],
          subIssues: [],
          blockedBy: [],
          pullRequests: [],
          comments: [] as string[],
          ...spec,
        };
        return {
          ...issue,
          timeline: [
            ...issue.labels.map((label): TimelineEvent => ({
              event: "labeled",
              label,
              actor: "owner",
              at: issue.createdAt,
            })),
            ...(spec.timeline ?? []),
          ],
        };
      }),
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

  const calls: string[][] = [];
  const labels = new Map<string, Set<string>>();

  // Edits GitHub refuses, as `<owner>/<name>#<n>`.
  const refused = new Set<string>();

  // The issue's timeline items of the types a `timelineItems` connection
  // asks for, oldest first, like GitHub's.
  const timelineItems = (
    issue: (typeof state)[string][number],
    types: string[],
    last: number,
    local: (number: number) => unknown,
  ) => ({
    nodes: issue.timeline
      .filter((item) => types.includes(itemTypes[item.event] ?? ""))
      .slice(-last)
      .map((item) => ({
        createdAt: item.at,
        ...(item.event === "labeled" && {
          label: { name: item.label },
          actor:
            item.actor === null
              ? null
              : item.actor.endsWith("[bot]")
                ? { __typename: "Bot", login: item.actor.slice(0, -5) }
                : { __typename: "User", login: item.actor },
        }),
        ...(item.event === "linked" && { subIssue: local(item.subIssue) }),
      })),
  });
  const latest = (items: TimelineEvent[]) =>
    items
      .map((item) => item.at)
      .sort()
      .at(-1) ?? null;

  async function gh(token: string, args: string[]): Promise<string> {
    calls.push(args);
    const permission =
      args[0] === "api" &&
      /^repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)\/permission$/.exec(
        args[1],
      );
    const repository = permission
      ? permission[1]
      : args[0] === "api"
        ? `${field(args, "owner")}/${field(args, "name")}`
        : value(args, "--repo");
    assert.equal(token, tokens[repository], `${repository}'s token`);
    if (permission) {
      assert.equal(args.length, 2);
      const role = roles[permission[2]] ?? "";
      if (role instanceof Error) throw role;
      return JSON.stringify({ role_name: role });
    }
    if (args[0] === "label" && args[1] === "create") {
      const existing = labels.get(repository) ?? new Set<string>();
      existing.add(args[2]);
      labels.set(repository, existing);
      return "";
    }
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
      const connections = [
        ...query.matchAll(
          /(\w+): timelineItems\(itemTypes: \[([A-Z_, ]+)\], last: (\d+)\)/g,
        ),
      ];
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
                    updatedAt: latest(issue.timeline) ?? issue.createdAt,
                    lastEditedAt: latest(
                      issue.timeline.filter((item) => item.event === "edited"),
                    ),
                    labels: names(issue.labels),
                    parent: issue.parent ? local(issue.parent) : null,
                    subIssues: {
                      nodes: issue.subIssues.map((child) => ({
                        ...local(child.number),
                        state: child.state ?? "OPEN",
                      })),
                    },
                    blockedBy: { nodes: issue.blockedBy },
                    ...Object.fromEntries(
                      connections.map(([, alias, types, last]) => [
                        alias,
                        timelineItems(
                          issue,
                          types.split(/,\s*/),
                          Number(last),
                          local,
                        ),
                      ]),
                    ),
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
        if (args[index] === "--add-label") {
          issue.labels.push(args[index + 1]);
          issue.timeline.push({
            event: "labeled",
            label: args[index + 1],
            actor: "factory[bot]",
            at: "2026-10-09T12:00:00Z",
          });
        } else if (args[index] === "--remove-label")
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

  return { gh, find, refused, calls, labels };
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

// Waits, on real time, for what file I/O finishes, such as a run's cleanup.
async function until(condition: () => boolean) {
  for (let wait = 0; wait < 500 && !condition(); wait++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition(), "the condition held within 5 seconds");
}

// The raw log Sandcastle writes for a launch.
function rawLog(options: RunOptions): string {
  assert.equal(options.logging?.type, "file");
  return (options.logging as { path: string }).path;
}

function host(
  t: TestContext,
  {
    repositories,
    remotes,
    tokens = {},
    roles = { owner: "admin" },
    configuration = {},
    caps = { "claude-code": 2, codex: 1 },
    imageFailures = [],
    usage = {},
  }: {
    repositories: Record<string, IssueSpec[]>;
    remotes: Record<string, string>;
    tokens?: Record<string, string | Error>;
    roles?: Record<string, string | Error>;
    configuration?: Partial<HostConfiguration>;
    caps?: { "claude-code": number; codex: number };
    imageFailures?: Error[];
    // Each provider's usage as the next read finds it: absent or null has no
    // usage window, and an error is thrown.
    usage?: Record<string, number | null | Error>;
  },
) {
  const root = directory(t);
  const claudeToken = join(root, "claude-token");
  const codexLogin = join(root, "codex-auth.json");
  writeFileSync(claudeToken, "claude-secret\n");
  writeFileSync(codexLogin, "{}\n");
  // What the token command prints next for each repository.
  const tokenOf: Record<string, string | Error> = Object.fromEntries(
    Object.keys(repositories).map((name) => [
      name,
      tokens[name] ?? `ghs_${name.replace("/", "_")}`,
    ]),
  );
  const github = fakeGitHub(repositories, tokenOf, roles);
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
  const tokenCommands: string[] = [];
  const clock = { now: new Date("2026-10-09T12:00:00Z") };
  // Sandbox removals and issue edits, in order.
  const events: string[] = [];
  const starts: (() => void)[] = [];
  const usageReads: string[] = [];
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
      tokenCommands.push(repository);
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
    async readUsage(provider) {
      usageReads.push(provider);
      const answer = usage[provider];
      if (answer instanceof Error) throw answer;
      return answer ?? null;
    },
    async launch(provider, request) {
      // No provider starts until the real pass has returned.
      await new Promise<void>((resolve) => starts.push(resolve));
      return registry.providers.get(provider)!.launch(request);
    },
    // The sandboxes are the launches whose agents have not finished; a
    // removed one never finishes.
    stopSandboxes() {
      events.push("stop sandboxes");
      for (const launch of launched) launch.removed = true;
    },
    now: () => clock.now,
    report: (line) => reports.push(line),
  };
  function process() {
    const instance = createHost(resolved, registry, ports);
    return {
      ...instance,
      async tick() {
        const decisions = await instance.tick();
        // The production pass returns before Sandcastle records a launch.
        // Fixtures wait here for every launch it requested, including retries
        // and relaunches, without waiting for the agents to finish.
        const pending = starts.splice(0);
        const count = launched.length + pending.length;
        for (const start of pending) start();
        await until(() => launched.length === count);
        return decisions;
      },
    };
  }
  const instance = process();
  const state = resolved.stateDirectory;
  return {
    ...instance,
    // A new process on the same host, state directory and GitHub.
    restart: process,
    events,
    github,
    launched,
    builds,
    reports,
    tokens: tokenOf,
    tokenCommands,
    clock,
    usage,
    usageReads,
    state,
    clone: (name: string) => join(state, "repositories", name, "clone"),
    status: () => JSON.parse(readFileSync(join(state, "status.json"), "utf8")),
  };
}

const conventions = {
  version: 1,
  labels: {
    ready: "ready-for-agent",
    running: "factory:running",
    failed: "factory:failed",
    needsInput: "factory:needs-input",
    paused: "factory:paused",
  },
  modelLabelPrefix: "model:",
  prompt: "{skillPrefix}implement #{issue}",
};
const factoryFiles = {
  ".factory/config.json": JSON.stringify(conventions),
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
    run.launched
      .map(({ options, docker }) => ({
        name: options.name,
        cwd: options.cwd,
        agent: options.agent.name,
        prompt: options.prompt,
        branch: options.branchStrategy,
        // Sandcastle writes the raw log into the run's private directory.
        log: rawLog(options).replace(/-\w{6}\/agent\.log$/, "-*/agent.log"),
        image: docker.imageName,
      }))
      // The adapters' credential reads can finish in either order.
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    [
      {
        name: "acme/gadgets#3",
        cwd: run.clone("acme/gadgets"),
        agent: "codex",
        prompt: "$implement #3",
        branch: { type: "branch", branch: "factory/issue-3" },
        log: join(
          run.state,
          "repositories/acme/gadgets/sandboxes/issue-3-*/agent.log",
        ),
        image: "factory-sandbox:2",
      },
      {
        name: "acme/widgets#4",
        cwd: run.clone("acme/widgets"),
        agent: "claude-code",
        prompt: "/implement #4",
        branch: { type: "branch", branch: "factory/issue-4" },
        log: join(
          run.state,
          "repositories/acme/widgets/sandboxes/issue-4-*/agent.log",
        ),
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

test("a failed launch record leaves no sandbox or cap slot and its orphaned claim retries next pass", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
    configuration: {
      models: { default: "claude-sonnet-5-5", retry: "claude-sonnet-5-5" },
    },
    caps: { "claude-code": 1, codex: 1 },
  });
  const paths = join(run.state, "repositories/acme/widgets");
  const blocked = join(paths, "runs/issue-4-attempt-1.json.partial");
  mkdirSync(blocked, { recursive: true });

  await run.tick();
  assert.equal(run.launched.length, 0);
  assert.ok(
    run.reports.some((line) =>
      line.includes(
        "acme/widgets#4 launch failed, so acme/widgets waits for the next pass",
      ),
    ),
  );
  assert.deepEqual(readdirSync(join(paths, "sandboxes")), []);
  assert.deepEqual(run.github.find("acme/widgets", 4).labels, [
    "ready-for-agent",
    "factory:running",
  ]);

  rmSync(blocked, { recursive: true });
  const decisions = await run.tick();
  assert.deepEqual(decisions, [
    {
      kind: "launch",
      repository: "acme/widgets",
      issue: 4,
      provider: "claude-code",
      model: "claude-sonnet-5-5",
      effort: "high",
      attempt: 2,
      retry: {
        failure: "no factory run or open pull request holds its claim",
        log: "",
      },
    },
  ]);
  assert.equal(run.launched.length, 1);
  assert.deepEqual(run.github.find("acme/widgets", 4).comments, []);
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
  await until(() => !existsSync(github.hostPath));
  assert.equal(existsSync(github.hostPath), false);
});

test("a repository's token is reused, refreshed before it expires, and rewritten into its running sandbox", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }], "acme/gadgets": [] },
    remotes: {
      "acme/widgets": remote(t, factoryFiles),
      "acme/gadgets": remote(t, factoryFiles),
    },
  });
  await run.tick();
  assert.deepEqual(run.tokenCommands, ["acme/widgets", "acme/gadgets"]);
  const github = run.launched[0].docker.mounts!.find(
    (mount) => mount.sandboxPath === "/run/factory/github",
  )!;
  const hosts = () => readFileSync(join(github.hostPath, "hosts.yml"), "utf8");
  run.clock.now = new Date("2026-10-09T12:29:59Z");
  await run.refreshTokens();
  await run.tick();
  assert.equal(run.tokenCommands.length, 2, "the cached tokens are reused");
  run.tokens["acme/widgets"] = "ghs_widgets_refreshed";
  run.tokens["acme/gadgets"] = "ghs_gadgets_refreshed";
  run.clock.now = new Date("2026-10-09T12:30:00Z");
  await run.refreshTokens();
  assert.deepEqual(
    run.tokenCommands.slice(2),
    ["acme/widgets"],
    "between passes only a repository with a running sandbox refreshes",
  );
  assert.match(hosts(), /oauth_token: "ghs_widgets_refreshed"/);
  assert.doesNotMatch(hosts(), /ghs_acme_widgets/);
  // GitHub accepts only the refreshed tokens.
  await run.tick();
  assert.deepEqual(run.tokenCommands.slice(3), ["acme/gadgets"]);
  assert.equal(run.status().repositories[1].state, "running");
});

test("a token command that fails at refresh holds only its repository", async (t) => {
  const run = host(t, {
    repositories: {
      "acme/widgets": [{ number: 4 }],
      "acme/gadgets": [
        { number: 5, blockedBy: [{ number: 9, state: "OPEN" }] },
      ],
    },
    remotes: {
      "acme/widgets": remote(t, factoryFiles),
      "acme/gadgets": remote(t, factoryFiles),
    },
  });
  await run.tick();
  const github = run.launched[0].docker.mounts!.find(
    (mount) => mount.sandboxPath === "/run/factory/github",
  )!;
  const failure = "the token command for acme/widgets failed with 1";
  run.tokens["acme/widgets"] = new Error(failure);
  run.tokens["acme/gadgets"] = "ghs_gadgets_refreshed";
  run.clock.now = new Date("2026-10-09T12:30:00Z");
  await run.refreshTokens();
  assert.ok(
    run.reports.includes(
      `acme/widgets's token was not refreshed: Error: ${failure}`,
    ),
    run.reports.join("\n"),
  );
  // The sandbox keeps its token, which is still valid, until a refresh works.
  assert.match(
    readFileSync(join(github.hostPath, "hosts.yml"), "utf8"),
    /oauth_token: "ghs_acme_widgets"/,
  );
  run.github.find("acme/gadgets", 5).blockedBy = [];
  await run.tick();
  assert.deepEqual(run.status().repositories, [
    {
      repository: "acme/widgets",
      state: "paused",
      reason: failure,
      held: [],
    },
    { repository: "acme/gadgets", state: "running", held: [] },
  ]);
  assert.ok(
    run.reports.includes(`acme/widgets is paused: ${failure}`),
    run.reports.join("\n"),
  );
  assert.deepEqual(
    run.launched.map(({ options }) => options.name),
    ["acme/widgets#4", "acme/gadgets#5"],
  );
});

test("every printed token and delivered credential is redacted from the run log, the process log and the status file", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  await run.tick();
  const [launch] = run.launched;
  const raw = rawLog(launch.options);
  const published = join(
    run.state,
    "repositories/acme/widgets/logs/issue-4-attempt-1.log",
  );
  run.tokens["acme/widgets"] = "ghs_second";
  run.clock.now = new Date("2026-10-09T12:30:00Z");
  await run.refreshTokens();
  appendFileSync(raw, "gh auth token: ghs_acme_widgets\n");
  // Complete lines reach the published log while the agent runs.
  await until(
    () => existsSync(published) && readFileSync(published, "utf8") !== "",
  );
  assert.equal(readFileSync(published, "utf8"), "gh auth token: <REDACTED>\n");
  appendFileSync(raw, "now ghs_second with claude-secret\nlast ghs_second");
  launch.finish(new Error("push failed for ghs_acme_widgets"));
  await settled();
  run.tokens["acme/widgets"] = new Error("ghs_second was revoked");
  run.clock.now = new Date("2026-10-09T13:00:00Z");
  await run.tick();
  // The raw log goes with the run, once its end is published.
  await until(() => !existsSync(dirname(raw)));
  assert.equal(
    readFileSync(published, "utf8"),
    [
      "gh auth token: <REDACTED>",
      "now <REDACTED> with <REDACTED>",
      "last <REDACTED>",
    ].join("\n"),
  );
  assert.ok(
    run.reports.includes(
      "run for acme/widgets#4 ended with an error: Error: push failed for <REDACTED>",
    ),
    run.reports.join("\n"),
  );
  assert.ok(
    run.reports.includes("acme/widgets is paused: <REDACTED> was revoked"),
    run.reports.join("\n"),
  );
  assert.equal(run.status().repositories[0].reason, "<REDACTED> was revoked");
  const written = [
    ...run.reports,
    readFileSync(join(run.state, "status.json"), "utf8"),
    readFileSync(
      join(run.state, "repositories/acme/widgets/runs/issue-4-attempt-1.json"),
      "utf8",
    ),
  ].join("\n");
  for (const secret of ["ghs_acme_widgets", "ghs_second", "claude-secret"])
    assert.equal(written.includes(secret), false, secret);
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
      "acme/gadgets": remote(t, {
        ".factory/config.json": JSON.stringify(conventions),
        "README.md": "no factory\n",
      }),
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
  const log = rawLog(run.launched[0].options);
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

for (const timedOut of [false, true])
  test(`a run whose pull request is open keeps its claim and frees its cap slot, timed out: ${timedOut}`, async (t) => {
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
    if (timedOut) run.clock.now = new Date("2026-10-09T16:00:00Z");
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
  "diverged local workflow",
  "diverged pushed workflow",
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
    if (scenario === "diverged local workflow") {
      const local = git(work, ["rev-parse", "HEAD"]).trim();
      git(work, ["reset", "--quiet", "--hard", "HEAD^"]);
      commit({ "remote.md": "remote change\n" }, "remote divergence");
      push();
      git(work, ["reset", "--quiet", "--hard", local]);
    }
    if (scenario === "diverged pushed workflow") {
      push();
      const shared = git(work, ["rev-parse", "HEAD"]).trim();
      commit({ "remote.md": "remote change\n" }, "remote divergence");
      push();
      git(work, ["reset", "--quiet", "--hard", shared]);
      commit({ "README.md": "local change\n" }, "local divergence");
    }
    if (scenario.startsWith("diverged")) {
      assert.equal(
        git(work, [
          "rev-list",
          "--left-right",
          "--count",
          "HEAD...origin/factory/issue-4",
        ]).trim(),
        "1\t1",
      );
    }
    run.launched[0].finish();
    await settled();
    const decisions = await run.tick();
    const failing = [
      "absent",
      "behind",
      "diverged local workflow",
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

test("the configured template and state labels drive first attempts, retries and failures", async (t) => {
  const configuration = {
    version: 1,
    labels: {
      ready: "queued",
      running: "working",
      failed: "broken",
      needsInput: "question",
      paused: "waiting",
    },
    modelLabelPrefix: "agent:",
    prompt: "Handle #{issue} using {skillPrefix}ship; issue={issue}",
  };
  const run = host(t, {
    repositories: {
      "acme/widgets": [{ number: 4, labels: ["queued", "agent:gpt-5.5"] }],
    },
    remotes: {
      "acme/widgets": remote(t, {
        ...factoryFiles,
        ".factory/config.json": JSON.stringify(configuration),
      }),
    },
    configuration: {
      models: { default: "claude-sonnet-5-5", retry: "claude-opus-5-5" },
    },
  });
  await run.tick();
  assert.equal(
    run.launched[0].options.prompt,
    "Handle #4 using $ship; issue=4",
  );
  assert.deepEqual(
    run.github.labels.get("acme/widgets"),
    new Set(["working", "broken", "question", "waiting"]),
  );
  assert.deepEqual(run.github.find("acme/widgets", 4).labels, [
    "queued",
    "agent:gpt-5.5",
    "working",
  ]);
  const log = (run.launched[0].options.logging as { path: string }).path;
  writeFileSync(log, "failure details\n");
  run.launched[0].finish();
  await settled();
  await run.tick();
  assert.equal(
    run.launched[1].options.prompt,
    [
      "Handle #4 using /ship; issue=4",
      "First attempt failure: the run ended without an open pull request",
      "First attempt log tail:\nfailure details\n",
    ].join("\n\n"),
  );
  run.launched[1].finish();
  await settled();
  await run.tick();
  assert.deepEqual(run.github.find("acme/widgets", 4).labels, [
    "queued",
    "agent:gpt-5.5",
    "broken",
  ]);
  assert.match(
    run.github.find("acme/widgets", 4).comments[0],
    /Remove `broken`/,
  );
  assert.equal(
    run.github.calls.some((args) =>
      args.some(
        (arg, index) =>
          ["--add-label", "--remove-label"].includes(arg) &&
          args[index + 1] === "queued",
      ),
    ),
    false,
  );
});

for (const fault of [
  "missing configuration",
  "invalid configuration",
  "missing Dockerfile",
])
  test(`${fault} pauses pickup while existing runs settle and other repositories continue`, async (t) => {
    const bare = remote(t, factoryFiles);
    const run = host(t, {
      repositories: {
        "acme/widgets": [{ number: 2 }, { number: 3 }],
        "acme/gadgets": [{ number: 4 }],
      },
      remotes: {
        "acme/widgets": bare,
        "acme/gadgets": remote(t, factoryFiles),
      },
      caps: { "claude-code": 1, codex: 1 },
    });
    await run.tick();
    run.github.find("acme/widgets", 2).state = "CLOSED";
    run.launched[0].finish();
    await settled();
    const work = join(dirname(bare), "work");
    if (fault === "invalid configuration")
      write(work, { ".factory/config.json": "{}" });
    else
      git(work, [
        "rm",
        "--quiet",
        fault === "missing configuration"
          ? ".factory/config.json"
          : ".factory/Dockerfile",
      ]);
    git(work, ["commit", "--quiet", "-am", "break factory input"]);
    git(work, ["push", "--quiet", bare, "main"]);
    const decisions = await run.tick();
    assert.ok(
      decisions.some(
        (decision) =>
          decision.kind === "release" &&
          decision.repository === "acme/widgets" &&
          decision.issue === 2,
      ),
    );
    assert.deepEqual(run.github.find("acme/widgets", 2).labels, [
      "ready-for-agent",
    ]);
    assert.deepEqual(run.github.find("acme/widgets", 3).labels, [
      "ready-for-agent",
    ]);
    assert.deepEqual(
      run.launched.map(({ options }) => options.name),
      ["acme/widgets#2", "acme/gadgets#4"],
    );
    const status = run.status().repositories[0];
    assert.equal(status.state, "paused");
    assert.match(
      status.reason,
      fault === "missing Dockerfile"
        ? /no .factory\/Dockerfile/
        : /factory configuration.*(?:unreadable|invalid)/,
    );
    assert.ok(
      run.reports.some((line) =>
        line.includes(`acme/widgets is paused: ${status.reason}`),
      ),
    );
    assert.ok(status.held.some((held: { issue: number }) => held.issue === 3));
    // Restoring the default branch resumes pickup on the next pass.
    git(work, ["revert", "--no-edit", "HEAD"]);
    git(work, ["push", "--quiet", bare, "main"]);
    run.github.find("acme/gadgets", 4).state = "CLOSED";
    run.launched[1].finish();
    await settled();
    await run.tick();
    assert.equal(run.status().repositories[0].state, "running");
    assert.equal(run.launched[2].options.name, "acme/widgets#3");
  });

test("a repository without configuration at startup pauses without guessing conventions", async (t) => {
  const run = host(t, {
    repositories: {
      "acme/widgets": [{ number: 4 }],
      "acme/gadgets": [{ number: 3 }],
    },
    remotes: {
      "acme/widgets": remote(t, { ".factory/Dockerfile": toolchain }),
      "acme/gadgets": remote(t, factoryFiles),
    },
  });
  await run.tick();
  assert.equal(run.status().repositories[0].state, "paused");
  assert.match(
    run.status().repositories[0].reason,
    /factory configuration.*unreadable/,
  );
  assert.equal(run.github.labels.has("acme/widgets"), false);
  assert.deepEqual(run.github.find("acme/widgets", 4).labels, [
    "ready-for-agent",
  ]);
  assert.deepEqual(
    run.launched.map(({ options }) => options.name),
    ["acme/gadgets#3"],
  );
});

test("prompt edits on the default branch apply on the next pass, ignoring run branches", async (t) => {
  const bare = remote(t, factoryFiles);
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": bare },
  });
  await run.tick();
  const work = join(dirname(bare), "work");
  write(work, {
    ".factory/config.json": JSON.stringify({
      ...conventions,
      prompt: "{skillPrefix}ship #{issue}",
    }),
  });
  git(work, ["commit", "--quiet", "-am", "new prompt"]);
  git(work, ["push", "--quiet", bare, "main"]);
  git(work, ["checkout", "--quiet", "-b", "factory/issue-4"]);
  write(work, { ".factory/config.json": "{}" });
  git(work, ["commit", "--quiet", "-am", "invalid run branch config"]);
  git(work, ["push", "--quiet", bare, "factory/issue-4"]);
  run.launched[0].finish();
  await settled();
  await run.tick();
  assert.equal(
    run.launched[1].options.prompt,
    "$ship #4\n\nFirst attempt failure: the run ended without an open pull request",
  );
});

test("configuration follows a changed remote default branch on the next pass", async (t) => {
  const bare = remote(t, factoryFiles);
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": bare },
  });
  await run.tick();
  const work = join(dirname(bare), "work");
  git(work, ["checkout", "--quiet", "-b", "next"]);
  write(work, {
    ".factory/config.json": JSON.stringify({
      ...conventions,
      prompt: "{skillPrefix}ship #{issue}",
    }),
  });
  git(work, ["commit", "--quiet", "-am", "new default configuration"]);
  git(work, ["push", "--quiet", bare, "next"]);
  git(bare, ["symbolic-ref", "HEAD", "refs/heads/next"]);
  run.launched[0].finish();
  await settled();
  await run.tick();
  assert.equal(
    run.launched[1].options.prompt,
    "$ship #4\n\nFirst attempt failure: the run ended without an open pull request",
  );
});

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
  // The raw log goes with the run's private directory.
  assert.equal(existsSync(dirname(rawLog(launch.options))), false);
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
  writeFileSync(rawLog(run.launched[0].options), "first attempt\n");
  const firstLog = join(
    run.state,
    "repositories/acme/widgets/logs/issue-4-attempt-1.log",
  );
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
  assert.deepEqual(run.github.find("acme/widgets", 4).labels, [
    "ready-for-agent",
    "factory:running",
  ]);
  assert.equal(recordOf(run.state, 4, 1).settled, true);
  const record = recordOf(run.state, 4, 2);
  assert.equal(record.attempt, 2);
  assert.equal(record.interrupted, false);
  // The relaunch publishes to its attempt's log.
  assert.equal(
    record.log,
    join(run.state, "repositories/acme/widgets/logs/issue-4-attempt-2.log"),
  );

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

test("recovered runs retain configured state labels while invalid configuration pauses relaunch", async (t) => {
  const configuration = {
    ...conventions,
    labels: {
      ready: "queued",
      running: "working",
      failed: "broken",
      needsInput: "question",
      paused: "waiting",
    },
  };
  const bare = remote(t, {
    ...factoryFiles,
    ".factory/config.json": JSON.stringify(configuration),
  });
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4, labels: ["queued"] }] },
    remotes: { "acme/widgets": bare },
  });
  await run.tick();
  run.interrupt();
  const work = join(dirname(bare), "work");
  write(work, { ".factory/config.json": "{}" });
  git(work, ["commit", "--quiet", "-am", "invalid configuration"]);
  git(work, ["push", "--quiet", bare, "main"]);
  const restarted = run.restart();
  const decisions = await restarted.tick();
  assert.equal(decisions[0]?.kind, "skip");
  assert.equal(run.status().repositories[0].state, "paused");
  assert.equal(run.launched.length, 1);
  run.github.find("acme/widgets", 4).labels.push("question");
  await restarted.tick();
  assert.deepEqual(run.github.find("acme/widgets", 4).labels, [
    "queued",
    "question",
  ]);
  assert.equal(run.launched.length, 1);
});

// Readiness the adapter reads from timeline fixtures.
const ready = "ready-for-agent";
const reviewed = "2026-10-09T10:00:00Z";

function labelled(actor: string | null, at = reviewed): TimelineEvent {
  return { event: "labeled", label: ready, actor, at };
}

function held(run: ReturnType<typeof host>, issue: number) {
  return run
    .status()
    .repositories[0].held.find(
      (entry: { issue: number }) => entry.issue === issue,
    )?.reason;
}

test("readiness counts only from a user whose role, read once a pass, the host authorizes", async (t) => {
  const roles: Record<string, string | Error> = {
    owner: "admin",
    casey: "write",
    morgan: new Error("HTTP 502"),
  };
  const run = host(t, {
    repositories: {
      "acme/widgets": [
        { number: 1 },
        { number: 2, timeline: [labelled("casey")] },
        { number: 3, timeline: [labelled("release-bot[bot]")] },
        { number: 4, timeline: [labelled(null)] },
        { number: 5, timeline: [labelled("morgan")] },
        { number: 6 },
      ],
    },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
    roles,
    caps: { "claude-code": 3, codex: 1 },
  });
  const lookups = () =>
    run.github.calls
      .filter((args) => args[0] === "api" && args[1].startsWith("repos/"))
      .map((args) => args[1]);
  await run.tick();
  assert.deepEqual(
    // The two Claude Code token reads can finish in either order.
    run.launched.map(({ options }) => options.name).sort(),
    ["acme/widgets#1", "acme/widgets#6"],
  );
  const authorized =
    "a person with the admin role must remove and re-apply ready-for-agent";
  assert.equal(
    held(run, 2),
    `its readiness is refused: ready-for-agent was applied by @casey, whose repository role write is not authorized; ${authorized}`,
  );
  assert.equal(
    held(run, 3),
    `its readiness is refused: ready-for-agent was applied by release-bot, a bot or app, which never authorizes; ${authorized}`,
  );
  assert.equal(
    held(run, 4),
    `its readiness is refused: ready-for-agent was applied by an account that is not a user, which never authorizes; ${authorized}`,
  );
  assert.equal(
    held(run, 5),
    "its readiness waits: the repository role of @morgan, who applied ready-for-agent, could not be read this pass",
  );
  assert.deepEqual(lookups(), [
    "repos/acme/widgets/collaborators/owner/permission",
    "repos/acme/widgets/collaborators/casey/permission",
    "repos/acme/widgets/collaborators/morgan/permission",
  ]);
  // Refused readiness writes nothing to GitHub.
  assert.deepEqual(run.events, [
    "stop sandboxes",
    "edit acme/widgets#1 --add-label factory:running",
    "edit acme/widgets#6 --add-label factory:running",
  ]);
  for (const number of [2, 3, 4, 5])
    assert.deepEqual(
      [
        run.github.find("acme/widgets", number).labels,
        run.github.find("acme/widgets", number).comments,
      ],
      [[ready], []],
    );
  // The next pass reads every role again, so a lookup that failed and a role
  // that changed both count from then on.
  roles.morgan = "admin";
  roles.casey = "admin";
  await run.tick();
  assert.deepEqual(
    run.launched.slice(2).map(({ options }) => options.name),
    ["acme/widgets#2"],
  );
  assert.match(held(run, 5)!, /^claude-code already runs its cap of 3/);
  assert.equal(lookups().length, 6);
});

test("readiness must be newer than the body's last edit, whatever the title and comments did", async (t) => {
  const later = "2026-10-09T10:00:01Z";
  const run = host(t, {
    repositories: {
      "acme/widgets": [
        { number: 1, timeline: [{ event: "edited", at: reviewed }] },
        {
          number: 2,
          timeline: [
            { event: "edited", at: reviewed },
            labelled("owner", reviewed),
          ],
        },
        {
          number: 3,
          timeline: [
            { event: "edited", at: reviewed },
            labelled("owner", later),
            { event: "renamed", at: "2026-10-09T11:00:00Z" },
            { event: "commented", at: "2026-10-09T11:00:00Z" },
          ],
        },
      ],
    },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  await run.tick();
  assert.deepEqual(
    run.launched.map(({ options }) => options.name),
    ["acme/widgets#3"],
  );
  assert.equal(
    held(run, 1),
    `its readiness is refused: ready-for-agent was applied at 2026-10-01T00:00:00Z, not after the body's last edit at ${reviewed}; review the edit, then remove and re-apply ready-for-agent`,
  );
  assert.equal(
    held(run, 2),
    `its readiness is refused: ready-for-agent was applied at ${reviewed}, not after the body's last edit at ${reviewed}; review the edit, then remove and re-apply ready-for-agent`,
  );
});

test("a parent's readiness releases its tickets and closes it only when it counts and follows its latest link", async (t) => {
  const linked = (subIssue: number): TimelineEvent => ({
    event: "linked",
    subIssue,
    at: reviewed,
  });
  const run = host(t, {
    repositories: {
      "acme/widgets": [
        // Readiness in the same second as the latest link holds the ticket.
        {
          number: 1,
          subIssues: [{ number: 2 }],
          timeline: [linked(2), labelled("owner", reviewed)],
        },
        { number: 2, parent: 1 },
        {
          number: 3,
          subIssues: [{ number: 4 }],
          timeline: [linked(4), labelled("owner", "2026-10-09T10:00:01Z")],
        },
        { number: 4, parent: 3 },
        // A finished parent whose readiness is refused stays open.
        {
          number: 5,
          subIssues: [{ number: 9, state: "CLOSED" }],
          timeline: [labelled("casey")],
        },
        { number: 6, subIssues: [{ number: 8, state: "CLOSED" }] },
      ],
    },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
    roles: { owner: "admin", casey: "triage" },
  });
  await run.tick();
  assert.deepEqual(
    run.launched.map(({ options }) => options.name),
    ["acme/widgets#4"],
  );
  assert.equal(
    held(run, 2),
    "sub-issue of #1, whose readiness predates its latest ticket #2; remove and re-apply ready-for-agent on #1 once its tickets are published",
  );
  assert.equal(
    held(run, 5),
    "its readiness is refused: ready-for-agent was applied by @casey, whose repository role triage is not authorized; a person with the admin role must remove and re-apply ready-for-agent",
  );
  assert.equal(run.github.find("acme/widgets", 5).state, "OPEN");
  assert.deepEqual(run.github.find("acme/widgets", 5).comments, []);
  assert.equal(run.github.find("acme/widgets", 6).state, "CLOSED");
});

test("a timed-out run fails at once when its branch has unpushable commits", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  await run.tick();
  const clone = run.clone("acme/widgets");
  const work = join(clone, ".sandcastle/worktrees/factory-issue-4");
  git(clone, ["worktree", "add", "--quiet", "-b", "factory/issue-4", work]);
  write(work, { ".github/workflows/new.yml": "changed\n" });
  git(work, ["add", "."]);
  git(work, ["commit", "--quiet", "-m", "workflow change"]);
  run.clock.now = new Date("2026-10-09T16:00:00Z");
  run.launched[0].finish();
  await settled();
  const [decision] = await run.tick();
  assert.equal(decision.kind, "fail");
  assert.match(
    run.github.find("acme/widgets", 4).comments[0],
    /Unpushable: `.github\/workflows\/new.yml`/,
  );
  assert.equal(run.launched.length, 1);
});

test("a second attempt awaiting merge cannot retry after its pull request closes, even across restart", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  await run.tick();
  run.launched[0].finish();
  await settled();
  await run.tick();
  const issue = run.github.find("acme/widgets", 4);
  issue.pullRequests.push("OPEN");
  run.launched[1].finish();
  await settled();
  await run.tick();
  issue.pullRequests = ["CLOSED"];
  const restarted = run.restart();
  const [decision] = await restarted.tick();
  assert.equal(decision.kind, "fail");
  assert.equal(run.launched.length, 2);
  assert.match(issue.comments[0], /attempt 2/);
});

for (const ended of ["timed out", "orphaned"] as const)
  test(`needs input on a ${ended} second attempt releases and later starts attempt 1 on the existing branch`, async (t) => {
    const run = host(t, {
      repositories: { "acme/widgets": [{ number: 4 }] },
      remotes: { "acme/widgets": remote(t, factoryFiles) },
    });
    await run.tick();
    const clone = run.clone("acme/widgets");
    const work = join(clone, ".sandcastle/worktrees/factory-issue-4");
    git(clone, ["worktree", "add", "--quiet", "-b", "factory/issue-4", work]);
    write(work, { "README.md": "work to continue\n" });
    git(work, ["commit", "--quiet", "-am", "existing work"]);
    const head = git(work, ["rev-parse", "HEAD"]).trim();
    run.launched[0].finish();
    await settled();
    await run.tick();
    const issue = run.github.find("acme/widgets", 4);
    issue.labels.push("factory:needs-input");
    let active: Pick<ReturnType<typeof createHost>, "tick"> = run;
    if (ended === "timed out") {
      run.clock.now = new Date("2026-10-09T16:00:00Z");
      run.launched[1].finish();
      await settled();
    } else active = run.restart();
    const [decision] = await active.tick();
    assert.deepEqual(decision, {
      kind: "release",
      repository: "acme/widgets",
      issue: 4,
    });
    assert.deepEqual(issue.labels, ["ready-for-agent", "factory:needs-input"]);
    assert.deepEqual(issue.comments, []);
    issue.labels = ["ready-for-agent"];
    const decisions = await active.tick();
    const launch = decisions.find((decision) => decision.kind === "launch");
    assert.equal(launch?.attempt, 1);
    assert.equal(run.launched.length, 3);
    assert.equal(run.launched[2].options.prompt, "/implement #4");
    assert.deepEqual(run.launched[2].options.branchStrategy, {
      type: "branch",
      branch: "factory/issue-4",
    });
    assert.equal(git(work, ["rev-parse", "HEAD"]).trim(), head);
    assert.equal(recordOf(run.state, 4, 1).attempt, 1);
  });

test("an orphaned second attempt with no interrupted record fails after startup stops its sandbox", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  await run.tick();
  run.launched[0].finish();
  await settled();
  await run.tick();
  const restarted = run.restart();
  const [decision] = await restarted.tick();
  assert.equal(decision.kind, "fail");
  assert.equal(run.launched.length, 2);
  assert.equal(run.launched[1].removed, true);
  assert.match(run.github.find("acme/widgets", 4).comments[0], /attempt 2/);
  assert.equal(recordOf(run.state, 4, 2).settled, true);
});

test("a claim with no run record observes its branch and fails unpushable commits without retry", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4, labels: [] }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  await run.tick();
  const clone = run.clone("acme/widgets");
  const work = join(clone, ".sandcastle/worktrees/factory-issue-4");
  git(clone, ["worktree", "add", "--quiet", "-b", "factory/issue-4", work]);
  write(work, { ".github/workflows/new.yml": "changed\n" });
  git(work, ["add", "."]);
  git(work, ["commit", "--quiet", "-m", "unpushable work"]);
  run.github.find("acme/widgets", 4).labels = [
    "ready-for-agent",
    "factory:running",
  ];
  // The next process has no factory-owned run record for this claim.
  const [decision] = await run.restart().tick();
  assert.equal(decision.kind, "fail");
  assert.equal(run.launched.length, 0);
  assert.match(
    run.github.find("acme/widgets", 4).comments[0],
    /Unpushable: `.github\/workflows\/new.yml`/,
  );
});

test("claim settling reads pull requests separately from issue closure and gives merged work precedence over needs input", async (t) => {
  const run = host(t, {
    repositories: {
      "acme/widgets": [
        {
          number: 4,
          state: "CLOSED",
          labels: ["factory:running"],
          pullRequests: ["OPEN"],
        },
        {
          number: 5,
          state: "CLOSED",
          labels: ["factory:running"],
          pullRequests: [],
        },
        {
          number: 6,
          labels: ["factory:running", "factory:needs-input"],
          pullRequests: ["MERGED"],
        },
      ],
    },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  assert.deepEqual(await run.tick(), [
    { kind: "keep", repository: "acme/widgets", issue: 4 },
    { kind: "release", repository: "acme/widgets", issue: 5 },
    {
      kind: "fail",
      repository: "acme/widgets",
      issue: 6,
      failure:
        "its pull request merged without closing the issue; close the issue if that finished it",
      log: null,
    },
  ]);
  assert.deepEqual(run.github.find("acme/widgets", 4).labels, [
    "factory:running",
  ]);
  assert.deepEqual(run.github.find("acme/widgets", 5).labels, []);
  assert.deepEqual(run.github.find("acme/widgets", 6).labels, [
    "factory:needs-input",
    "factory:failed",
  ]);
  assert.equal(run.launched.length, 0);
});

test("an orphaned claim waits for a failed role lookup without a failure comment or losing its retry", async (t) => {
  const roles: Record<string, string | Error> = {
    owner: new Error("HTTP 502"),
  };
  const run = host(t, {
    repositories: {
      "acme/widgets": [
        { number: 4, labels: ["ready-for-agent", "factory:running"] },
      ],
    },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
    roles,
  });
  const decisions = await run.tick();
  assert.equal(
    decisions.some(({ kind }) => kind === "fail"),
    false,
  );
  assert.deepEqual(run.github.find("acme/widgets", 4).comments, []);
  assert.deepEqual(run.github.find("acme/widgets", 4).labels, [
    "ready-for-agent",
    "factory:running",
  ]);
  assert.equal(run.launched.length, 0);
  roles.owner = "admin";
  const launch = (await run.tick()).find(
    (decision) => decision.kind === "launch",
  );
  assert.equal(launch?.attempt, 2);
  assert.equal(run.launched.length, 1);
});

// Claude Code's session limit as the raw log ends with it.
const sessionLimit = "You've hit your session limit · resets 12:50pm (UTC)";

function endOnLimit(launch: { options: RunOptions }) {
  appendFileSync(
    rawLog(launch.options),
    [
      "Working on the issue.",
      sessionLimit,
      "Agent invocation failed: claude-code exited with code 1:",
      sessionLimit,
      "",
    ].join("\n"),
  );
}

const pauseComment = [
  "The factory paused this run: claude-code usage limit, resets 12:50pm (UTC).",
  "",
  "- Model: `claude-code/claude-sonnet-5-5@high`, attempt 1",
  "",
  "The factory resumes the run by itself and removes `factory:paused` when it does; nobody needs to act.",
].join("\n");

for (const ended of [
  "without a pull request",
  "with an open pull request",
  "at the time limit",
])
  test(`a run that ends on its provider's usage limit ${ended} pauses once and resumes as the same attempt below the threshold`, async (t) => {
    const run = host(t, {
      repositories: { "acme/widgets": [{ number: 4 }] },
      remotes: { "acme/widgets": remote(t, factoryFiles) },
    });
    await run.tick();
    assert.deepEqual(
      run.github.labels.get("acme/widgets"),
      new Set([
        "factory:running",
        "factory:failed",
        "factory:needs-input",
        "factory:paused",
      ]),
    );
    const [first] = run.launched;
    const issue = run.github.find("acme/widgets", 4);
    // The pause is the agent's exit, and its deadline that day's 12:50pm, or
    // the next day's once the time limit stopped it at 16:01.
    const timing =
      ended === "at the time limit"
        ? { at: "2026-10-09T16:01:00.000Z", until: "2026-10-10T12:50:00.000Z" }
        : { at: "2026-10-09T12:00:00.000Z", until: "2026-10-09T12:50:00.000Z" };
    const pause = { cause: "usage limit", reset: "12:50pm (UTC)", ...timing };
    endOnLimit(first);
    if (ended === "with an open pull request") issue.pullRequests.push("OPEN");
    if (ended === "at the time limit") {
      run.clock.now = new Date("2026-10-09T16:01:00Z");
      assert.equal((await run.tick())[0].kind, "stop");
    } else first.finish(new Error("claude-code exited with code 1"));
    await settled();
    await until(() => recordOf(run.state, 4, 1).exited);

    assert.deepEqual(
      (await run.tick()).filter(({ kind }) => kind !== "skip"),
      [{ kind: "pause", repository: "acme/widgets", issue: 4, pause }],
    );
    assert.deepEqual(issue.labels, ["ready-for-agent", "factory:paused"]);
    assert.deepEqual(issue.comments, [pauseComment]);
    assert.deepEqual(recordOf(run.state, 4, 1).ended, {
      paused: pause,
      commented: true,
    });

    // Held with the limit named while usage is unreadable or too high, and
    // told only once.
    await run.tick();
    assert.equal(
      held(run, 4),
      `relaunch waits: claude-code hit its usage limit (resets 12:50pm (UTC)); its usage is unreadable, so it waits until ${timing.until} at most`,
    );
    run.usage["claude-code"] = 100;
    await run.tick();
    assert.equal(
      held(run, 4),
      "relaunch waits: claude-code hit its usage limit (resets 12:50pm (UTC)); usage 100% is at or above the 80% threshold",
    );
    assert.ok(
      run.reports.includes(
        "acme/widgets#4 skipped: relaunch waits: claude-code hit its usage limit (resets 12:50pm (UTC)); usage 100% is at or above the 80% threshold",
      ),
    );
    assert.equal(issue.comments.length, 1);
    assert.deepEqual(issue.labels, ["ready-for-agent", "factory:paused"]);
    assert.equal(run.launched.length, 1);

    run.usage["claude-code"] = 12;
    const decisions = await run.tick();
    assert.deepEqual(
      decisions.filter(({ kind }) => kind !== "skip"),
      [
        { kind: "unpause", repository: "acme/widgets", issue: 4 },
        {
          kind: "launch",
          repository: "acme/widgets",
          issue: 4,
          provider: "claude-code",
          model: "claude-sonnet-5-5",
          effort: "high",
          attempt: 1,
          relaunch: true,
        },
      ],
    );
    assert.deepEqual(issue.labels, ["ready-for-agent", "factory:running"]);
    const resumed = run.launched[1];
    assert.equal(resumed.options.prompt, first.options.prompt);
    assert.deepEqual(
      resumed.options.branchStrategy,
      first.options.branchStrategy,
    );
    const record = recordOf(run.state, 4, 1);
    assert.equal(record.ended, null);
    assert.equal(
      record.log,
      join(run.state, "repositories/acme/widgets/logs/issue-4-attempt-1.log"),
    );
    assert.equal(issue.comments.length, 1);

    // Hitting the limit again is a new pause, told again.
    endOnLimit(resumed);
    resumed.finish(new Error("claude-code exited with code 1"));
    await settled();
    await until(() => recordOf(run.state, 4, 1).exited);
    await run.tick();
    assert.deepEqual(issue.comments, [pauseComment, pauseComment]);
    assert.deepEqual(issue.labels, ["ready-for-agent", "factory:paused"]);
    assert.equal(run.launched.length, 2);
  });

test("a paused run stays paused across a restart, untold again, and resumes under the same rule", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  await run.tick();
  run.usage["claude-code"] = 100;
  endOnLimit(run.launched[0]);
  run.launched[0].finish(new Error("claude-code exited with code 1"));
  await settled();
  await until(() => recordOf(run.state, 4, 1).exited);
  await run.tick();
  const issue = run.github.find("acme/widgets", 4);
  assert.deepEqual(issue.comments, [pauseComment]);

  const restarted = run.restart();
  assert.deepEqual(await restarted.tick(), [
    {
      kind: "skip",
      repository: "acme/widgets",
      issue: 4,
      reason:
        "relaunch waits: claude-code hit its usage limit (resets 12:50pm (UTC)); usage 100% is at or above the 80% threshold",
    },
  ]);
  assert.deepEqual(issue.comments, [pauseComment]);
  assert.deepEqual(issue.labels, ["ready-for-agent", "factory:paused"]);
  // The high reading holds it until it expires, then unknown usage holds it
  // until the reset.
  run.usage["claude-code"] = null;
  await restarted.tick();
  assert.match(held(run, 4)!, /usage 100% is at or above the 80% threshold$/);
  run.clock.now = new Date("2026-10-09T12:21:00Z");
  await restarted.tick();
  assert.match(
    held(run, 4)!,
    /its usage is unreadable, so it waits until 2026-10-09T12:50:00.000Z at most$/,
  );
  run.usage["claude-code"] = 0;
  const launch = (await restarted.tick()).find(
    (decision) => decision.kind === "launch",
  );
  assert.equal(launch?.attempt, 1);
  assert.equal(launch?.relaunch, true);
  assert.deepEqual(issue.labels, ["ready-for-agent", "factory:running"]);
  assert.equal(run.launched.length, 2);
});

test("a pause told nothing before a restart is told once after it", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  await run.tick();
  endOnLimit(run.launched[0]);
  run.launched[0].finish(new Error("claude-code exited with code 1"));
  await settled();
  await until(() => recordOf(run.state, 4, 1).exited);
  run.github.refused.add("acme/widgets#4");
  await run.tick();
  assert.equal(recordOf(run.state, 4, 1).ended.commented, false);
  run.github.refused.delete("acme/widgets#4");
  const restarted = run.restart();
  await restarted.tick();
  await restarted.tick();
  const issue = run.github.find("acme/widgets", 4);
  assert.deepEqual(issue.comments, [pauseComment]);
  assert.deepEqual(issue.labels, ["ready-for-agent", "factory:paused"]);
});

test("a paused run whose label swap fails does not launch that pass", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  await run.tick();
  endOnLimit(run.launched[0]);
  run.launched[0].finish(new Error("claude-code exited with code 1"));
  await settled();
  await until(() => recordOf(run.state, 4, 1).exited);
  await run.tick();
  run.usage["claude-code"] = 10;
  run.github.refused.add("acme/widgets#4");
  await run.tick();
  assert.equal(run.launched.length, 1);
  assert.ok(
    run.reports.some((line) =>
      line.startsWith(
        "acme/widgets#4 unpause failed, so acme/widgets waits for the next pass",
      ),
    ),
  );
  const issue = run.github.find("acme/widgets", 4);
  assert.deepEqual(issue.labels, ["ready-for-agent", "factory:paused"]);
  run.github.refused.delete("acme/widgets#4");
  await run.tick();
  assert.equal(run.launched.length, 2);
  assert.deepEqual(issue.labels, ["ready-for-agent", "factory:running"]);
});

for (const change of ["needs input", "closed"] as const)
  test(`a paused run whose issue ${change === "closed" ? "closed" : "needs input"} releases its claim and both labels`, async (t) => {
    const run = host(t, {
      repositories: { "acme/widgets": [{ number: 4 }] },
      remotes: { "acme/widgets": remote(t, factoryFiles) },
    });
    await run.tick();
    endOnLimit(run.launched[0]);
    run.launched[0].finish(new Error("claude-code exited with code 1"));
    await settled();
    await until(() => recordOf(run.state, 4, 1).exited);
    await run.tick();
    const issue = run.github.find("acme/widgets", 4);
    if (change === "closed") issue.state = "CLOSED";
    else issue.labels.push("factory:needs-input");
    const decisions = await run.tick();
    assert.deepEqual(decisions, [
      { kind: "release", repository: "acme/widgets", issue: 4 },
    ]);
    assert.deepEqual(
      issue.labels,
      change === "closed"
        ? ["ready-for-agent"]
        : ["ready-for-agent", "factory:needs-input"],
    );
    assert.equal(recordOf(run.state, 4, 1).settled, true);
    assert.deepEqual(issue.comments, [pauseComment]);
    run.usage["claude-code"] = 0;
    await run.tick();
    assert.equal(run.launched.length, 1);
  });

test("a run that ends without a recognized limit error settles through the outcome table", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  await run.tick();
  appendFileSync(
    rawLog(run.launched[0].options),
    [
      "The fixture says: You've hit your session limit · resets 12:50pm (UTC)",
      "Agent invocation failed: claude-code exited with code 1:",
      "API Error: 500",
      "",
    ].join("\n"),
  );
  run.launched[0].finish(new Error("claude-code exited with code 1"));
  await settled();
  const [decision] = await run.tick();
  assert.equal(decision.kind, "launch");
  assert.equal(decision.kind === "launch" && decision.attempt, 2);
  assert.deepEqual(run.github.find("acme/widgets", 4).labels, [
    "ready-for-agent",
    "factory:running",
  ]);
});

test("paused-labelled issues no run holds settle as orphaned claims and lose the paused label", async (t) => {
  const run = host(t, {
    repositories: {
      "acme/widgets": [
        { number: 4, labels: ["ready-for-agent", "factory:paused"] },
        {
          number: 5,
          labels: ["ready-for-agent", "factory:paused"],
          pullRequests: ["MERGED"],
        },
        { number: 6, state: "CLOSED", labels: ["factory:paused"] },
      ],
    },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  const decisions = await run.tick();
  assert.deepEqual(
    decisions.map(({ kind, issue }) => `${kind} #${issue}`),
    ["release #6", "fail #5", "unpause #4", "launch #4", "skip #5"],
  );
  assert.deepEqual(run.github.find("acme/widgets", 4).labels, [
    "ready-for-agent",
    "factory:running",
  ]);
  assert.deepEqual(run.github.find("acme/widgets", 5).labels, [
    "ready-for-agent",
    "factory:failed",
  ]);
  assert.deepEqual(run.github.find("acme/widgets", 6).labels, []);
  assert.equal(run.launched.length, 1);
  assert.match(
    run.launched[0].options.prompt ?? "",
    /First attempt failure: no factory run/,
  );
});

for (const [status, retryAfter, nextRead, retryTime] of [
  [403, undefined, "2026-10-09T13:00:00.000Z", "2026-10-09T13:00:00Z"],
  [429, undefined, "2026-10-09T12:20:00.000Z", "2026-10-09T12:20:00Z"],
  [403, "1148", "2026-10-09T12:19:08.000Z", "2026-10-09T12:20:00Z"],
  [429, "1148", "2026-10-09T12:19:08.000Z", "2026-10-09T12:20:00Z"],
] as const) {
  test(`HTTP ${status} with Retry-After ${retryAfter ?? "absent"} backs off quietly across a host restart and reports recovery`, async (t) => {
    const run = host(t, {
      repositories: { "acme/widgets": [] },
      remotes: { "acme/widgets": remote(t, factoryFiles) },
      usage: {
        "claude-code": new UsageReadError(
          `the usage endpoint answered HTTP ${status}`,
          { status, retryAfter },
        ),
        codex: 20,
      },
    });
    await run.tick();
    assert.ok(
      run.reports.some((line) =>
        line.includes(
          `usage for claude-code is unreadable: the usage endpoint answered HTTP ${status}; it is next read at ${nextRead}`,
        ),
      ),
    );
    assert.ok(!run.reports.some((line) => line.includes("claude-secret")));
    const reads = (provider: string) =>
      run.usageReads.filter((read) => read === provider).length;
    run.clock.now = new Date("2026-10-09T12:10:00Z");
    const restarted = run.restart();
    await restarted.tick();
    assert.equal(reads("claude-code"), 1);
    assert.equal(reads("codex"), 2);
    assert.equal(
      run.reports.filter((line) => line.startsWith("usage for claude-code"))
        .length,
      1,
    );
    run.clock.now = new Date(retryTime);
    run.usage["claude-code"] = 15;
    await restarted.tick();
    assert.equal(reads("claude-code"), 2);
    assert.equal(reads("codex"), 3);
    assert.equal(
      run.reports.filter((line) => line.startsWith("usage for claude-code"))
        .length,
      2,
    );
    assert.ok(
      run.reports.includes("usage for claude-code is readable again: 15% used"),
    );
  });
}

// Codex's usage-limit error as the raw log ends with it, with a reset.
function endOnCodexLimit(launch: { options: RunOptions }, reset: string) {
  const error = `You've hit your usage limit. Try again at ${reset}.`;
  appendFileSync(
    rawLog(launch.options),
    [
      "Working on the issue.",
      "Agent invocation failed: codex exited with code 1:",
      error,
      "",
    ].join("\n"),
  );
}

// Rewrites a run record as a release before pause timing would have left it.
function legacy(
  state: string,
  issue: number,
  attempt: number,
  keepExit = true,
) {
  const path = join(
    state,
    `repositories/acme/widgets/runs/issue-${issue}-attempt-${attempt}.json`,
  );
  const record = JSON.parse(readFileSync(path, "utf8"));
  const { cause, reset } = record.ended.paused;
  record.ended.paused = { cause, reset };
  if (!keepExit) delete record.exitedAt;
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

test("an overdue legacy paused record relaunches after a restart with usage still unknown, as the same attempt", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  run.clock.now = new Date("2026-10-14T14:00:00Z");
  await run.tick();
  writeFileSync(rawLog(run.launched[0].options), "first attempt\n");
  run.launched[0].finish(new Error("agent crashed"));
  await settled();
  await run.tick();
  const retried = run.launched[1];
  // The incident's pause: 15:03:29 UTC, resetting at 5:50pm (UTC).
  run.clock.now = new Date("2026-10-14T15:03:29Z");
  endOnCodexLimit(retried, "5:50pm (UTC)");
  retried.finish(new Error("codex exited with code 1"));
  await settled();
  await until(() => recordOf(run.state, 4, 2).exited);
  await run.tick();
  const issue = run.github.find("acme/widgets", 4);
  assert.deepEqual(issue.labels, ["ready-for-agent", "factory:paused"]);
  assert.equal(issue.comments.length, 1);
  legacy(run.state, 4, 2);

  // Restarts before the reset hold it to the deadline the pause fixes.
  run.clock.now = new Date("2026-10-14T17:00:00Z");
  const early = run.restart();
  await early.tick();
  assert.equal(
    held(run, 4),
    "relaunch waits: codex hit its usage limit (resets 5:50pm (UTC)); its usage is unreadable, so it waits until 2026-10-14T17:50:00.000Z at most",
  );
  early.interrupt();

  run.clock.now = new Date("2026-10-15T16:05:00Z");
  const restarted = run.restart();
  const decisions = await restarted.tick();
  assert.deepEqual(
    decisions.filter(({ kind }) => kind !== "skip"),
    [
      { kind: "unpause", repository: "acme/widgets", issue: 4 },
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
          log: join(
            run.state,
            "repositories/acme/widgets/logs/issue-4-attempt-1.log",
          ),
        },
        relaunch: true,
      },
    ],
  );
  assert.deepEqual(issue.labels, ["ready-for-agent", "factory:running"]);
  assert.equal(issue.comments.length, 1);
  const resumed = run.launched[2];
  assert.equal(resumed.options.prompt, retried.options.prompt);
  assert.deepEqual(resumed.options.branchStrategy, {
    type: "branch",
    branch: "factory/issue-4",
  });
  assert.equal(
    recordOf(run.state, 4, 2).log,
    join(run.state, "repositories/acme/widgets/logs/issue-4-attempt-2.log"),
  );

  // Another limit is a new pause with its own deadline.
  run.clock.now = new Date("2026-10-15T16:10:00Z");
  endOnCodexLimit(resumed, "5:50pm (UTC)");
  resumed.finish(new Error("codex exited with code 1"));
  await settled();
  await until(() => recordOf(run.state, 4, 2).exited);
  await restarted.tick();
  assert.deepEqual(recordOf(run.state, 4, 2).ended, {
    paused: {
      cause: "usage limit",
      reset: "5:50pm (UTC)",
      at: "2026-10-15T16:10:00.000Z",
      until: "2026-10-15T17:50:00.000Z",
    },
    commented: true,
  });
  assert.equal(issue.comments.length, 2);
});

for (const keepExit of [true, false])
  test(`a legacy paused record ${keepExit ? "pauses at its exit" : "without its exit pauses at its start"}`, async (t) => {
    const run = host(t, {
      repositories: { "acme/widgets": [{ number: 4 }] },
      remotes: { "acme/widgets": remote(t, factoryFiles) },
    });
    await run.tick();
    // Started at 12:00 and exited at 13:00, after the 12:50pm reset.
    run.clock.now = new Date("2026-10-09T13:00:00Z");
    endOnLimit(run.launched[0]);
    run.launched[0].finish(new Error("claude-code exited with code 1"));
    await settled();
    await until(() => recordOf(run.state, 4, 1).exited);
    await run.tick();
    legacy(run.state, 4, 1, keepExit);
    run.clock.now = new Date("2026-10-09T14:00:00Z");
    const restarted = run.restart();
    const launched = (await restarted.tick()).some(
      ({ kind }) => kind === "launch",
    );
    assert.equal(launched, !keepExit);
    if (keepExit)
      assert.match(
        held(run, 4)!,
        /so it waits until 2026-10-10T12:50:00.000Z at most$/,
      );
  });
