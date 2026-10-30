import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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
import type { RunOptions, RunResult } from "@ai-hero/sandcastle";
import type { DockerOptions } from "@ai-hero/sandcastle/sandboxes/docker";
import {
  PlatformError,
  type Account,
  type Comment,
  type ConnectOptions,
  type Connection,
  type Issue,
  type IssueState,
  type IssueTrackerCapabilities,
  type PullRequest,
} from "@lutzseverino/postern";
import { sandboxEnvironment } from "../src/github-token.ts";
import type { Decision } from "../src/factory.ts";
import type { FactoryEvent } from "../src/events.ts";
import {
  ImageStorageHold,
  type ImageStorageStatus,
} from "../src/image-storage.ts";
import { createHost, type HostPorts } from "../src/host.ts";
import type { HostConfiguration } from "../src/host-configuration.ts";
import type { Retention } from "../src/image-retention.ts";
import { createRegistry } from "../src/providers.ts";
import { UsageReadError, type UsageWindow } from "../src/providers/usage.ts";
import { directory } from "./fakes.ts";
import { briefComment, approvalComment } from "./contract-fixture.ts";

// The host runner, run against a stateful fake of each repository's Postern
// connection, real Git clones of local bare remotes, the provider registry
// over a fake Sandcastle, and a temporary state directory.

// One event of an issue's timeline, the one shape every timeline fixture
// takes. `edited` is a body edit and `renamed` a title edit. An actor whose
// login ends in `[bot]` is a bot or app, and a null actor an account the
// platform no longer knows.
type TimelineEvent = { at: string } & (
  | { event: "labeled"; label: string; actor: string | null; id?: number }
  | { event: "edited" | "renamed" | "commented" }
  | { event: "linked"; subIssue: number }
);

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
  discussion?: Comment[] | Error;
  latestDeletion?: string | null | Error;
  // Events after the issue's creation, when the owner applied its labels.
  timeline?: TimelineEvent[];
};

// Every capability GitHub's adapter offers.
const githubCapabilities: IssueTrackerCapabilities = {
  nativeParent: true,
  nativeBlockers: true,
  bodyEditTime: true,
  linkTime: true,
  botMarking: true,
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

// The hosting platform behind each repository's Postern connection, which
// accepts only the token the command last printed for that repository, reads
// each account's repository role from `roles`, and offers `capabilities`.
// Each write is recorded in `events` as it happens.
function fakePlatform(
  repositories: Record<string, IssueSpec[]>,
  tokens: Record<string, string | Error>,
  roles: Record<string, string | null | Error>,
  capabilities: IssueTrackerCapabilities,
  events: string[],
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
          discussion: [] as Comment[] | Error,
          latestDeletion: null as string | null | Error,
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

  // Each port operation, as `[repository, operation, ...arguments]`.
  const calls: unknown[][] = [];
  const labels = new Map<string, Set<string>>();

  // Edits the platform refuses, as `<owner>/<name>#<n>`.
  const refused = new Set<string>();
  const failedRemovals = new Map<string, Error>();

  const latest = (items: TimelineEvent[]) =>
    items
      .map((item) => item.at)
      .sort()
      .at(-1) ?? null;
  const lower = <T extends string>(value: string) => value.toLowerCase() as T;
  const account = (login: string | null): Account | null =>
    login === null
      ? null
      : {
          login,
          bot: capabilities.botMarking ? login.endsWith("[bot]") : null,
        };

  // The connection to `repository`, which always passes the factory's section
  // names.
  function connect(repository: string, options: ConnectOptions): Connection {
    assert.deepEqual(options.relationshipSections, {
      parent: "Parent",
      blockedBy: "Blocked by",
    });
    const credential = options.credential as () => Promise<string>;
    // Every request authenticates with the token as it stands.
    async function request(operation: string, ...args: unknown[]) {
      calls.push([repository, operation, ...args]);
      assert.equal(
        await credential(),
        tokens[repository],
        `${repository}'s token`,
      );
    }
    const reference = (number: number, issueState: string) => ({
      repository,
      number,
      state: lower<IssueState>(issueState),
    });
    const facts = (issue: (typeof state)[string][number]): Issue => ({
      number: issue.number,
      id: issue.number,
      nodeId: null,
      url: `https://platform.test/${repository}/issues/${issue.number}`,
      state: lower(issue.state),
      title: `Issue ${issue.number}`,
      body: "### Parent\n\n#99\n\n### Blocked by\n\n#98\n",
      author: account("owner"),
      labels: [...issue.labels],
      createdAt: issue.createdAt,
      parent: issue.parent ? reference(issue.parent, "OPEN") : null,
      subIssues: issue.subIssues.map((child) =>
        reference(child.number, child.state ?? "OPEN"),
      ),
      blockedBy: issue.blockedBy.map((blocker) =>
        reference(blocker.number, blocker.state),
      ),
      bodyEditTime: latest(
        issue.timeline.filter((item) => item.event === "edited"),
      ),
      linkTime: latest(
        issue.timeline.filter((item) => item.event === "linked"),
      ),
    });
    const edit = (number: number) => {
      const issue = find(repository, number);
      if (refused.has(`${repository}#${number}`))
        throw new PlatformError("forbidden", "the platform refused the edit");
      return issue;
    };
    const unused = () => {
      throw new Error("the host never uses this operation");
    };
    return {
      repository: { platform: "github", host: "github.com", path: repository },
      issueTracker: {
        capabilities,
        async issues(filter = {}) {
          await request("issues", filter);
          return state[repository]
            .filter(
              (issue) =>
                lower(issue.state) === (filter.state ?? "open") &&
                (filter.label === undefined ||
                  issue.labels.includes(filter.label)),
            )
            .map(facts);
        },
        async labelChanges(number) {
          await request("labelChanges", number);
          return find(repository, number).timeline.flatMap((item, id) =>
            item.event === "labeled"
              ? [
                  {
                    id: item.id ?? id,
                    action: "added" as const,
                    label: item.label,
                    actor: account(item.actor),
                    time: item.at,
                  },
                ]
              : [],
          );
        },
        async addLabels(number, names) {
          await request("addLabels", number, ...names);
          const issue = edit(number);
          for (const label of names) {
            events.push(`add ${repository}#${number} ${label}`);
            if (!issue.labels.includes(label)) issue.labels.push(label);
            issue.timeline.push({
              event: "labeled",
              label,
              actor: "factory[bot]",
              at: "2026-10-09T12:00:00Z",
            });
          }
        },
        async removeLabel(number, label) {
          await request("removeLabel", number, label);
          const failure = failedRemovals.get(
            `${repository}#${number} ${label}`,
          );
          if (failure) throw failure;
          const issue = edit(number);
          if (!issue.labels.includes(label))
            throw new PlatformError("notFound", "Label does not exist");
          events.push(`remove ${repository}#${number} ${label}`);
          issue.labels = issue.labels.filter((name) => name !== label);
        },
        async createLabel(label) {
          await request("createLabel", label);
          const existing = labels.get(repository) ?? new Set<string>();
          labels.set(repository, existing);
          if (existing.has(label.name))
            throw new PlatformError("rejected", "Validation Failed", {
              status: 422,
            });
          existing.add(label.name);
          return label;
        },
        async createComment(number, comment) {
          await request("createComment", number, comment);
          edit(number).comments.push(comment);
          return {} as Comment;
        },
        async comments(number) {
          await request("comments", number);
          const discussion = find(repository, number).discussion;
          if (discussion instanceof Error) throw discussion;
          return discussion;
        },
        async closeIssue(number) {
          await request("closeIssue", number);
          edit(number).state = "CLOSED";
        },
        issue: unused,
        updateComment: unused,
      },
      pullRequests: {
        capabilities: { closingReferences: true },
        async closing(number) {
          await request("closing", number);
          return find(repository, number).pullRequests.map(
            (pullRequest) =>
              ({
                state: lower(pullRequest),
                createdAt: "2026-10-09T12:00:00Z",
                crossRepository: false,
              }) as PullRequest,
          );
        },
        async byHeadBranch(branch) {
          await request("byHeadBranch", branch);
          assert.match(branch, /^factory\/issue-\d+$/);
          return [];
        },
        pullRequest: unused,
        reviews: unused,
        reviewThreads: unused,
        checks: unused,
        mergesThroughQueue: unused,
        comment: unused,
        squashMerge: unused,
      },
      releaseSource: {
        capabilities: {},
        releases: unused,
        tagCommit: unused,
      },
      access: {
        capabilities: {},
        async role(login) {
          await request("role", login);
          const role = roles[login] ?? null;
          if (role instanceof Error) throw role;
          return role;
        },
        viewer: unused,
        async request(options) {
          assert.equal(options.path, "/graphql");
          const body = options.body as {
            query: string;
            variables: { number: number };
          };
          assert.match(body.query, /COMMENT_DELETED_EVENT/);
          await request("commentDeletions", body.variables.number);
          const deletion = find(
            repository,
            body.variables.number,
          ).latestDeletion;
          if (deletion instanceof Error) throw deletion;
          return {
            status: 200,
            headers: {},
            data: {
              data: {
                repository: {
                  issue: {
                    timelineItems: {
                      nodes: deletion === null ? [] : [{ createdAt: deletion }],
                    },
                  },
                },
              },
            },
          };
        },
      },
    };
  }

  return { connect, find, refused, failedRemovals, calls, labels };
}

// Sandcastle that records each run, with the token the sandbox would read,
// until the test finishes it or its sandbox is removed.
function fakeSandcastle() {
  let closing = false;
  // While set, an aborted agent keeps running until it finishes.
  const control = { ignoreAborts: false };
  const launched: {
    options: RunOptions;
    docker: DockerOptions;
    hosts: string;
    finish(error?: Error, result?: Partial<RunResult>): void;
    removed: boolean;
  }[] = [];
  let docker: DockerOptions;
  return {
    launched,
    control,
    finish() {
      closing = true;
      for (const launch of launched) launch.finish();
    },
    sandcastle: {
      docker(options: DockerOptions) {
        docker = options;
        return { name: "docker" } as unknown as RunOptions["sandbox"];
      },
      run(options: RunOptions) {
        const github = docker.mounts?.find(
          (mount) => mount.sandboxPath === "/run/factory/github",
        );
        return new Promise<RunResult>((resolve, reject) => {
          const complete = (result?: Partial<RunResult>) =>
            resolve({
              branch:
                options.branchStrategy?.type === "branch"
                  ? options.branchStrategy.branch
                  : "unused",
              iterations: [],
              commits: [],
              stdout: "",
              ...result,
            });
          launched.push({
            options,
            docker,
            hosts: github
              ? readFileSync(join(github.hostPath, "hosts.yml"), "utf8")
              : "",
            finish: (error, result) =>
              error ? reject(error) : complete(result),
            removed: false,
          });
          options.signal?.addEventListener("abort", () => {
            if (!control.ignoreAborts) reject(options.signal!.reason);
          });
          if (closing) complete();
        });
      },
    },
  };
}

// Existing convention checks isolate the configured invocation; the contract
// itself is verified through whole launches below.
const invocation = (text: string | undefined) =>
  text?.split("\n\nUnattended execution:\n")[0];

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
    capabilities = githubCapabilities,
    unserved = [],
    configuration = {},
    caps = { "claude-code": 2, codex: 1 },
    imageFailures = [],
    storage,
    usage = {},
    retention = [],
    pruning = [],
  }: {
    repositories: Record<string, IssueSpec[]>;
    remotes: Record<string, string>;
    tokens?: Record<string, string | Error>;
    roles?: Record<string, string | null | Error>;
    capabilities?: IssueTrackerCapabilities;
    // The repositories whose remote no platform adapter serves.
    unserved?: string[];
    configuration?: Partial<HostConfiguration>;
    caps?: { "claude-code": number; codex: number };
    // Each build in turn fails with its error, or succeeds on null.
    imageFailures?: (Error | null)[];
    storage?: ImageStorageStatus;
    // Each provider's usage as the next read finds it: absent or null has no
    // usage window, a number has no reset, and an error is thrown.
    usage?: Record<string, number | UsageWindow | null | Error>;
    // What each image retention resolves or rejects with, in turn; once these
    // run out it removes nothing.
    retention?: (Retention | Error)[];
    // What each cache prune resolves or rejects with, in turn; once these run
    // out it frees nothing.
    pruning?: (string | Error)[];
  },
) {
  const instances: ReturnType<typeof createHost>[] = [];
  const root = directory(t, async () => {
    for (const instance of instances) instance.interrupt();
    // Release gates even if a failed test left a launch waiting to start.
    for (const start of starts.splice(0)) start();
    fake.finish();
    await Promise.all(instances.map((instance) => instance.drain()));
  });
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
  // Sandbox removals and label writes, in order.
  const events: string[] = [];
  const github = fakePlatform(
    repositories,
    tokenOf,
    roles,
    capabilities,
    events,
  );
  const fake = fakeSandcastle();
  const { sandcastle, launched } = fake;
  const resolved: HostConfiguration = {
    repositories: Object.keys(repositories),
    providers: {
      "claude-code": { cap: caps["claude-code"], credential: claudeToken },
      codex: { cap: caps.codex, credential: codexLogin },
    },
    models: { default: "claude-sonnet-5-5", retry: "gpt-5.5" },
    timeLimitMinutes: 240,
    usage: {
      drainThreshold: 80,
      pauseThreshold: null,
      afterDrain: "auto-resume",
    },
    pollSeconds: 300,
    platforms: {
      github: { tokenCommand: ["unused"], authorizedRoles: ["admin"] },
    },
    unpushablePaths: [".github/workflows/"],
    stateDirectory: join(root, "state"),
    gitIdentity: { name: "Factory", email: "factory@example.test" },
    imageBuilder: "daemon",
    imageRetention: { obsoletePairs: 3, cacheMinimumAgeHours: 24 },
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
  const starts: (() => void)[] = [];
  const usageReads: string[] = [];
  // Each image retention's current and running images, and each cache prune.
  const retentions: { current: string[]; running: string[] }[] = [];
  let prunes = 0;
  const ports: HostPorts = {
    connect(remote, options) {
      const name = Object.keys(remotes).find(
        (name) => remotes[name] === remote,
      )!;
      if (unserved.includes(name))
        throw new PlatformError(
          "unsupported",
          "No platform adapter serves the remote on host git.example.test.",
        );
      return github.connect(name, options);
    },
    git: async (_token, cwd, args) => git(cwd, args),
    async token(repository) {
      tokenCommands.push(repository);
      const token = tokenOf[repository];
      if (token instanceof Error) throw token;
      return token;
    },
    remoteUrl: (repository) => remotes[repository],
    imageStorageStatus: () => storage,
    async buildImage(dockerfile) {
      builds.push(dockerfile);
      const failure = imageFailures.shift();
      if (failure) throw failure;
      return `factory-sandbox:${builds.length}`;
    },
    async retainImages(current, running) {
      retentions.push({ current, running });
      const answer = retention.shift() ?? { removed: [], problems: [] };
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async pruneBuildCache() {
      prunes++;
      const answer = pruning.shift() ?? null;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async readUsage(provider) {
      usageReads.push(provider);
      const answer = usage[provider];
      if (answer instanceof Error) throw answer;
      return typeof answer === "number"
        ? { used: answer, reset: null }
        : (answer ?? null);
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
    instances.push(instance);
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
    sandcastle: fake.control,
    events,
    github,
    launched,
    builds,
    retentions,
    prunes: () => prunes,
    reports,
    tokens: tokenOf,
    tokenCommands,
    clock,
    usage,
    usageReads,
    state,
    configuration: resolved,
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

for (const ending of ["running", "finished", "failed", "aborted", "restarted"])
  test(`host fixture lifecycle removes its root after ${ending} launches`, async (t) => {
    let run: ReturnType<typeof host>;
    await t.test("owns the host and its remote", async (fixture) => {
      run = host(fixture, {
        repositories: { "acme/widgets": [{ number: 4 }] },
        remotes: { "acme/widgets": remote(fixture, factoryFiles) },
      });
      await run.tick();
      if (ending === "finished") run.launched[0].finish();
      if (ending === "failed")
        run.launched[0].finish(new Error("agent crashed"));
      if (ending === "aborted") {
        run.clock.now = new Date("2026-10-09T16:01:00Z");
        await run.tick();
        assert.equal(run.launched[0].options.signal!.aborted, true);
      }
      if (ending === "restarted") {
        run.interrupt();
        await run.restart().tick();
        assert.equal(run.launched.length, 2);
      }
    });
    assert.equal(existsSync(dirname(run!.state)), false);
    // Joining again must reveal no writes that recreate the removed root.
    await run!.drain();
    assert.equal(existsSync(dirname(run!.state)), false);
    assert.ok(
      run!.reports.every(
        (line) => !line.includes("did not finish its records"),
      ),
      run!.reports.join("\n"),
    );
  });

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
        prompt: invocation(options.prompt),
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
  const { providers: _providers, ...repositoryStatus } = run.status();
  assert.deepEqual(repositoryStatus, {
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

// An external consumer only reads newline-terminated records and deduplicates
// delivery by id. Its checkpoint must not advance over a partial final line.
function replay(run: ReturnType<typeof host>): FactoryEvent[] {
  const path = join(run.state, "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .slice(0, -1)
    .map((line) => JSON.parse(line));
}

test("empty-frontier status and events expose simultaneous providers, including a pause threshold with zero running work", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
    configuration: { usage: thresholds },
    usage: { "claude-code": { used: 92, reset }, codex: { used: 96, reset } },
  });
  await run.tick();
  const at = "2026-10-09T12:00:00.000Z";
  assert.deepEqual(run.status().providers, [
    {
      provider: "claude-code",
      observedAt: at,
      usage: { state: "known", reading: { used: 92, at, reset } },
      usageHold: { used: 92, at, reset, since: at, until: reset },
      ownerHold: null,
      reserve: null,
      thresholds: { ...thresholds, effectiveDrainThreshold: 90 },
      running: 0,
      paused: 0,
      claimsHeld: true,
      pauseAtThreshold: false,
      drained: true,
      reason: "drain-threshold",
      nextAction: "wait-for-usage",
    },
    {
      provider: "codex",
      observedAt: at,
      usage: { state: "known", reading: { used: 96, at, reset } },
      usageHold: { used: 96, at, reset, since: at, until: reset },
      ownerHold: null,
      reserve: null,
      thresholds: { ...thresholds, effectiveDrainThreshold: 90 },
      running: 0,
      paused: 0,
      claimsHeld: true,
      pauseAtThreshold: true,
      drained: true,
      reason: "pause-threshold",
      nextAction: "wait-for-usage",
    },
  ]);
  assert.deepEqual(
    replay(run).map(({ provider, type }) => [provider, type]),
    [
      ["claude-code", "held"],
      ["claude-code", "drain_started"],
      ["claude-code", "drained"],
      ["codex", "held"],
      ["codex", "drain_started"],
      ["codex", "paused_at_threshold"],
      ["codex", "drained"],
    ],
  );
  const first = replay(run);
  run.clock.now = new Date("2026-10-09T12:05:00Z");
  await run.tick();
  run.interrupt();
  await run.restart().tick();
  assert.deepEqual(replay(run), first);
  assert.equal(new Set(first.map(({ id }) => id)).size, 7);
  assert.deepEqual(
    first.map(({ sequence }) => sequence),
    [1, 2, 3, 4, 5, 6, 7],
  );
  const delivered = new Set<string>();
  const deliveries = [...first, ...replay(run)].filter(({ id }) => {
    if (delivered.has(id)) return false;
    delivered.add(id);
    return true;
  });
  assert.equal(deliveries.length, 7);
  assert.equal(run.launched.length, 0);
  assert.equal(
    run.github.calls.some(([, operation]) => operation === "createComment"),
    false,
  );
});

test("drained is observed after running work finishes, while low usage can reopen claims before it finishes", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
    configuration: { usage: thresholds },
  });
  await run.tick();
  run.usage["claude-code"] = 92;
  await run.tick();
  assert.deepEqual(
    replay(run).map(({ type }) => type),
    ["held", "drain_started"],
  );
  assert.equal(run.status().providers[0].running, 1);
  run.usage["claude-code"] = 89;
  await run.tick();
  assert.deepEqual(
    replay(run)
      .slice(-2)
      .map(({ type }) => type),
    ["released", "resumed"],
  );
  assert.equal(run.status().providers[0].claimsHeld, false);
  assert.equal(run.status().providers[0].running, 1);
  run.usage["claude-code"] = 92;
  await run.tick();
  run.github.find("acme/widgets", 4).pullRequests.push("OPEN");
  run.launched[0].finish();
  await until(() => recordOf(run.state, 4, 1).exited);
  await run.tick();
  assert.deepEqual(
    replay(run)
      .slice(-1)
      .map(({ type, state }) => [type, state.running]),
    [["drained", 0]],
  );
  await run.tick();
  assert.equal(replay(run).filter(({ type }) => type === "drained").length, 1);
});

test("usage release, owner release and each accepted reserve request have distinct durable events", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
    configuration: { usage: ownerResume },
    usage: { "claude-code": { used: 92, reset } },
  });
  // A queued request must not hide a hold set earlier in the same pass.
  resumeCommand(run, "claude-code", "--drain-threshold", "94");
  await run.tick();
  assert.deepEqual(
    replay(run).map(({ type, reason }) => [type, reason]),
    [
      ["held", "usage-hold"],
      ["drain_started", "drain-threshold"],
      ["drained", "no-running-work"],
      ["held", "owner-hold"],
      ["released", "owner-hold"],
      ["reserve_granted", "owner-request"],
      ["resumed", "owner-request"],
    ],
  );
  resumeCommand(run, "claude-code", "--drain-threshold", "94");
  await run.tick();
  assert.deepEqual(
    replay(run)
      .slice(-2)
      .map(({ type }) => type),
    ["reserve_granted", "resumed"],
  );
  assert.equal(
    replay(run).filter(({ type }) => type === "reserve_granted").length,
    2,
  );
  run.clock.now = new Date("2026-10-09T12:10:00Z");
  run.usage["claude-code"] = 94;
  await run.tick();
  run.usage["claude-code"] = 10;
  await run.tick();
  assert.equal(replay(run).at(-1)?.type, "released");
  assert.equal(replay(run).at(-1)?.reason, "usage-hold");
  assert.equal(run.status().providers[0].nextAction, "owner-resume");
  run.interrupt();
  const restarted = run.restart();
  const before = replay(run);
  await restarted.tick();
  assert.deepEqual(replay(run), before);
  resumeCommand(run, "claude-code");
  await restarted.tick();
  assert.deepEqual(
    replay(run)
      .slice(-2)
      .map(({ type, reason }) => [type, reason]),
    [
      ["released", "owner-hold"],
      ["resumed", "owner-request"],
    ],
  );
  assert.equal(
    new Set(replay(run).map(({ id }) => id)).size,
    replay(run).length,
  );
});

test("work completing between passes is drained even when the next usage reading reopens claims", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
    configuration: { usage: thresholds },
  });
  await run.tick();
  run.usage["claude-code"] = 92;
  await run.tick();
  run.github.find("acme/widgets", 4).pullRequests.push("OPEN");
  run.launched[0].finish();
  await until(() => recordOf(run.state, 4, 1).exited);
  run.usage["claude-code"] = 89;
  await run.tick();
  assert.deepEqual(
    replay(run)
      .slice(-3)
      .map(({ type }) => type),
    ["drained", "released", "resumed"],
  );
  assert.equal(run.status().providers[0].claimsHeld, false);
  await run.tick();
  assert.equal(replay(run).filter(({ type }) => type === "drained").length, 1);
});

test("unknown usage retains hold evidence until reset and public output excludes provider errors and raw fields", async (t) => {
  const secret = "provider-secret-raw-output";
  const run = host(t, {
    repositories: {},
    remotes: {},
    configuration: { usage: thresholds },
    usage: { "claude-code": { used: 96, reset }, codex: new Error(secret) },
  });
  await run.tick();
  run.usage["claude-code"] = new UsageReadError(secret, { status: 403 });
  run.clock.now = new Date("2026-10-09T12:25:00Z");
  await run.tick();
  assert.deepEqual(run.status().providers[0].usage, { state: "unknown" });
  assert.equal(run.status().providers[0].usageHold.used, 96);
  assert.equal(run.status().providers[0].claimsHeld, true);
  run.interrupt();
  run.clock.now = new Date(reset);
  const restarted = run.restart();
  await restarted.tick();
  assert.equal(run.status().providers[0].usageHold, null);
  assert.equal(run.status().providers[0].claimsHeld, false);
  assert.deepEqual(
    replay(run)
      .slice(-2)
      .map(({ type }) => type),
    ["released", "resumed"],
  );
  run.clock.now = new Date("2026-10-09T14:10:00Z");
  run.usage["claude-code"] = { used: 92, reset: secret };
  await restarted.tick();
  const output =
    readFileSync(join(run.state, "status.json"), "utf8") +
    readFileSync(join(run.state, "events.jsonl"), "utf8");
  assert.doesNotMatch(output, /provider-secret|ghs_|claude-secret|agent\.log/);
  assert.equal(run.launched.length, 0);
});

for (const boundary of [
  "checkpoint",
  "partial append",
  "append sync",
  "policy write",
  "final checkpoint",
] as const) {
  test(`a failed ${boundary} preserves transition identity and recovers before another pass`, async (t) => {
    const run = host(t, {
      repositories: {},
      remotes: {},
      configuration: { usage: thresholds },
      usage: { "claude-code": 10 },
    });
    await run.tick();
    run.usage["claude-code"] = { used: 92, reset };
    const rename = fs.renameSync;
    const write = fs.writeSync;
    const sync = fs.fsyncSync;
    let checkpoints = 0;
    let failed = false;
    const fail = () => {
      failed = true;
      throw new Error("fixture persistence failure");
    };
    const mocks = [
      t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
        if (String(to).endsWith("events-state.json")) {
          checkpoints++;
          if (
            (boundary === "checkpoint" && checkpoints === 1) ||
            (boundary === "final checkpoint" && checkpoints === 2)
          )
            fail();
        }
        if (boundary === "policy write" && String(to).endsWith("usage.json"))
          fail();
        return rename(from, to);
      }),
      t.mock.method(
        fs,
        "writeSync",
        (
          fd: number,
          data: Uint8Array | string,
          ...args: (number | string | null | undefined)[]
        ) => {
          if (
            boundary === "partial append" &&
            Buffer.isBuffer(data) &&
            data.includes(Buffer.from('"type":"held"'))
          ) {
            write(fd, data, 0, 31);
            fail();
          }
          return Reflect.apply(write, fs, [fd, data, ...args]);
        },
      ),
      t.mock.method(fs, "fsyncSync", (fd: number) => {
        if (
          boundary === "append sync" &&
          fs.fstatSync(fd).ino ===
            fs.statSync(join(run.state, "events.jsonl")).ino
        )
          fail();
        return sync(fd);
      }),
    ];
    syncBuiltinESMExports();
    try {
      await assert.rejects(run.tick(), /fixture persistence failure/);
    } finally {
      for (const mocked of mocks) mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(failed, true);
    const before = replay(run);
    if (boundary === "partial append") {
      assert.equal(before.length, 0);
      assert.ok(readFileSync(join(run.state, "events.jsonl")).length > 0);
    }
    run.interrupt();
    run.clock.now = new Date("2026-10-09T12:05:00Z");
    run.usage["claude-code"] = null;
    const restarted = run.restart();
    if (boundary === "checkpoint")
      run.usage["claude-code"] = { used: 92, reset };
    await restarted.tick();
    const recovered = replay(run);
    assert.deepEqual(
      recovered.map(({ type }) => type),
      ["held", "drain_started", "drained"],
    );
    assert.deepEqual(recovered.slice(0, before.length), before);
    if (boundary !== "checkpoint")
      assert.equal(recovered[0].observedAt, "2026-10-09T12:00:00.000Z");
    const persisted = JSON.parse(
      readFileSync(join(run.state, "usage.json"), "utf8"),
    );
    assert.equal(persisted["claude-code"].hold.used, 92);
    await restarted.tick();
    assert.deepEqual(replay(run), recovered);
  });
}

test("a resume whose policy write fails replays its original events and consumes its request once", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
    configuration: { usage: ownerResume },
    usage: { "claude-code": { used: 92, reset } },
  });
  await run.tick();
  resumeCommand(run, "claude-code", "--drain-threshold", "94");
  const rename = fs.renameSync;
  const mocked = t.mock.method(
    fs,
    "renameSync",
    (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).endsWith("owner.json"))
        throw new Error("fixture owner failure");
      return rename(from, to);
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(run.tick(), /fixture owner failure/);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  const before = replay(run);
  assert.deepEqual(
    before.slice(-3).map(({ type }) => type),
    ["released", "reserve_granted", "resumed"],
  );
  assert.equal(readdirSync(join(run.state, "requests")).length, 1);
  run.interrupt();
  const restarted = run.restart();
  await restarted.tick();
  assert.deepEqual(replay(run), before);
  assert.deepEqual(readdirSync(join(run.state, "requests")), []);
  assert.equal(run.status().providers[0].reserve.drainThreshold, 94);
  assert.equal(run.status().providers[0].claimsHeld, false);
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

test("image retention waits for every repository's current image and keeps the running runs' images", async (t) => {
  const run = host(t, {
    repositories: {
      "acme/widgets": [{ number: 4 }],
      "acme/gadgets": [{ number: 3 }],
    },
    remotes: {
      "acme/widgets": remote(t, factoryFiles),
      "acme/gadgets": remote(t, factoryFiles),
    },
    imageFailures: [
      new Error("apt-get exited with 100"),
      null,
      new Error("apt-get exited with 100"),
    ],
  });
  const wait =
    "sandbox image retention waits for the current images of acme/widgets";
  // Another repository's successful build never makes this one's images
  // obsolete, however many passes it takes.
  await run.tick();
  await run.tick();
  assert.deepEqual(run.retentions, []);
  assert.equal(run.reports.filter((line) => line === wait).length, 1);
  // The factory's own cache is pruned by age on every pass regardless.
  assert.equal(run.prunes(), 2);
  await run.tick();
  assert.deepEqual(run.retentions, [
    {
      current: ["factory-sandbox:5", "factory-sandbox:6"],
      // gadgets#3 launched on the first pass's image and widgets#4 on this
      // pass's, before retention ran.
      running: ["factory-sandbox:2", "factory-sandbox:5"],
    },
  ]);
  // An exited run's image is no longer running; its retry's is.
  run.launched[0].finish();
  await run.tick();
  assert.equal(run.launched[2].options.name, "acme/gadgets#3");
  assert.deepEqual(run.retentions.at(-1), {
    current: ["factory-sandbox:7", "factory-sandbox:8"],
    running: ["factory-sandbox:5", "factory-sandbox:8"],
  });
  assert.equal(run.prunes(), 4);
});

test("image retention and cache pruning failures are reported without changing the pass", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }, { number: 5 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
    retention: [
      new Error("docker image ls failed: daemon unavailable"),
      {
        removed: ["factory-sandbox:old", "factory-sandbox:old-toolchain"],
        problems: [
          "factory-sandbox:used was not removed: Error: docker image rm failed: conflict",
        ],
      },
    ],
    pruning: [new Error("docker buildx prune failed: boom"), "1.2GB"],
  });
  await run.tick();
  // The providers' launches can finish in either order.
  assert.deepEqual(run.launched.map(({ options }) => options.name).sort(), [
    "acme/widgets#4",
    "acme/widgets#5",
  ]);
  assert.equal(run.status().repositories[0].state, "running");
  await run.tick();
  assert.deepEqual(
    run.reports.filter((line) => /sandbox (image|build)/.test(line)),
    [
      "sandbox image retention removed nothing: Error: docker image ls failed: daemon unavailable",
      "the sandbox build cache was not pruned: Error: docker buildx prune failed: boom",
      "removed obsolete sandbox images: factory-sandbox:old, factory-sandbox:old-toolchain",
      "sandbox image retention: factory-sandbox:used was not removed: Error: docker image rm failed: conflict",
      "pruned the sandbox build cache, freeing 1.2GB",
    ],
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
      "acme/widgets#4 claim failed, so acme/widgets waits for the next pass: PlatformError: the platform refused the edit",
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
    invocation(run.launched[1].options.prompt),
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

test("an incomplete run records recovery identities and a retry revalidates preserved work", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  await run.tick();
  const clone = run.clone("acme/widgets");
  const work = join(clone, ".sandcastle/worktrees/factory-issue-4");
  git(clone, ["worktree", "add", "--quiet", "-b", "factory/issue-4", work]);
  write(work, {
    "committed.txt": "finished code",
    "staged.txt": "staged",
    "untracked.txt": "untracked",
  });
  git(work, ["add", "committed.txt"]);
  git(work, ["commit", "--quiet", "-m", "preserved implementation"]);
  git(work, ["add", "staged.txt"]);
  write(work, { "staged.txt": "unstaged edit" });
  const head = git(work, ["rev-parse", "HEAD"]).trim();
  const status = git(work, ["status", "--porcelain"]);
  run.launched[0].finish(undefined, {
    preservedWorktreePath: work,
    iterations: [
      { sessionId: "session-4", sessionFilePath: "/srv/sessions/4.jsonl" },
    ],
  });
  await run.drain();
  const record = JSON.parse(
    readFileSync(
      join(run.state, "repositories/acme/widgets/runs/issue-4-attempt-1.json"),
      "utf8",
    ),
  );
  assert.equal(record.launchResult.sessionId, "session-4");
  assert.equal(record.launchResult.preservedWorktreePath, work);
  assert.deepEqual(record.recovery, {
    branch: "factory/issue-4",
    head,
    worktree: work,
  });
  assert.ok(
    run.reports.some(
      (line) =>
        line.includes("without completion signal") && line.includes(work),
    ),
  );
  await run.tick();
  const retry = run.launched[1].options.prompt!;
  assert.match(retry, /Recovery state:/);
  assert.ok(retry.includes(head));
  assert.match(retry, /Revalidate recovered work before publication/);
  assert.equal(git(work, ["status", "--porcelain"]), status);
  assert.equal(git(work, ["rev-parse", "HEAD"]).trim(), head);
  assert.equal(
    git(clone, ["ls-remote", "--heads", "origin", "factory/issue-4"]),
    "",
  );
  assert.deepEqual(run.github.find("acme/widgets", 4).pullRequests, []);
});

test("custom prompts and retries retain the unattended execution and completion contract", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: {
      "acme/widgets": remote(t, {
        ...factoryFiles,
        ".factory/config.json": JSON.stringify({
          ...JSON.parse(factoryFiles[".factory/config.json"]),
          prompt: "{skillPrefix}ship #{issue}",
        }),
      }),
    },
  });
  await run.tick();
  run.launched[0].finish();
  await run.drain();
  await run.tick();
  for (const { options } of run.launched) {
    assert.match(options.prompt!, /ship #4/);
    assert.match(options.prompt!, /This is a factory run/);
    assert.doesNotMatch(options.prompt!, /app-author review policy/);
    assert.match(
      options.prompt!,
      /Keep required checks, internal reviews, merge authorization and handling of findings that arrive enforced/,
    );
    assert.match(options.prompt!, /supplied credentials/);
    assert.match(options.prompt!, /Before every delivery push.*fetch.*origin/);
    assert.match(options.prompt!, /resolve.*remote default branch/);
    assert.match(options.prompt!, /outgoing commits.*per-parent.*diff/);
    assert.match(options.prompt!, /rebase or replay.*issue.*current base/);
    assert.match(
      options.prompt!,
      /Never merge the default branch into the issue branch/,
    );
    assert.match(options.prompt!, /clean final diff.*reverted.*rewritten/);
    assert.match(options.prompt!, /Intentional workflow edits.*visible/);
    assert.match(options.prompt!, /permission refusal.*stop.*owner handoff/);
    assert.match(
      options.prompt!,
      /no second push.*credential discovery.*identity switch/,
    );
    assert.match(options.prompt!, /no interactive notification or resume loop/);
    assert.match(options.prompt!, /foreground/);
    assert.match(options.prompt!, /detaching shell commands/);
    assert.match(options.prompt!, /timeout is a failure/);
    assert.match(
      options.prompt!,
      /only after.*delivery or explicit owner handoff.*recorded/,
    );
    assert.ok(options.prompt!.includes(String(options.completionSignal)));
    assert.equal(options.maxIterations, 1);
  }
});

test("review policy guidance stays repository-specific through retries and recovery", async (t) => {
  const run = host(t, {
    repositories: {
      "acme/widgets": [{ number: 4 }],
      "acme/gadgets": [{ number: 4 }],
    },
    remotes: {
      "acme/widgets": remote(t, {
        ...factoryFiles,
        // Presence controls the prompt; babysit owns declaration validation.
        ".github/factory-review-policy.json": "invalid JSON\n",
      }),
      "acme/gadgets": remote(t, factoryFiles),
    },
    caps: { "claude-code": 2, codex: 2 },
  });
  await run.tick();
  for (const name of ["acme/widgets", "acme/gadgets"]) {
    git(run.clone(name), ["branch", "factory/issue-4"]);
  }
  for (const launch of run.launched) launch.finish();
  await run.drain();
  await run.tick();
  run.interrupt();
  for (const launch of run.launched) launch.finish();
  await run.drain();
  await run.restart().tick();

  assert.equal(run.launched.length, 6);
  const policy =
    " Apply the repository-owned app-author review policy before requesting or waiting for external review of this run's own PRs, including after fixes, rebases, retries and resumed runs.";
  for (let offset = 0; offset < 6; offset += 2) {
    const pair = run.launched.slice(offset, offset + 2);
    const withPolicy = pair.find(
      ({ options }) => options.name === "acme/widgets#4",
    )!.options.prompt!;
    const withoutPolicy = pair.find(
      ({ options }) => options.name === "acme/gadgets#4",
    )!.options.prompt!;
    assert.ok(withPolicy.includes(policy));
    assert.doesNotMatch(withoutPolicy, /app-author review policy/);
    // All other unattended-delivery instructions are identical.
    const guidance = (text: string) =>
      text
        .split("\n\nUnattended execution:\n")[1]
        .split("\nRecovery state:")[0];
    assert.equal(
      guidance(withPolicy).replace(policy, ""),
      guidance(withoutPolicy),
    );
    if (offset > 0) {
      assert.match(withPolicy, /First attempt failure:/);
      assert.match(withoutPolicy, /First attempt failure:/);
      assert.match(withPolicy, /Recovery state:/);
      assert.match(withoutPolicy, /Recovery state:/);
    }
  }
});

for (const present of [false, true])
  test(`recovery refreshes review policy presence from ${present} on the default branch`, async (t) => {
    const policyPath = ".github/factory-review-policy.json";
    const policy = JSON.stringify({ version: 1, author: "factory[bot]" });
    const bare = remote(t, {
      ...factoryFiles,
      ...(present && { [policyPath]: policy }),
    });
    const run = host(t, {
      repositories: { "acme/widgets": [{ number: 4 }] },
      remotes: { "acme/widgets": bare },
    });
    await run.tick();
    assert.equal(
      run.launched[0].options.prompt!.includes("app-author review policy"),
      present,
    );
    run.interrupt();
    run.launched[0].finish();
    await run.drain();
    const work = join(dirname(bare), "work");
    if (present) rmSync(join(work, policyPath));
    else write(work, { [policyPath]: policy });
    git(work, ["add", "."]);
    git(work, ["commit", "--quiet", "-m", "change policy presence"]);
    git(work, ["push", "--quiet", bare, "main"]);
    // A leftover untracked file is not a default-branch declaration.
    if (present) {
      const clone = run.clone("acme/widgets");
      git(clone, ["rm", "--quiet", policyPath]);
      git(clone, ["commit", "--quiet", "-m", "remove local policy"]);
      write(clone, { [policyPath]: policy });
    }
    await run.restart().tick();
    assert.equal(run.launched.length, 2);
    assert.equal(
      run.launched[1].options.prompt!.includes("app-author review policy"),
      !present,
    );
  });

test("an aborted launch retains dirty recovery state across restart without publishing it", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  await run.tick();
  const clone = run.clone("acme/widgets");
  const work = join(clone, ".sandcastle/worktrees/factory-issue-4");
  git(clone, ["worktree", "add", "--quiet", "-b", "factory/issue-4", work]);
  write(work, { unfinished: "retain me" });
  run.interrupt();
  run.launched[0].finish(new Error("aborted"));
  await run.drain();
  const restarted = run.restart();
  await restarted.tick();
  assert.equal(run.launched.length, 2);
  assert.match(run.launched[1].options.prompt!, /Recovery state:/);
  assert.match(run.launched[1].options.prompt!, /This is a factory run/);
  assert.match(run.launched[1].options.prompt!, /Before every delivery push/);
  assert.match(
    run.launched[1].options.prompt!,
    /committed, staged, unstaged and untracked/,
  );
  assert.match(
    run.launched[1].options.prompt!,
    /existing PR.*review.*handoff context/,
  );
  assert.match(
    run.launched[1].options.prompt!,
    /owner.*reconstruct.*current base/,
  );
  assert.match(
    run.launched[1].options.prompt!,
    /uncertain.*conflict.*preserve.*hand off/,
  );
  assert.ok(run.launched[1].options.prompt!.includes(work));
  assert.equal(readFileSync(join(work, "unfinished"), "utf8"), "retain me");
  assert.equal(
    git(clone, ["ls-remote", "--heads", "origin", "factory/issue-4"]),
    "",
  );
  assert.deepEqual(run.github.find("acme/widgets", 4).pullRequests, []);
});

for (const outcome of [
  "signal only",
  "PR without signal",
  "owner handoff without signal",
  "timeout with signal",
])
  test(`completion is loop control and GitHub determines delivery: ${outcome}`, async (t) => {
    const run = host(t, {
      repositories: { "acme/widgets": [{ number: 4 }] },
      remotes: { "acme/widgets": remote(t, factoryFiles) },
    });
    await run.tick();
    const issue = run.github.find("acme/widgets", 4);
    if (outcome === "PR without signal") issue.pullRequests.push("OPEN");
    if (outcome === "owner handoff without signal")
      issue.labels.push("factory:needs-input");
    if (outcome === "timeout with signal")
      run.clock.now = new Date("2026-10-09T16:00:00Z");
    run.launched[0].finish(
      undefined,
      outcome.includes("signal") && !outcome.includes("without")
        ? { completionSignal: "<promise>COMPLETE</promise>" }
        : {},
    );
    await run.drain();
    const decisions = await run.tick();
    if (outcome === "PR without signal")
      assert.ok(decisions.some((decision) => decision.kind === "keep"));
    else if (outcome === "owner handoff without signal")
      assert.ok(decisions.some((decision) => decision.kind === "release"));
    else {
      assert.equal(run.launched.length, 2);
      assert.match(
        run.launched[1].options.prompt!,
        outcome === "signal only"
          ? /ended without an open pull request/
          : /exceeded the time limit/,
      );
    }
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
    const comments = run.github.find("acme/widgets", 4).comments;
    assert.equal(comments.length, 1);
    assert.match(comments[0], /claim without a live agent/);
  });

test("an ended run awaiting merge tells its issue once across polls, label removal and restart", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  await run.tick();
  const issue = run.github.find("acme/widgets", 4);
  issue.pullRequests.push("OPEN");
  issue.labels.push("factory:needs-input");
  await run.tick();
  assert.deepEqual(issue.comments, [], "a live run needs no notice");
  run.launched[0].finish();
  await run.drain();
  await run.tick();
  assert.equal(issue.comments.length, 1);
  assert.match(
    issue.comments[0],
    /agent run has ended.*pull request remains open/s,
  );
  assert.match(issue.comments[0], /retains.*claim without a live agent/);
  assert.match(issue.comments[0], /owner must.*merging or closing/i);
  assert.match(issue.comments[0], /continue observing/);
  assert.match(issue.comments[0], /attempt 1/);
  assert.doesNotMatch(issue.comments[0], /pick this issue up again/);
  await run.tick();
  issue.labels = ["ready-for-agent"];
  const restarted = run.restart();
  await restarted.tick();
  await restarted.tick();
  assert.equal(issue.comments.length, 1);
  assert.equal(run.launched.length, 1);
  assert.ok(
    run
      .status()
      .providers.every(
        (provider: { running: number }) => provider.running === 0,
      ),
  );
  issue.pullRequests = ["MERGED"];
  const decisions = await restarted.tick();
  assert.equal(decisions[0].kind, "fail");
  assert.equal(issue.comments.length, 2);
  assert.match(issue.comments[1], /merged without closing the issue/);
});

test("orphan claims awaiting merge are notified once, retry failed delivery and reset after release", async (t) => {
  const run = host(t, {
    repositories: {
      "acme/widgets": [
        { number: 4, labels: ["factory:running"], pullRequests: ["OPEN"] },
        {
          number: 5,
          labels: ["factory:paused", "factory:needs-input"],
          pullRequests: ["OPEN"],
        },
      ],
    },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  const first = run.github.find("acme/widgets", 4);
  const second = run.github.find("acme/widgets", 5);
  run.github.refused.add("acme/widgets#4");
  await run.tick();
  assert.equal(first.comments.length, 0);
  assert.ok(run.reports.some((line) => line.includes("keep failed")));
  run.github.refused.clear();
  let active = run.restart();
  await active.tick();
  assert.equal(first.comments.length, 1);
  assert.equal(second.comments.length, 1);
  assert.doesNotMatch(first.comments[0], /Model:|Log:|attempt/);
  assert.deepEqual(second.labels, ["factory:needs-input", "factory:running"]);
  await active.tick();
  active = run.restart();
  await active.tick();
  assert.equal(first.comments.length, 1);
  assert.equal(second.comments.length, 1);
  assert.equal(run.launched.length, 0);
  first.state = "CLOSED";
  first.pullRequests = ["MERGED"];
  second.pullRequests = ["CLOSED"];
  await active.tick();
  assert.deepEqual(first.labels, []);
  assert.deepEqual(second.labels, ["factory:needs-input"]);
  // A later orphan claim on the same issue is eligible for its own notice.
  second.labels.push("factory:running");
  second.pullRequests = ["OPEN"];
  await active.tick();
  assert.equal(second.comments.length, 2);
  // A claim removed outside the host also ends its notification lifetime.
  second.labels = ["factory:needs-input"];
  await active.tick();
  second.labels.push("factory:running");
  await run.restart().tick();
  assert.equal(second.comments.length, 3);
});

for (const comments of [
  undefined,
  {},
  { pause: "Waiting." },
  {
    awaitingMerge:
      "Held: {provider}/{model}@{effort} #{attempt}{#log} ({log}){/log}; {label}",
  },
])
  test(`a legacy unsettled record retries its awaiting-merge notice, templates: ${JSON.stringify(comments)}`, async (t) => {
    const run = host(t, {
      repositories: { "acme/widgets": [{ number: 4 }] },
      remotes: {
        "acme/widgets": remote(t, {
          ...factoryFiles,
          ".factory/config.json": JSON.stringify({ ...conventions, comments }),
        }),
      },
    });
    await run.tick();
    const issue = run.github.find("acme/widgets", 4);
    issue.pullRequests.push("OPEN");
    run.launched[0].finish();
    await run.drain();
    // This pre-notification record has no delivered flag, as on an older host.
    const previous = recordOf(run.state, 4, 1);
    assert.equal(previous.awaitingMergeNotified, undefined);
    run.github.refused.add("acme/widgets#4");
    await run.restart().tick();
    assert.equal(issue.comments.length, 0);
    assert.equal(recordOf(run.state, 4, 1).awaitingMergeNotified, undefined);
    run.github.refused.clear();
    const restarted = run.restart();
    await restarted.tick();
    if (comments?.awaitingMerge)
      assert.equal(
        issue.comments[0],
        `Held: claude-code/claude-sonnet-5-5@high #1 (${join(run.state, "repositories/acme/widgets/logs/issue-4-attempt-1.log")}); factory:running`,
      );
    else assert.match(issue.comments[0], /factory agent run has ended/);
    await restarted.tick();
    await run.restart().tick();
    assert.equal(issue.comments.length, 1);
    assert.equal(run.launched.length, 1);
    const recovered = recordOf(run.state, 4, 1);
    assert.equal(recovered.attempt, 1);
    assert.equal(recovered.pullRequestSince, previous.pullRequestSince);
    assert.equal(recovered.log, previous.log);
    assert.equal(recovered.awaitingMergeNotified, true);
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
  "base advanced with deleted run branch",
  "base advanced with local workflow",
  "recovery workflow only",
  "merge workflow",
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
        [["ordinary", "recovery workflow only", "merge workflow"].includes(
          scenario,
        )
          ? "README.md"
          : ".github/workflows/new.yml"]: "changed\n",
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
    if (scenario.startsWith("base advanced"))
      git(work, ["push", "--quiet", "origin", "HEAD:main"]);
    if (scenario === "base advanced with deleted run branch") {
      push();
      git(work, ["push", "--quiet", "origin", "--delete", "factory/issue-4"]);
    }
    if (scenario === "base advanced with local workflow")
      commit(
        { ".github/workflows/old.yml": "outgoing\n" },
        "outgoing workflow",
      );
    if (scenario === "recovery workflow only") {
      const head = git(work, ["rev-parse", "HEAD"]).trim();
      git(work, ["checkout", "--quiet", "-b", "recovery/issue-4"]);
      commit({ ".github/workflows/recovery.yml": "preserved\n" }, "recovery");
      git(work, ["checkout", "--quiet", "factory/issue-4"]);
      assert.equal(git(work, ["rev-parse", "HEAD"]).trim(), head);
      write(work, { "staged.md": "staged\n" });
      git(work, ["add", "staged.md"]);
      write(work, { "README.md": "unstaged\n", "untracked.md": "untracked\n" });
    }
    if (scenario === "merge workflow") {
      git(work, ["checkout", "--quiet", "-b", "side", "HEAD^"]);
      commit({ "side.md": "side\n" }, "side change");
      git(work, ["checkout", "--quiet", "factory/issue-4"]);
      git(work, ["merge", "--quiet", "--no-ff", "--no-commit", "side"]);
      commit({ ".github/workflows/old.yml": "merge edit\n" }, "merge workflow");
    }
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
    const recovery = () => ({
      head: git(work, ["rev-parse", "recovery/issue-4"]).trim(),
      staged: git(work, ["diff", "--cached"]),
      unstaged: git(work, ["diff"]),
      status: git(work, ["status", "--porcelain"]),
      untracked: readFileSync(join(work, "untracked.md"), "utf8"),
    });
    const preserved = scenario === "recovery workflow only" ? recovery() : null;
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
      "base advanced with local workflow",
      "merge workflow",
    ].includes(scenario);
    if (failing) {
      const paths = [
        "pushed workflow with local workflow",
        "base advanced with local workflow",
        "merge workflow",
      ].includes(scenario)
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
    if (preserved) assert.deepEqual(recovery(), preserved);
  });
}

test("the repository's skip label holds fresh attempts without factory label writes", async (t) => {
  const configuration = {
    ...conventions,
    labels: { ...conventions.labels, skip: "manual-delivery" },
  };
  const run = host(t, {
    repositories: {
      "acme/widgets": [
        { number: 4, labels: ["ready-for-agent", "manual-delivery"] },
        {
          number: 5,
          labels: ["ready-for-agent", "manual-delivery", "factory:failed"],
        },
        {
          number: 6,
          labels: ["ready-for-agent", "manual-delivery", "factory:needs-input"],
        },
      ],
    },
    remotes: {
      "acme/widgets": remote(t, {
        ...factoryFiles,
        ".factory/config.json": JSON.stringify(configuration),
      }),
    },
    caps: { "claude-code": 3, codex: 1 },
  });
  await run.tick();
  const reason = "labelled `manual-delivery`; delivered outside the factory";
  assert.deepEqual(run.status().repositories[0].held, [
    { issue: 4, reason },
    { issue: 5, reason },
    { issue: 6, reason },
  ]);
  assert.ok(run.reports.some((line) => line.includes(reason)));
  assert.equal(run.launched.length, 0);
  assert.deepEqual(
    run.github.labels.get("acme/widgets"),
    new Set([
      "factory:running",
      "factory:failed",
      "factory:needs-input",
      "factory:paused",
    ]),
  );
  assert.deepEqual(
    run.events.filter((event) => event !== "stop sandboxes"),
    [],
  );

  // Clearing an earlier outcome must not bypass delivery outside the factory.
  for (const number of [5, 6])
    run.github.find("acme/widgets", number).labels = [
      "ready-for-agent",
      "manual-delivery",
    ];
  await run.tick();
  assert.equal(run.launched.length, 0);
  assert.deepEqual(
    run.events.filter((event) => event !== "stop sandboxes"),
    [],
  );

  for (const number of [4, 5, 6])
    run.github.find("acme/widgets", number).labels = ["ready-for-agent"];
  await run.tick();
  assert.deepEqual(run.launched.map(({ options }) => options.name).toSorted(), [
    "acme/widgets#4",
    "acme/widgets#5",
    "acme/widgets#6",
  ]);
  for (const number of [4, 5, 6])
    assert.deepEqual(run.github.find("acme/widgets", number).labels, [
      "ready-for-agent",
      "factory:running",
    ]);
});

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
    comments: {
      failure:
        "{failure}: {provider}/{model}@{effort} #{attempt}{#log} log={log}{/log}; {label}{#unpushableCount} blocked={unpushableCount}{/unpushableCount}",
    },
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
    invocation(run.launched[0].options.prompt),
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
    invocation(run.launched[1].options.prompt),
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
  assert.equal(
    run.github.find("acme/widgets", 4).comments[0],
    `the run ended without an open pull request: claude-code/claude-opus-5-5@high #2 log=${join(run.state, "repositories/acme/widgets/logs/issue-4-attempt-2.log")}; broken`,
  );
  assert.equal(
    run.github.calls.some(
      ([, operation, , label]) =>
        ["addLabels", "removeLabel"].includes(operation as string) &&
        label === "queued",
    ),
    false,
  );
});

for (const fault of [
  "missing configuration",
  "invalid configuration",
  "invalid comment template",
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
    // The two launches can reach Sandcastle in either order.
    const launchOf = (name: string) =>
      run.launched.find(({ options }) => options.name === name)!;
    run.github.find("acme/widgets", 2).state = "CLOSED";
    launchOf("acme/widgets#2").finish();
    await settled();
    const work = join(dirname(bare), "work");
    if (fault === "invalid configuration")
      write(work, { ".factory/config.json": "{}" });
    else if (fault === "invalid comment template")
      write(work, {
        ".factory/config.json": JSON.stringify({
          ...conventions,
          comments: { pause: "{unknown}" },
        }),
      });
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
    assert.deepEqual(run.launched.map(({ options }) => options.name).sort(), [
      "acme/gadgets#4",
      "acme/widgets#2",
    ]);
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
    assert.deepEqual(run.github.find("acme/widgets", 2).comments, []);
    assert.deepEqual(run.github.find("acme/widgets", 3).comments, []);
    // Restoring the default branch resumes pickup on the next pass.
    git(work, ["revert", "--no-edit", "HEAD"]);
    git(work, ["push", "--quiet", bare, "main"]);
    run.github.find("acme/gadgets", 4).state = "CLOSED";
    launchOf("acme/gadgets#4").finish();
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
    invocation(run.launched[1].options.prompt),
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
    invocation(run.launched[1].options.prompt),
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
    "add acme/widgets#4 factory:running",
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
    "add acme/widgets#4 factory:running",
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
    "add acme/widgets#4 factory:running",
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

test("settlement after restart uses the last valid comment template while invalid templates pause pickup", async (t) => {
  const configuration = {
    ...conventions,
    comments: { failure: "Saved wording: {failure}; {label}" },
  };
  const bare = remote(t, {
    ...factoryFiles,
    ".factory/config.json": JSON.stringify(configuration),
  });
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }, { number: 5 }] },
    remotes: { "acme/widgets": bare },
    caps: { "claude-code": 1, codex: 1 },
  });
  await run.tick();
  run.launched[0].finish();
  await run.drain();
  const work = join(dirname(bare), "work");
  write(work, {
    ".factory/config.json": JSON.stringify({
      ...configuration,
      comments: { close: "{failure}" },
    }),
  });
  git(work, ["commit", "--quiet", "-am", "invalid comment template"]);
  git(work, ["push", "--quiet", bare, "main"]);
  run.github.find("acme/widgets", 4).pullRequests.push("MERGED");
  await run.restart().tick();
  assert.equal(run.status().repositories[0].state, "paused");
  assert.deepEqual(run.github.find("acme/widgets", 4).comments, [
    "Saved wording: its pull request merged without closing the issue; close the issue if that finished it; factory:failed",
  ]);
  assert.deepEqual(run.github.find("acme/widgets", 5).labels, [
    "ready-for-agent",
  ]);
  assert.deepEqual(run.github.find("acme/widgets", 5).comments, []);
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

test("pickup and parent readiness use the current Agent Brief even while stale labels survive", async (t) => {
  const approved = [briefComment, approvalComment];
  const edited = [
    {
      ...briefComment,
      body: briefComment.body + "Changed scope.\n",
      updatedAt: "2026-10-06T00:00:00Z",
    },
    approvalComment,
  ];
  const triaged = (
    number: number,
    discussion: Comment[] | Error,
    details: Partial<IssueSpec> = {},
  ): IssueSpec => ({
    number,
    labels: [ready, "bug"],
    discussion,
    timeline: [
      {
        event: "labeled",
        label: ready,
        actor: "owner",
        at: "2026-10-05T00:00:00Z",
        id: 42,
      },
    ],
    ...details,
  });
  const run = host(t, {
    repositories: {
      "acme/widgets": [
        triaged(1, approved),
        triaged(2, edited),
        triaged(3, [
          briefComment,
          approvalComment,
          { ...briefComment, id: 12, nodeId: "IC_12" },
        ]),
        triaged(4, [approvalComment]),
        triaged(5, new PlatformError("unavailable", "Comments unavailable")),
        triaged(6, approved, {
          subIssues: [{ number: 7 }],
          latestDeletion: "2026-10-06T00:00:00Z",
        }),
        { number: 7, parent: 6 },
        triaged(8, approved, {
          subIssues: [{ number: 80, state: "CLOSED" }],
          latestDeletion: "2026-10-06T00:00:00Z",
        }),
        triaged(9, approved, { subIssues: [{ number: 90, state: "CLOSED" }] }),
      ],
    },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
    caps: { "claude-code": 5, codex: 1 },
  });
  await run.tick();
  assert.deepEqual(
    run.launched.map(({ options }) => options.name),
    ["acme/widgets#1"],
  );
  for (const number of [2, 3, 4, 5, 7, 8])
    assert.match(held(run, number)!, /current Agent Brief/);
  assert.equal(run.github.find("acme/widgets", 8).state, "OPEN");
  assert.equal(run.github.find("acme/widgets", 9).state, "CLOSED");
  // Review of the actual edited Brief releases held work on the next pickup
  // snapshot. The ready event and validator approval both reflect that review.
  const reviewedEdit = [
    edited[0],
    {
      ...approvalComment,
      body: approvalComment.body
        .replaceAll(
          "e4a84a2dd9caf78e1d4dbf78e73f2a81004dc935cca474dbbc65aee038195c37",
          "440a84cd3525f93b73b750b3cc8bcae6900a60626d0aab3ccd5e267d3a9479bd",
        )
        .replace('"reviewEventId":"42"', '"reviewEventId":"43"'),
      updatedAt: "2026-10-07T00:00:01Z",
    },
  ];
  run.github.find("acme/widgets", 2).discussion = reviewedEdit;
  run.github.find("acme/widgets", 2).timeline.push({
    event: "labeled",
    label: ready,
    actor: "owner",
    at: "2026-10-07T00:00:00Z",
    id: 43,
  });
  run.github.find("acme/widgets", 6).discussion = [
    briefComment,
    {
      ...approvalComment,
      body: approvalComment.body.replace(
        '"reviewEventId":"42"',
        '"reviewEventId":"43"',
      ),
    },
  ];
  run.github.find("acme/widgets", 6).timeline.push({
    event: "labeled",
    label: ready,
    actor: "owner",
    at: "2026-10-07T00:00:00Z",
    id: 43,
  });
  await run.tick();
  assert.deepEqual(run.launched.map(({ options }) => options.name).sort(), [
    "acme/widgets#1",
    "acme/widgets#2",
    "acme/widgets#7",
  ]);
});

test("readiness counts only from a user whose role, read once a pass, the host authorizes", async (t) => {
  const roles: Record<string, string | null | Error> = {
    owner: "admin",
    casey: "write",
    morgan: new PlatformError("unavailable", "GitHub answered with 502"),
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
      .filter(([, operation]) => operation === "role")
      .map(([, , login]) => login);
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
    `its readiness is refused: ready-for-agent was applied by release-bot[bot], a bot or app, which never authorizes; ${authorized}`,
  );
  assert.equal(
    held(run, 4),
    `its readiness is refused: ready-for-agent was applied by an account that is not a user, which never authorizes; ${authorized}`,
  );
  assert.equal(
    held(run, 5),
    "its readiness waits: the repository role of @morgan, who applied ready-for-agent, could not be read this pass",
  );
  assert.deepEqual(lookups(), ["owner", "casey", "morgan"]);
  // Refused readiness writes nothing to GitHub.
  assert.deepEqual(run.events, [
    "stop sandboxes",
    "add acme/widgets#1 factory:running",
    "add acme/widgets#6 factory:running",
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

test("without the platform's edit and link times, readiness skips those comparisons and invents no time", async (t) => {
  const later = "2026-10-09T10:00:01Z";
  const repositories = {
    "acme/widgets": [
      {
        number: 1,
        subIssues: [{ number: 2 }],
        timeline: [
          labelled("owner"),
          { event: "linked", subIssue: 2, at: later },
        ],
      },
      { number: 2, parent: 1 },
      {
        number: 4,
        timeline: [labelled("owner"), { event: "edited", at: later }],
      },
    ] satisfies IssueSpec[],
  };
  const {
    bodyEditTime: _edits,
    linkTime: _links,
    ...timeless
  } = githubCapabilities;
  for (const [capabilities, launched] of [
    [githubCapabilities, []],
    [timeless, ["acme/widgets#2", "acme/widgets#4"]],
  ] as const) {
    const run = host(t, {
      repositories,
      remotes: { "acme/widgets": remote(t, factoryFiles) },
      capabilities,
    });
    await run.tick();
    assert.deepEqual(
      run.launched.map(({ options }) => options.name).sort(),
      launched,
    );
    if (launched.length === 0) {
      assert.match(held(run, 2)!, /whose readiness predates its latest ticket/);
      assert.match(held(run, 4)!, /not after the body's last edit/);
    }
  }
});

test("on a platform that marks no bots, the host must name the accounts that never authorize, and they never do", async (t) => {
  const { botMarking: _, ...unmarked } = githubCapabilities;
  const repositories = {
    "acme/widgets": [
      { number: 1 },
      { number: 2, timeline: [labelled("Release-Helper")] },
      { number: 3, timeline: [labelled("release-bot[bot]")] },
      { number: 4, timeline: [labelled("riley")] },
    ],
  };
  const roles = { owner: "admin", "release-helper": "admin" };
  const unlisted = host(t, {
    repositories,
    remotes: { "acme/widgets": remote(t, factoryFiles) },
    capabilities: unmarked,
    roles,
  });
  await unlisted.tick();
  assert.deepEqual(unlisted.launched, []);
  assert.deepEqual(unlisted.status().repositories[0], {
    ...unlisted.status().repositories[0],
    state: "paused",
    reason:
      "github marks no bots, so the host configuration must list the accounts that never authorize in platforms.github.neverAuthorize",
  });
  assert.deepEqual(unlisted.github.find("acme/widgets", 1).labels, [ready]);

  const listed = host(t, {
    repositories,
    remotes: { "acme/widgets": remote(t, factoryFiles) },
    capabilities: unmarked,
    roles,
    configuration: {
      platforms: {
        github: {
          tokenCommand: ["unused"],
          authorizedRoles: ["admin"],
          neverAuthorize: ["release-helper", "release-bot[bot]"],
        },
      },
    },
  });
  await listed.tick();
  assert.deepEqual(
    listed.launched.map(({ options }) => options.name),
    ["acme/widgets#1"],
  );
  const authorized =
    "a person with the admin role must remove and re-apply ready-for-agent";
  for (const [number, login] of [
    [2, "Release-Helper"],
    [3, "release-bot[bot]"],
  ] as const)
    assert.equal(
      held(listed, number),
      `its readiness is refused: ready-for-agent was applied by @${login}, an account the host configuration never lets authorize; ${authorized}`,
    );
  // A user the platform reports no role for holds none.
  assert.equal(
    held(listed, 4),
    `its readiness is refused: ready-for-agent was applied by @riley, who holds no repository role; ${authorized}`,
  );
});

test("a repository whose remote no platform serves is refused, and the others are still served", async (t) => {
  const run = host(t, {
    repositories: {
      "acme/widgets": [{ number: 4 }],
      "acme/gadgets": [{ number: 3 }],
    },
    remotes: {
      "acme/widgets": remote(t, factoryFiles),
      "acme/gadgets": remote(t, factoryFiles),
    },
    unserved: ["acme/widgets"],
  });
  await run.tick();
  assert.deepEqual(
    run.launched.map(({ options }) => options.name),
    ["acme/gadgets#3"],
  );
  const [widgets] = run.status().repositories;
  assert.equal(widgets.state, "paused");
  assert.equal(
    widgets.reason,
    "its remote is on no platform the factory serves: No platform adapter serves the remote on host git.example.test.",
  );
  assert.deepEqual(run.github.find("acme/widgets", 4).labels, [ready]);
  assert.equal(
    run.github.calls.some(([repository]) => repository === "acme/widgets"),
    false,
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
    "sub-issue of #1, whose readiness predates its latest ticket; remove and re-apply ready-for-agent on #1 once its tickets are published",
  );
  assert.equal(
    held(run, 5),
    "its readiness is refused: ready-for-agent was applied by @casey, whose repository role triage is not authorized; a person with the admin role must remove and re-apply ready-for-agent",
  );
  assert.equal(run.github.find("acme/widgets", 5).state, "OPEN");
  assert.deepEqual(run.github.find("acme/widgets", 5).comments, []);
  assert.equal(run.github.find("acme/widgets", 6).state, "CLOSED");
  assert.deepEqual(run.github.find("acme/widgets", 6).comments, [
    "All sub-issues are closed. Closing this parent.\n\n- #8",
  ]);
});

test("the parent close template controls the whole comment and iterates ticket references", async (t) => {
  const run = host(t, {
    repositories: {
      "acme/widgets": [
        {
          number: 1,
          subIssues: [
            { number: 2, state: "CLOSED" },
            { number: 3, state: "CLOSED" },
          ],
        },
      ],
    },
    remotes: {
      "acme/widgets": remote(t, {
        ...factoryFiles,
        ".factory/config.json": JSON.stringify({
          ...conventions,
          comments: { close: "Completed:{#tickets} [{tickets}]{/tickets}" },
        }),
      }),
    },
  });
  await run.tick();
  assert.deepEqual(run.github.find("acme/widgets", 1).comments, [
    "Completed: [#2] [#3]",
  ]);
  assert.equal(run.github.find("acme/widgets", 1).state, "CLOSED");
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
  assert.equal(issue.comments.length, 2);
  assert.match(issue.comments[0], /attempt 2/);
  assert.match(issue.comments[1], /run failed:.*pull request closed/);
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
    assert.equal(invocation(run.launched[2].options.prompt), "/implement #4");
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

for (const override of [false, true])
  test(`a claim with no run record fails unpushable commits with ${override ? "configured" : "default"} wording`, async (t) => {
    const run = host(t, {
      repositories: { "acme/widgets": [{ number: 4, labels: [] }] },
      remotes: {
        "acme/widgets": remote(t, {
          ...factoryFiles,
          ".factory/config.json": JSON.stringify({
            ...conventions,
            comments: override
              ? {
                  failure:
                    "{#unpushableCount}{unpushableCount} paths:\n{/unpushableCount}{#unpushable}- {unpushable}\n{/unpushable}{#unpushableCount}Deliver once.{/unpushableCount}{#provider}Unexpected run{/provider}{#log}Unexpected log{/log}",
                }
              : {},
          }),
        }),
      },
    });
    await run.tick();
    const clone = run.clone("acme/widgets");
    const work = join(clone, ".sandcastle/worktrees/factory-issue-4");
    git(clone, ["worktree", "add", "--quiet", "-b", "factory/issue-4", work]);
    write(work, {
      ".github/workflows/new.yml": "changed\n",
      ".github/workflows/other.yml": "other\n",
    });
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
    assert.equal(
      run.github.find("acme/widgets", 4).comments[0],
      override
        ? "2 paths:\n- .github/workflows/new.yml\n- .github/workflows/other.yml\nDeliver once."
        : "The factory run failed: the run's branch changes paths the factory's GitHub App can't push.\n\n- Unpushable: `.github/workflows/new.yml`\n- Unpushable: `.github/workflows/other.yml`\n\nA person with permission to push these paths must deliver the change.\n\nRemove `factory:failed` to let the factory pick this issue up again.",
    );
  });

for (const published of ["absent", "deleted"])
  test(`an orphaned claim excludes work delivered to the refreshed default branch with its published branch ${published}`, async (t) => {
    const run = host(t, {
      repositories: { "acme/widgets": [{ number: 4, labels: [] }] },
      remotes: { "acme/widgets": remote(t, factoryFiles) },
    });
    await run.tick();
    const clone = run.clone("acme/widgets");
    const work = join(clone, ".sandcastle/worktrees/factory-issue-4");
    git(clone, ["worktree", "add", "--quiet", "-b", "factory/issue-4", work]);
    write(work, { ".github/workflows/delivered.yml": "delivered\n" });
    git(work, ["add", "."]);
    git(work, ["commit", "--quiet", "-m", "delivered workflow"]);
    git(work, ["push", "--quiet", "origin", "HEAD:main"]);
    if (published === "deleted") {
      git(work, ["push", "--quiet", "origin", "HEAD:factory/issue-4"]);
      git(work, ["push", "--quiet", "origin", "--delete", "factory/issue-4"]);
    }
    const issue = run.github.find("acme/widgets", 4);
    issue.labels = ["factory:running"];
    const [decision] = await run.restart().tick();
    assert.equal(decision.kind, "fail");
    assert.equal(
      decision.kind === "fail" && decision.failure,
      "no factory run or open pull request holds its claim, and its retry did not launch: it no longer carries ready-for-agent",
    );
    assert.doesNotMatch(issue.comments[0], /Unpushable|permission to push/);
    assert.equal(run.launched.length, 0);
  });

test("a failed claim without a run supplies empty run facts to its template", async (t) => {
  const run = host(t, {
    repositories: {
      "acme/widgets": [
        { number: 4, labels: ["factory:running"], pullRequests: ["MERGED"] },
      ],
    },
    remotes: {
      "acme/widgets": remote(t, {
        ...factoryFiles,
        ".factory/config.json": JSON.stringify({
          ...conventions,
          comments: {
            failure:
              "{failure}; {label}{#provider} provider={provider}{/provider}{#model} model={model}{/model}{#effort} effort={effort}{/effort}{#attempt} attempt={attempt}{/attempt}{#log} log={log}{/log}{#unpushable} path={unpushable}{/unpushable}{#unpushableCount} count={unpushableCount}{/unpushableCount}",
          },
        }),
      }),
    },
  });
  await run.tick();
  assert.deepEqual(run.github.find("acme/widgets", 4).comments, [
    "its pull request merged without closing the issue; close the issue if that finished it; factory:failed",
  ]);
});

test("closed claims release even with an open pull request while open merged work precedes needs input", async (t) => {
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
    { kind: "release", repository: "acme/widgets", issue: 4 },
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
  assert.deepEqual(run.github.find("acme/widgets", 4).labels, []);
  assert.deepEqual(run.github.find("acme/widgets", 5).labels, []);
  assert.deepEqual(run.github.find("acme/widgets", 6).labels, [
    "factory:needs-input",
    "factory:failed",
  ]);
  assert.equal(run.launched.length, 0);
});

test("an orphaned claim waits for a failed role lookup without a failure comment or losing its retry", async (t) => {
  const roles: Record<string, string | null | Error> = {
    owner: new PlatformError("unavailable", "GitHub answered with 502"),
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

for (const cause of ["usage limit", "pause threshold"] as const)
  test(`the pause template receives ${cause} facts and is delivered once across restart`, async (t) => {
    const run = host(t, {
      repositories: { "acme/widgets": [{ number: 4 }] },
      remotes: {
        "acme/widgets": remote(t, {
          ...factoryFiles,
          ".factory/config.json": JSON.stringify({
            ...conventions,
            comments: {
              pause:
                "{provider}/{model}@{effort} #{attempt}: {cause}{#reset} reset={reset}{/reset}{#threshold} threshold={threshold}{/threshold}; {label}",
            },
          }),
        }),
      },
      configuration: { usage: thresholds },
    });
    await run.tick();
    if (cause === "usage limit") {
      endOnLimit(run.launched[0]);
      run.launched[0].finish();
    } else {
      run.usage["claude-code"] = { used: 96, reset };
      await run.tick();
    }
    await settled();
    await until(() => recordOf(run.state, 4, 1).exited);
    await run.tick();
    const expected =
      cause === "usage limit"
        ? "claude-code/claude-sonnet-5-5@high #1: usage limit reset=12:50pm (UTC); factory:paused"
        : `claude-code/claude-sonnet-5-5@high #1: pause threshold reset=${reset} threshold=95; factory:paused`;
    assert.deepEqual(run.github.find("acme/widgets", 4).comments, [expected]);
    await run.restart().tick();
    assert.deepEqual(run.github.find("acme/widgets", 4).comments, [expected]);
  });

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
      "relaunch waits: claude-code hit its usage limit (resets 12:50pm (UTC)); usage 100% is at or above the 80% drain threshold",
    );
    assert.ok(
      run.reports.includes(
        "acme/widgets#4 skipped: relaunch waits: claude-code hit its usage limit (resets 12:50pm (UTC)); usage 100% is at or above the 80% drain threshold",
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
        "relaunch waits: claude-code hit its usage limit (resets 12:50pm (UTC)); usage 100% is at or above the 80% drain threshold",
    },
  ]);
  assert.deepEqual(issue.comments, [pauseComment]);
  assert.deepEqual(issue.labels, ["ready-for-agent", "factory:paused"]);
  // The high reading holds it until it expires, then the usage hold it
  // started before the restart holds it while usage is unknown, past the
  // pause's own deadline.
  run.usage["claude-code"] = null;
  await restarted.tick();
  assert.match(
    held(run, 4)!,
    /usage 100% is at or above the 80% drain threshold$/,
  );
  for (const time of ["2026-10-09T12:21:00Z", "2026-10-09T13:00:00Z"]) {
    run.clock.now = new Date(time);
    await restarted.tick();
    assert.match(
      held(run, 4)!,
      /usage is unknown, and its usage hold from 100% at 2026-10-09T12:00:00.000Z, at or above the 80% drain threshold, lasts until 2026-10-10T12:00:00.000Z at most$/,
    );
  }
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

// The owner's host: new claims stop at 90% and running runs at 95%.
const thresholds = {
  drainThreshold: 90,
  pauseThreshold: 95,
  afterDrain: "auto-resume",
} as const;
const reset = "2026-10-09T15:00:00.000Z";

function thresholdComment(model = "claude-code/claude-sonnet-5-5@high") {
  return [
    `The factory paused this run: claude-code pause threshold, resets ${reset}.`,
    "",
    `- Model: \`${model}\`, attempt 1`,
    "",
    "The factory resumes the run by itself and removes `factory:paused` when it does; nobody needs to act.",
  ].join("\n");
}

const nonSkips = (decisions: Decision[]) =>
  decisions.filter(({ kind }) => kind !== "skip");

test("at the pause threshold a provider's running sandboxes stop in every repository, and each run pauses once and resumes as the same attempt", async (t) => {
  const run = host(t, {
    repositories: {
      "acme/widgets": [{ number: 4 }],
      "acme/gadgets": [
        { number: 6 },
        { number: 7, labels: ["ready-for-agent", "model:gpt-5.5"] },
      ],
    },
    remotes: {
      "acme/widgets": remote(t, factoryFiles),
      "acme/gadgets": remote(t, factoryFiles),
    },
    configuration: { usage: thresholds },
  });
  await run.tick();
  assert.equal(run.launched.length, 3);
  const [widgets4, gadgets6, gadgets7] = [4, 6, 7].map((number) =>
    run.launched.find((launch) =>
      invocation(launch.options.prompt)?.endsWith(`#${number}`),
    )!,
  );

  // At the drain threshold the runs carry on.
  run.usage["claude-code"] = { used: 92, reset };
  run.usage.codex = 10;
  assert.deepEqual(nonSkips(await run.tick()), []);
  assert.equal(widgets4.options.signal!.aborted, false);

  run.clock.now = new Date("2026-10-09T12:10:00Z");
  run.usage["claude-code"] = { used: 96, reset };
  const pause = {
    cause: "pause threshold",
    reset,
    at: "2026-10-09T12:10:00.000Z",
    until: reset,
  };
  const reason = "claude-code usage 96% is at or above the 95% pause threshold";
  assert.deepEqual(nonSkips(await run.tick()), [
    { kind: "stop", repository: "acme/widgets", issue: 4, reason, pause },
    { kind: "stop", repository: "acme/gadgets", issue: 6, reason, pause },
  ]);
  assert.equal(widgets4.options.signal!.aborted, true);
  assert.equal(gadgets6.options.signal!.aborted, true);
  assert.equal(gadgets7.options.signal!.aborted, false);
  await settled();
  await until(() => recordOf(run.state, 4, 1).exited);
  assert.deepEqual(recordOf(run.state, 4, 1).ended, {
    paused: pause,
    commented: false,
  });

  const widgets = run.github.find("acme/widgets", 4);
  const gadgets = run.github.find("acme/gadgets", 6);
  await run.tick();
  await run.tick();
  for (const issue of [widgets, gadgets]) {
    assert.deepEqual(issue.comments, [thresholdComment()]);
    assert.deepEqual(issue.labels, ["ready-for-agent", "factory:paused"]);
  }
  const provider = run.status().providers[0];
  assert.equal(provider.running, 0);
  assert.equal(provider.paused, 2);
  assert.equal(provider.drained, true);
  const thresholdEvents = replay(run).filter(
    ({ type }) => type === "paused_at_threshold",
  );
  assert.equal(thresholdEvents.length, 1);
  assert.equal(thresholdEvents[0].state.running, 2);
  assert.equal(replay(run).at(-1)?.type, "drained");
  assert.equal(
    held(run, 4),
    `relaunch waits: claude-code reached its pause threshold (resets ${reset}); usage 96% is at or above the 95% pause threshold`,
  );
  // The drain threshold still holds it; a reading below it relaunches both.
  run.usage["claude-code"] = 92;
  const beforeRestart = replay(run);
  run.interrupt();
  const restarted = run.restart();
  await restarted.tick();
  assert.deepEqual(replay(run), beforeRestart);
  assert.match(
    held(run, 4)!,
    /usage 92% is at or above the 90% drain threshold$/,
  );
  run.usage["claude-code"] = 89;
  const launchedBefore = run.launched.length;
  const relaunched = launchesOf(await restarted.tick());
  assert.deepEqual(
    relaunched.map(({ repository, issue, attempt, relaunch }) => ({
      repository,
      issue,
      attempt,
      relaunch,
    })),
    [
      { repository: "acme/widgets", issue: 4, attempt: 1, relaunch: true },
      { repository: "acme/gadgets", issue: 6, attempt: 1, relaunch: true },
    ],
  );
  // Concurrent relaunches reach Sandcastle in either order.
  const resumedLaunches = run.launched.slice(launchedBefore);
  assert.equal(resumedLaunches.length, 2);
  const resumed = resumedLaunches.find(
    ({ options }) => options.name === "acme/widgets#4",
  )!;
  assert.equal(resumed.options.prompt, widgets4.options.prompt);
  assert.deepEqual(
    resumed.options.branchStrategy,
    widgets4.options.branchStrategy,
  );
  assert.deepEqual(widgets.labels, ["ready-for-agent", "factory:running"]);
  assert.equal(widgets.comments.length, 1);
  assert.equal(run.status().providers[0].paused, 0);
  assert.equal(run.status().providers[0].running, 2);
  assert.equal(run.status().providers[0].claimsHeld, false);
  assert.equal(
    replay(run).filter(({ type }) => type === "paused_at_threshold").length,
    1,
  );
  assert.equal(replay(run).at(-1)?.type, "resumed");
});

function launchesOf(decisions: Decision[]) {
  return decisions.filter(
    (decision): decision is Decision & { kind: "launch" } =>
      decision.kind === "launch",
  );
}

for (const ending of [
  "exits after the stop",
  "exits on its usage limit after the stop",
  "is interrupted by a stop signal",
  "outlives a crashed process",
])
  test(`a run stopping at the pause threshold that ${ending} pauses once for that cause`, async (t) => {
    const run = host(t, {
      repositories: { "acme/widgets": [{ number: 4 }] },
      remotes: { "acme/widgets": remote(t, factoryFiles) },
      configuration: { usage: thresholds },
    });
    await run.tick();
    const [launch] = run.launched;
    run.sandcastle.ignoreAborts = true;
    run.usage["claude-code"] = { used: 97, reset };
    const stop = (await run.tick()).find(({ kind }) => kind === "stop");
    assert.equal(
      stop?.kind === "stop" && stop.pause?.at,
      "2026-10-09T12:00:00.000Z",
    );
    // A later pass repeats the stop, which keeps the first pause.
    run.clock.now = new Date("2026-10-09T12:05:00Z");
    assert.equal((await run.tick())[0].kind, "stop");
    const pausing = recordOf(run.state, 4, 1).pausing;
    assert.deepEqual(pausing, {
      cause: "pause threshold",
      reset,
      at: "2026-10-09T12:00:00.000Z",
      until: reset,
    });
    let tick = run.tick;
    if (ending.startsWith("exits")) {
      if (ending.includes("usage limit")) endOnLimit(launch);
      launch.finish(
        ending.includes("usage limit")
          ? new Error("claude-code exited with code 1")
          : undefined,
      );
      await settled();
      await until(() => recordOf(run.state, 4, 1).exited);
    } else if (ending.includes("stop signal")) {
      run.interrupt();
      assert.equal(recordOf(run.state, 4, 1).interrupted, false);
      tick = run.restart().tick;
    } else tick = run.restart().tick;
    assert.deepEqual(nonSkips(await tick()), [
      {
        kind: "pause",
        repository: "acme/widgets",
        issue: 4,
        pause: pausing,
      },
    ]);
    await tick();
    const issue = run.github.find("acme/widgets", 4);
    assert.deepEqual(issue.comments, [thresholdComment()]);
    assert.deepEqual(issue.labels, ["ready-for-agent", "factory:paused"]);
    // Once told, a restart tells it no more.
    await run.restart().tick();
    assert.deepEqual(issue.comments, [thresholdComment()]);
    assert.equal(run.launched.length, 1);
  });

test("a run that exits before the pause threshold's stop settles as it ended", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
    configuration: { usage: thresholds },
  });
  await run.tick();
  run.github.find("acme/widgets", 4).pullRequests.push("OPEN");
  run.launched[0].finish();
  await settled();
  await until(() => recordOf(run.state, 4, 1).exited);
  run.usage["claude-code"] = 99;
  assert.deepEqual(nonSkips(await run.tick()), [
    { kind: "keep", repository: "acme/widgets", issue: 4 },
  ]);
  assert.equal(recordOf(run.state, 4, 1).pausing, null);
  const comments = run.github.find("acme/widgets", 4).comments;
  assert.equal(comments.length, 1);
  assert.match(comments[0], /agent run has ended/);
  assert.doesNotMatch(comments[0], /paused this run/);
});

test("a usage hold stops new claims through unknown usage and a restart until its deadline", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
    configuration: { usage: thresholds },
    usage: { "claude-code": { used: 92, reset: "2026-10-09T13:00:00.000Z" } },
  });
  assert.equal(
    (await run.tick())[0].kind === "skip" && held(run, 4),
    "claude-code usage 92% is at or above the 90% drain threshold",
  );
  run.usage["claude-code"] = new UsageReadError("refused", { status: 403 });
  run.clock.now = new Date("2026-10-09T12:30:00Z");
  await run.tick();
  const holding =
    "claude-code usage is unknown, and its usage hold from 92% at 2026-10-09T12:00:00.000Z, at or above the 90% drain threshold, lasts until 2026-10-09T13:00:00.000Z at most";
  assert.equal(held(run, 4), holding);
  const restarted = run.restart();
  run.clock.now = new Date("2026-10-09T12:59:59.999Z");
  await restarted.tick();
  assert.equal(held(run, 4), holding);
  assert.equal(run.launched.length, 0);
  // The read backoff runs to 13:30, but the hold ends at its own deadline.
  run.clock.now = new Date("2026-10-09T13:00:00Z");
  assert.equal(launchesOf(await restarted.tick()).length, 1);
  assert.deepEqual(run.github.find("acme/widgets", 4).labels, [
    "ready-for-agent",
    "factory:running",
  ]);
});

// The owner's `resume` command, run as its own process against the host
// configuration the fixture's host runs with.
function resumeCommand(run: ReturnType<typeof host>, ...args: string[]) {
  const path = join(dirname(run.state), "host.json");
  writeFileSync(path, JSON.stringify(run.configuration));
  return execFileSync(
    process.execPath,
    [join(import.meta.dirname, "../src/main.ts"), "resume", path, ...args],
    { encoding: "utf8" },
  );
}

const ownerResume = { ...thresholds, afterDrain: "owner-resume" } as const;

test("an owner hold keeps a drained provider's new claims through low usage and a restart until the owner's resume command, and its next pass applies it", async (t) => {
  const run = host(t, {
    repositories: {
      "acme/widgets": [
        { number: 4 },
        { number: 5, labels: ["ready-for-agent", "model:gpt-5.5"] },
      ],
    },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
    configuration: { usage: ownerResume },
    usage: { "claude-code": 92, codex: 10 },
  });
  await run.tick();
  const hold =
    "claude-code has an owner hold from 92% at 2026-10-09T12:00:00.000Z; only the owner's resume request lifts it";
  assert.equal(held(run, 4), hold);
  // The other provider keeps claiming.
  assert.equal(run.launched.length, 1);
  run.usage["claude-code"] = 10;
  run.clock.now = new Date("2026-10-09T12:05:00Z");
  await run.tick();
  assert.equal(held(run, 4), hold);
  run.interrupt();
  const restarted = run.restart();
  run.usage["claude-code"] = null;
  await restarted.tick();
  assert.equal(held(run, 4), hold);

  const output = resumeCommand(run, "claude-code");
  const id =
    /^Queued resume request (\S+) to lift claude-code's owner hold\./.exec(
      output,
    )?.[1];
  assert.ok(id, output);
  run.usage["claude-code"] = 10;
  assert.equal(launchesOf(await restarted.tick())[0]?.issue, 4);
  assert.ok(
    run.reports.includes(
      `resume request ${id} applied: lifted claude-code's owner hold from 92% at 2026-10-09T12:00:00.000Z`,
    ),
    run.reports.join("\n"),
  );
});

test("a paused run relaunches below the drain threshold despite its provider's owner hold", async (t) => {
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }, { number: 5 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
    configuration: { usage: ownerResume },
    caps: { "claude-code": 1, codex: 1 },
  });
  await run.tick();
  assert.equal(run.launched.length, 1);
  run.usage["claude-code"] = { used: 96, reset };
  assert.equal((await run.tick())[0].kind, "stop");
  await settled();
  await until(() => recordOf(run.state, 4, 1).exited);
  await run.tick();
  run.usage["claude-code"] = 92;
  run.clock.now = new Date("2026-10-09T12:10:00Z");
  await run.tick();
  assert.match(
    held(run, 4)!,
    /usage 92% is at or above the 90% drain threshold$/,
  );
  run.usage["claude-code"] = 89;
  run.clock.now = new Date("2026-10-09T12:20:00Z");
  const decisions = await run.tick();
  assert.deepEqual(
    launchesOf(decisions).map(({ issue, relaunch }) => ({ issue, relaunch })),
    [{ issue: 4, relaunch: true }],
  );
  assert.match(held(run, 5)!, /^claude-code has an owner hold from 96% at /);
});

test("the owner's resume command with a drain threshold opens claims up to the raise, and a reading below the configured drain threshold ends it", async (t) => {
  const run = host(t, {
    repositories: {
      "acme/widgets": [{ number: 4 }, { number: 5 }, { number: 6 }],
    },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
    configuration: { usage: ownerResume },
    caps: { "claude-code": 1, codex: 1 },
    usage: { "claude-code": { used: 92, reset } },
  });
  await run.tick();
  assert.throws(
    () => resumeCommand(run, "claude-code", "--drain-threshold", "96"),
    (error: { status: number; stderr: string }) =>
      error.status === 1 &&
      error.stderr ===
        "The resume request was not queued: the drain threshold can be raised only above its configured 90%, up to the 95% pause threshold\n",
  );
  assert.match(
    resumeCommand(run, "claude-code", "--drain-threshold", "94"),
    /to lift claude-code's owner hold and raise its drain threshold once to 94%\. The running factory applies it on its next pass, within 300 seconds of its current one/,
  );
  run.clock.now = new Date("2026-10-09T12:05:00Z");
  assert.deepEqual(
    launchesOf(await run.tick()).map(({ issue }) => issue),
    [4],
  );
  // Its run awaits merge, which takes no cap slot.
  run.github.find("acme/widgets", 4).pullRequests.push("OPEN");
  run.launched[0].finish();
  await settled();
  await until(() => recordOf(run.state, 4, 1).exited);
  // A restart keeps the raise, and reaching it holds claims again, with a
  // new owner hold.
  const restarted = run.restart();
  run.usage["claude-code"] = { used: 94, reset };
  run.clock.now = new Date("2026-10-09T12:10:00Z");
  await restarted.tick();
  assert.equal(
    held(run, 5),
    "claude-code has an owner hold from 94% at 2026-10-09T12:10:00.000Z; only the owner's resume request lifts it",
  );
  // A plain release meets the raised drain threshold, and once usage reads
  // below the configured one the raise ends and claims reopen.
  resumeCommand(run, "claude-code");
  await restarted.tick();
  assert.equal(
    held(run, 5),
    "claude-code usage 94% is at or above the 94% drain threshold, which the owner raised once from 90%",
  );
  run.usage["claude-code"] = 89;
  run.clock.now = new Date("2026-10-09T12:15:00Z");
  assert.deepEqual(
    launchesOf(await restarted.tick()).map(({ issue }) => issue),
    [5],
  );
  assert.ok(
    run.reports.includes(
      "claude-code's reserve raise to 94% ended: usage 89% is below the configured 90% drain threshold; its configured drain threshold applies again",
    ),
  );
});

for (const configured of [false, true])
  test(`closed issues clear active markers after restart with ${configured ? "repository-specific" : "default"} labels`, async (t) => {
    const labels = configured
      ? {
          ...conventions.labels,
          running: "worker:active",
          needsInput: "worker:question",
          paused: "worker:paused",
        }
      : conventions.labels;
    const unrelated = [
      labels.ready,
      labels.failed,
      "model:gpt-6.1-sol",
      "factory:skip",
    ];
    const run = host(t, {
      repositories: {
        "acme/widgets": [
          {
            number: 1,
            state: "CLOSED",
            labels: [...unrelated, labels.running],
          },
          {
            number: 2,
            state: "CLOSED",
            labels: [...unrelated, labels.needsInput],
          },
          {
            number: 3,
            state: "CLOSED",
            labels: [
              ...unrelated,
              labels.running,
              labels.needsInput,
              labels.paused,
            ],
            pullRequests: ["OPEN"],
          },
          { number: 4, state: "CLOSED", labels: [...unrelated, labels.paused] },
          { number: 5, labels: [labels.ready, labels.needsInput] },
          {
            number: 6,
            labels: [labels.ready, labels.running],
            pullRequests: ["OPEN"],
          },
        ],
      },
      remotes: {
        "acme/widgets": remote(t, {
          ...factoryFiles,
          ".factory/config.json": JSON.stringify({ ...conventions, labels }),
        }),
      },
    });
    const restarted = run.restart();
    await restarted.tick();
    for (const number of [1, 2, 3, 4]) {
      const issue = run.github.find("acme/widgets", number);
      assert.deepEqual(issue.labels, unrelated);
      assert.deepEqual(issue.comments, []);
    }
    await restarted.tick();
    assert.deepEqual(run.github.find("acme/widgets", 5).labels, [
      labels.ready,
      labels.needsInput,
    ]);
    assert.deepEqual(run.github.find("acme/widgets", 6).labels, [
      labels.ready,
      labels.running,
    ]);
    assert.equal(run.launched.length, 0);
  });

test("a failed closed-issue label removal is rediscovered after restart without a running marker", async (t) => {
  const run = host(t, {
    repositories: {
      "acme/widgets": [
        {
          number: 4,
          state: "CLOSED",
          labels: [
            "factory:running",
            "factory:paused",
            "factory:needs-input",
            "factory:failed",
          ],
        },
      ],
    },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
  });
  const failure = "acme/widgets#4 factory:needs-input";
  run.github.failedRemovals.set(
    failure,
    new PlatformError("unavailable", "temporary label write failure"),
  );
  await run.tick();
  assert.deepEqual(run.github.find("acme/widgets", 4).labels, [
    "factory:needs-input",
    "factory:failed",
  ]);
  assert.ok(
    run.reports.some((line) => line.includes("temporary label write failure")),
  );
  run.github.failedRemovals.delete(failure);
  const restarted = run.restart();
  await restarted.tick();
  await restarted.tick();
  assert.deepEqual(run.github.find("acme/widgets", 4).labels, [
    "factory:failed",
  ]);
  assert.deepEqual(run.github.find("acme/widgets", 4).comments, []);
  assert.equal(run.launched.length, 0);
});

for (const state of ["live", "ended", "awaiting merge", "paused", "restarted"])
  for (const closure of ["merged", "external"])
    test(`${closure} closure clears labels for a ${state} run`, async (t) => {
      const run = host(t, {
        repositories: { "acme/widgets": [{ number: 4 }] },
        remotes: { "acme/widgets": remote(t, factoryFiles) },
      });
      await run.tick();
      const issue = run.github.find("acme/widgets", 4);
      issue.pullRequests = ["OPEN"];
      if (state !== "live") {
        if (state === "paused") endOnLimit(run.launched[0]);
        run.launched[0].finish();
        await settled();
        if (state !== "ended") await run.tick();
      }
      issue.labels.push("factory:needs-input");
      issue.state = "CLOSED";
      if (closure === "merged") issue.pullRequests = ["MERGED"];
      const active = state === "restarted" ? run.restart() : run;
      const comments = [...issue.comments];
      await active.tick();
      assert.deepEqual(issue.labels, ["ready-for-agent"]);
      assert.deepEqual(issue.comments, comments);
      if (state === "live") {
        run.launched[0].finish();
        await settled();
        await active.tick();
      }
      assert.equal(recordOf(run.state, 4, 1).settled, true);
      await active.tick();
      assert.deepEqual(issue.labels, ["ready-for-agent"]);
      assert.equal(run.launched.length, 1);
    });

test("storage holds admit no new tickets, preserve retries and provider state, and let existing runs settle", async (t) => {
  const storage: ImageStorageStatus = {
    held: true,
    reason: "recover the image store",
    observedAt: "2026-10-29T14:00:00Z",
    reserveBytes: 16106127360,
    resumeBytes: 18253611008,
    filesystems: [
      {
        paths: ["/actual/containerd"],
        filesystem: "device:7",
        availableBytes: 100,
      },
    ],
    reclamation: { pressure: true, freed: null, error: null },
  };
  const failures = [
    null,
    new ImageStorageHold(storage),
    new ImageStorageHold(storage),
    null,
  ];
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }, { number: 5 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
    caps: { "claude-code": 1, codex: 1 },
    imageFailures: failures,
    storage,
  });
  await run.tick();
  const before = run.status().providers;
  // The first run is still running when pressure arrives.
  await run.tick();
  assert.equal(run.launched.length, 1);
  assert.equal(run.launched[0].removed, false);
  assert.deepEqual(run.status().providers, before);
  assert.deepEqual(run.status().imageStorage, storage);
  assert.match(
    run.status().repositories[0].reason,
    /^sandbox image builds wait for storage:/,
  );
  assert.deepEqual(run.github.find("acme/widgets", 5).labels, [
    "ready-for-agent",
  ]);
  assert.deepEqual(run.github.find("acme/widgets", 5).comments, []);
  // Closing the already-running ticket lets it settle during the hold.
  run.github.find("acme/widgets", 4).state = "CLOSED";
  run.launched[0].finish();
  await settled();
  await run.tick();
  assert.equal(run.launched.length, 1);
  assert.equal(
    run.github.find("acme/widgets", 4).labels.includes("factory:running"),
    false,
  );
  assert.equal(
    run.github.find("acme/widgets", 4).labels.includes("factory:failed"),
    false,
  );
  await run.tick();
  assert.equal(run.launched.length, 2);
  assert.equal(run.launched[1].options.name, "acme/widgets#5");
  assert.equal(run.launched[1].options.agent.name, "claude-code");
});

test("a storage-held retry remains attempt two when storage recovers", async (t) => {
  const hold = new ImageStorageHold({
    held: true,
    reason: "low storage",
    observedAt: "2026-10-29T14:00:00Z",
    reserveBytes: 15,
    resumeBytes: 17,
    filesystems: [],
    reclamation: { pressure: true, freed: null, error: null },
  });
  const run = host(t, {
    repositories: { "acme/widgets": [{ number: 4 }] },
    remotes: { "acme/widgets": remote(t, factoryFiles) },
    imageFailures: [null, hold, hold, null],
  });
  await run.tick();
  run.launched[0].finish(new Error("agent crashed"));
  await settled();
  await run.tick();
  await run.tick();
  assert.equal(run.launched.length, 1);
  assert.deepEqual(run.github.find("acme/widgets", 4).labels.sort(), [
    "factory:running",
    "ready-for-agent",
  ]);
  assert.deepEqual(run.github.find("acme/widgets", 4).comments, []);
  await run.tick();
  assert.equal(run.launched.length, 2);
  assert.equal(run.launched[1].options.agent.name, "codex");
  assert.match(run.launched[1].options.prompt!, /First attempt failure/);
});
