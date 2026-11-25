import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { connect, type IssueEvent } from "@lutzseverino/postern";
import {
  checkContainer,
  createRunner,
  entryPointEnvironment,
  entryPoints,
  runEntryPoint,
  type EntryPointRequest,
  type EntryPointResult,
} from "../src/runner.ts";
import { githubRunnerReads } from "../src/runner-github.ts";
import { directTicket } from "./contract-fixture.ts";
import { runnerWorld } from "./runner-world.ts";

const repository = "acme/widgets";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.test",
    },
  });
}

function write(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

const defaultBranch = {
  ".scriptorium/config.json": JSON.stringify({
    version: 3,
    labels: {
      ready: "state:ready",
      running: "factory:running",
      paused: "factory:paused",
      failed: "factory:failed",
    },
    contractResult: {
      marker: "repo-canon:issue-contract-state",
      author: "runner[bot]",
    },
    modelLabelPrefix: "model:",
    checkCommand: "pnpm validate",
    runKinds: { implement: { skill: "implement", arguments: "#{issue}" } },
  }),
  [entryPoints.validate]: "// the default branch's validator\n",
  [entryPoints.sandboxImage]: "// the default branch's image build\n",
};

type Run = EntryPointRequest & {
  input?: Record<string, any>;
  source: string;
  head?: string;
};

// A runner over a real Git remote and clone, whose reads go through
// Postern's GitHub adapter to the world, and whose entry points are recorded
// as they would run: the input each read and the pinned source it loaded.
function setup(
  t: TestContext,
  {
    files = {},
    respond = async () => ({ code: 0, output: "" }),
    validator = "runner[bot]",
  }: {
    files?: Record<string, string>;
    respond?: (
      run: Run,
      world: ReturnType<typeof runnerWorld>,
    ) => Promise<EntryPointResult>;
    // The runner account, which the repository names as its validator.
    validator?: string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  git(root, ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  git(root, ["init", "--quiet", "--initial-branch=main", work]);
  write(work, { ...defaultBranch, ...files });
  git(work, ["add", "."]);
  git(work, ["commit", "--quiet", "-m", "base"]);
  git(work, ["push", "--quiet", remote, "main"]);
  const clone = join(root, "clone");
  git(root, ["clone", "--quiet", remote, clone]);
  const world = runnerWorld();
  const runs: Run[] = [];
  const reports: string[] = [];
  // The containers removed, in order.
  const removed: string[] = [];
  const pending = new Set<Promise<void>>();
  const state = { token: async () => "runner-token" as string };
  const runner = (repositories = [repository]) =>
    createRunner({
      stateDirectory: join(root, "state"),
      repositories,
      git: () => async (cwd, args) => git(cwd, args),
      remoteUrl: () => remote,
      token: () => state.token(),
      async run(request) {
        const run: Run = {
          ...request,
          source: readFileSync(request.script, "utf8"),
          ...(request.script.endsWith(entryPoints.validate) && {
            input: JSON.parse(readFileSync(request.args[0]!, "utf8")),
          }),
        };
        const checkout =
          run.input?.kind === "check-command" ? run.input.checkout : run.cwd;
        if (existsSync(join(checkout, ".git")))
          run.head = git(checkout, ["rev-parse", "HEAD"]).trim();
        runs.push(run);
        return respond(run, world);
      },
      async removeContainer(name) {
        removed.push(name);
      },
      timeoutMs: 60_000,
      now: world.now,
      report: (line) => reports.push(line),
      track(work) {
        pending.add(work);
        void work.finally(() => pending.delete(work));
      },
    });
  let instance = runner();
  const reads = githubRunnerReads(
    connect(`https://github.com/${repository}`, {
      credential: "factory-token",
      fetch: world.fetchAs("factory[bot]"),
    }),
  );
  const drain = async () => {
    while (pending.size) await Promise.all(pending);
  };
  return {
    root,
    world,
    runs,
    reports,
    removed,
    state,
    get runner() {
      return instance;
    },
    restart(repositories?: string[]) {
      instance = runner(repositories);
    },
    drain,
    // One pass: the host's clone follows the default branch first.
    async pass(image: string | null = "factory-sandbox:test") {
      git(clone, ["fetch", "--quiet", "origin"]);
      git(clone, ["reset", "--quiet", "--hard", "origin/main"]);
      await instance.observe(repository, reads, {
        clone,
        commit: git(clone, ["rev-parse", "HEAD"]).trim(),
        image,
        validator,
      });
      await drain();
      world.wait(60);
    },
    // A commit on a branch of the remote, resolving its SHA.
    commit(branch: string, content: Record<string, string>) {
      git(work, ["checkout", "--quiet", "-B", branch, "main"]);
      write(work, content);
      git(work, ["add", "."]);
      git(work, ["commit", "--quiet", "-m", branch]);
      git(work, ["push", "--quiet", "--force", remote, branch]);
      const sha = git(work, ["rev-parse", "HEAD"]).trim();
      git(work, ["checkout", "--quiet", "main"]);
      return sha;
    },
    main: () => git(work, ["rev-parse", "main"]).trim(),
    // Advances the default branch.
    advance(content: Record<string, string>) {
      write(work, content);
      git(work, ["add", "."]);
      git(work, ["commit", "--quiet", "-m", "advance"]);
      git(work, ["push", "--quiet", remote, "main"]);
      return git(work, ["rev-parse", "HEAD"]).trim();
    },
  };
}

const events = (runs: Run[]): IssueEvent[] =>
  runs.flatMap((run) =>
    run.input?.kind === "issue-contract" ? [run.input.event] : [],
  );
const kinds = (runs: Run[]) =>
  runs.map((run) =>
    run.input
      ? run.input.kind === "issue-contract"
        ? `contract #${run.input.event.issue} ${run.input.event.kind}`
        : `${run.input.kind} #${run.input.pullRequest ?? run.input.head}`
      : `image ${run.args[1]}`,
  );

test("the first pass delivers no history and catches up once on open issues and pull requests", async (t) => {
  const s = setup(t);
  const open = s.world.openIssue({ labels: ["state:triage"] });
  s.world.comment(open.number, "An old comment.", "reporter");
  s.world.label(open.number, "state:ready", "maintainer");
  const closed = s.world.openIssue();
  s.world.close(closed.number, "maintainer");
  const head = s.commit("feature", { "feature.txt": "1" });
  const same = s.world.openPull({ head, base: s.main() });
  s.world.comment(same.number, "A pull request comment.", "reporter");
  const fork = s.world.openPull({
    head: "f".repeat(40),
    base: s.main(),
    crossRepository: true,
  });

  await s.pass();
  assert.deepEqual(kinds(s.runs).sort(), [
    `check-command #${head}`,
    `contract #${open.number} edited`,
    `image ${head}`,
    `pr-metadata #${same.number}`,
    `pr-metadata #${fork.number}`,
  ]);
  const [request] = events(s.runs);
  assert.deepEqual(request, {
    platform: "github",
    repository,
    issue: open.number,
    kind: "edited",
    actor: { login: "factory[bot]", bot: true },
    label: null,
    openingLabels: null,
    bodyChanged: null,
    comment: null,
  });

  // Nothing changed: nothing is delivered again.
  s.runs.length = 0;
  await s.pass();
  assert.deepEqual(s.runs, []);

  // Turning the runner flag off and on again catches up once more.
  s.runner.disable(repository);
  await s.pass();
  assert.equal(s.runs.length, 5);
  s.runs.length = 0;
  await s.pass();
  assert.deepEqual(s.runs, []);

  // So does a host that stopped naming the repository while it was down.
  s.restart([]);
  s.restart();
  await s.pass();
  assert.equal(s.runs.length, 5);
});

test("each recorded issue and comment event is delivered with its own fields, in order", async (t) => {
  const s = setup(t);
  const issue = s.world.openIssue({ labels: ["state:triage"] });
  const old = s.world.comment(
    issue.number,
    "Copied at enablement.",
    "reporter",
  );
  await s.pass();
  s.runs.length = 0;

  const opened = s.world.openIssue({
    author: "reporter",
    labels: ["state:triage"],
  });
  s.world.label(issue.number, "state:ready", "maintainer");
  s.world.unlabel(issue.number, "state:triage", "maintainer");
  s.world.editBody(issue.number, "Revised.", "reporter");
  s.world.rename(issue.number, "Renamed", "reporter");
  const created = s.world.comment(issue.number, "First.", "reporter");
  s.world.editComment(issue.number, old.id, "Edited.", "maintainer");
  s.world.deleteComment(issue.number, created.id, "reporter");
  const kept = s.world.comment(issue.number, "Second.", "reporter");
  s.world.close(issue.number, "maintainer");
  s.world.reopen(issue.number, "maintainer");
  await s.pass();

  const delivered = events(s.runs).map((event) => ({
    issue: event.issue,
    kind: event.kind,
    actor: event.actor.login,
    label: event.label,
    openingLabels: event.openingLabels,
    bodyChanged: event.bodyChanged,
    comment: event.comment?.body ?? null,
  }));
  const none = {
    label: null,
    openingLabels: null,
    bodyChanged: null,
    comment: null,
  };
  assert.deepEqual(delivered, [
    {
      ...none,
      issue: opened.number,
      kind: "opened",
      actor: "reporter",
      openingLabels: ["state:triage"],
    },
    {
      ...none,
      issue: opened.number,
      kind: "labeled",
      actor: "reporter",
      label: "state:triage",
    },
    {
      ...none,
      issue: issue.number,
      kind: "labeled",
      actor: "maintainer",
      label: "state:ready",
    },
    {
      ...none,
      issue: issue.number,
      kind: "unlabeled",
      actor: "maintainer",
      label: "state:triage",
    },
    {
      ...none,
      issue: issue.number,
      kind: "edited",
      actor: "reporter",
      bodyChanged: true,
    },
    {
      ...none,
      issue: issue.number,
      kind: "edited",
      actor: "reporter",
      bodyChanged: false,
    },
    {
      ...none,
      issue: issue.number,
      kind: "commentEdited",
      actor: "maintainer",
      comment: "Edited.",
    },
    {
      ...none,
      issue: issue.number,
      kind: "commentCreated",
      actor: "reporter",
      comment: "Second.",
    },
    { ...none, issue: issue.number, kind: "closed", actor: "maintainer" },
    { ...none, issue: issue.number, kind: "reopened", actor: "maintainer" },
  ]);
  const comment = events(s.runs).find(
    (event) => event.kind === "commentCreated",
  )!.comment;
  assert.deepEqual(comment, {
    id: kept.id,
    nodeId: `IC_${kept.id}`,
    body: "Second.",
  });

  // The overlap rereads them; none is delivered twice.
  s.runs.length = 0;
  await s.pass();
  assert.deepEqual(s.runs, []);

  // A deletion carries the stored copy, even of a comment edited and then
  // deleted between passes; a comment created and deleted unseen is never
  // delivered.
  s.world.editComment(issue.number, kept.id, "Unseen edit.", "reporter");
  s.world.deleteComment(issue.number, kept.id, "maintainer");
  const unseen = s.world.comment(issue.number, "Unseen.", "reporter");
  s.world.deleteComment(issue.number, unseen.id, "reporter");
  await s.pass();
  assert.deepEqual(events(s.runs), [
    {
      platform: "github",
      repository,
      issue: issue.number,
      kind: "commentDeleted",
      actor: { login: "maintainer", bot: false },
      label: null,
      openingLabels: null,
      bodyChanged: null,
      comment: { id: kept.id, nodeId: `IC_${kept.id}`, body: "Second." },
    },
  ]);
});

test("pull request comments and events reach no issue-contract run", async (t) => {
  const s = setup(t);
  const head = s.commit("feature", { "feature.txt": "1" });
  const pull = s.world.openPull({ head, base: s.main() });
  const comment = s.world.comment(pull.number, "Before.", "reporter");
  await s.pass();
  s.runs.length = 0;
  s.world.comment(pull.number, "Created.", "reporter");
  s.world.editComment(pull.number, comment.id, "Edited.", "reporter");
  s.world.deleteComment(pull.number, comment.id, "reporter");
  s.world.label(pull.number, "state:ready", "maintainer");
  await s.pass();
  assert.deepEqual(events(s.runs), []);
});

test("the validator's own writes are observed but not delivered again", async (t) => {
  const s = setup(t);
  const issue = s.world.openIssue();
  await s.pass();
  s.runs.length = 0;
  const notice = s.world.comment(issue.number, "Notice.", "runner[bot]");
  s.world.unlabel(issue.number, "state:ready", "runner[bot]");
  s.world.label(issue.number, "state:triage", "runner[bot]");
  s.world.editComment(
    issue.number,
    notice.id,
    "Notice, revised.",
    "runner[bot]",
  );
  s.world.comment(issue.number, "A person's reply.", "reporter");
  await s.pass();
  assert.deepEqual(
    events(s.runs).map((event) => [event.kind, event.actor.login]),
    [["commentCreated", "reporter"]],
  );
});

test("the cursor, comment copies and waiting deliveries survive a restart", async (t) => {
  const s = setup(t);
  const issue = s.world.openIssue();
  const copied = s.world.comment(issue.number, "Copied.", "reporter");
  await s.pass();
  s.runs.length = 0;

  // A delivery whose preparation fails waits in its lane.
  s.state.token = async () => {
    throw new Error("the token command failed");
  };
  s.world.label(issue.number, "state:ready", "maintainer");
  await s.pass();
  assert.deepEqual(s.runs, []);
  assert.match(s.reports.at(-1)!, /waits for a later pass/);

  s.restart();
  s.state.token = async () => "runner-token";
  s.world.deleteComment(issue.number, copied.id, "reporter");
  await s.pass();
  assert.deepEqual(
    events(s.runs).map((event) => [
      event.kind,
      event.comment?.body ?? event.label,
    ]),
    [
      ["labeled", "state:ready"],
      ["commentDeleted", "Copied."],
    ],
  );
});

test("a delivery whose preparation keeps failing is never dropped, but a head's ends once its pull request moves on", async (t) => {
  const s = setup(t);
  const issue = s.world.openIssue();
  const first = s.commit("feature", { "feature.txt": "1" });
  const pull = s.world.openPull({ head: first, base: s.main() });
  await s.pass();
  s.runs.length = 0;

  s.state.token = async () => {
    throw new Error("the token command failed");
  };
  s.world.label(issue.number, "state:ready", "maintainer");
  const second = s.commit("feature", { "feature.txt": "2" });
  s.world.push(pull.number, second);
  for (let pass = 0; pass < 5; pass++) await s.pass();
  assert.deepEqual(s.runs, []);
  assert.doesNotMatch(s.reports.join("\n"), /dropped|ended/);

  // A later head ends the waiting head's delivery at its next attempt.
  const third = s.commit("feature", { "feature.txt": "3" });
  s.world.push(pull.number, third);
  await s.pass();
  assert.match(
    s.reports.join("\n"),
    new RegExp(`#${pull.number} at ${second} ended`),
  );

  s.state.token = async () => "runner-token";
  await s.pass();
  assert.deepEqual(kinds(s.runs).sort(), [
    `check-command #${third}`,
    `contract #${issue.number} labeled`,
    `image ${third}`,
    `pr-metadata #${pull.number}`,
    `pr-metadata #${pull.number}`,
  ]);
});

test("a pinned checkout a failed preparation used is still retired", async (t) => {
  const s = setup(t);
  const issue = s.world.openIssue();
  await s.pass();
  const runner = join(s.root, "state", "repositories", repository, "runner");
  // The inputs directory cannot be created.
  rmSync(join(runner, "inputs"), { recursive: true, force: true });
  writeFileSync(join(runner, "inputs"), "");
  s.world.label(issue.number, "state:ready", "maintainer");
  await s.pass();
  assert.match(s.reports.at(-1)!, /waits for a later pass/);

  rmSync(join(runner, "inputs"));
  const after = s.advance({ "next.txt": "1" });
  s.runs.length = 0;
  await s.pass();
  assert.deepEqual(kinds(s.runs), [`contract #${issue.number} labeled`]);
  assert.deepEqual(readdirSync(join(runner, "trusted")), [after]);
});

test("an issue observed for the first time delivers the edit of an older comment", async (t) => {
  const s = setup(t);
  const issue = s.world.openIssue();
  const old = s.world.comment(issue.number, "Before.", "reporter");
  s.world.close(issue.number, "maintainer");
  await s.pass();
  s.runs.length = 0;

  s.world.editComment(issue.number, old.id, "After.", "maintainer");
  await s.pass();
  assert.deepEqual(
    events(s.runs).map((event) => [
      event.kind,
      event.actor.login,
      event.comment?.body,
    ]),
    [["commentEdited", "maintainer", "After."]],
  );
  s.runs.length = 0;
  await s.pass();
  assert.deepEqual(s.runs, []);
});

test("runs for one issue never overlap, merge or cancel one another", async (t) => {
  let release!: () => void;
  let running = 0;
  let most = 0;
  const s = setup(t, {
    async respond(run) {
      running++;
      most = Math.max(most, running);
      if (run.input?.event?.label === "first")
        await new Promise<void>((resolve) => (release = resolve));
      running--;
      return { code: 0, output: "" };
    },
  });
  const issue = s.world.openIssue();
  await s.pass();
  s.runs.length = 0;
  s.world.label(issue.number, "first", "maintainer");
  s.world.label(issue.number, "second", "maintainer");
  // The first pass's lane is still running its first delivery when the next
  // pass observes more.
  const reads = s.pass();
  await new Promise((resolve) => setTimeout(resolve, 50));
  s.world.label(issue.number, "third", "maintainer");
  s.runner.request(repository, issue.number);
  s.runner.request(repository, issue.number);
  release();
  await reads;
  await s.pass();
  assert.equal(most, 1);
  // A repeated request still waiting in the lane is the same request.
  assert.deepEqual(
    events(s.runs).map((event) => event.label ?? event.kind),
    ["first", "second", "edited", "third"],
  );
});

test("pull request events run the metadata entry point, and each observed head its image build and check", async (t) => {
  const s = setup(t);
  await s.pass();
  const first = s.commit("feature", { "feature.txt": "1" });
  const pull = s.world.openPull({ head: first, base: s.main(), draft: true });
  await s.pass();
  // The metadata and head lanes run apart; a head's image build comes first.
  const heads = (runs: Run[]) =>
    kinds(runs.filter((run) => run.input?.kind !== "pr-metadata"));
  assert.deepEqual(heads(s.runs), [
    `image ${first}`,
    `check-command #${first}`,
  ]);
  const metadata = s.runs.find((run) => run.input?.kind === "pr-metadata");
  const [image, check] = s.runs.filter(
    (run) => run.input?.kind !== "pr-metadata",
  );
  assert.deepEqual(metadata!.input, {
    kind: "pr-metadata",
    repository: `https://github.com/${repository}`,
    pullRequest: pull.number,
  });
  assert.deepEqual(image!.args, [s.main(), first, repository]);
  assert.equal(image!.head, first);
  assert.equal(check!.head, first);
  const [, container] = /--name (\S+)/.exec(check!.input!.command)!;
  assert.deepEqual(check!.input, {
    kind: "check-command",
    repository: `https://github.com/${repository}`,
    head: first,
    checkout: check!.input!.checkout,
    command: checkContainer(
      "factory-sandbox:test",
      check!.input!.checkout,
      "pnpm validate",
      60_000,
      container!,
    ),
    role: "runner",
  });
  // Its container is the delivery's own, removed before and after its run.
  assert.match(container!, /^scriptorium-check-[\w-]+$/);
  assert.deepEqual(s.removed, [container, container]);
  assert.equal(check!.token, "runner-token");
  // The head checkout is the delivery's own and goes with it.
  assert.equal(existsSync(check!.input!.checkout), false);

  // Edits and readiness for review run the metadata entry point only.
  for (const change of [
    { title: "feat: renamed" },
    { body: "Described." },
    { draft: false },
  ]) {
    s.runs.length = 0;
    s.world.editPull(pull.number, change);
    await s.pass();
    assert.deepEqual(kinds(s.runs), [`pr-metadata #${pull.number}`]);
  }
  // Labels change none of that.
  s.runs.length = 0;
  s.world.label(pull.number, "state:ready", "maintainer");
  await s.pass();
  assert.deepEqual(s.runs, []);

  // Two pushes between passes run only the head the pass observes.
  s.commit("feature", { "feature.txt": "2" });
  const third = s.commit("feature", { "feature.txt": "3" });
  s.world.push(pull.number, third);
  await s.pass();
  assert.deepEqual(kinds(s.runs).sort(), [
    `check-command #${third}`,
    `image ${third}`,
    `pr-metadata #${pull.number}`,
  ]);

  // A closed and reopened pull request runs again.
  s.runs.length = 0;
  s.world.editPull(pull.number, { state: "closed" });
  await s.pass();
  assert.deepEqual(s.runs, []);
  s.world.editPull(pull.number, { state: "open" });
  await s.pass();
  assert.equal(s.runs.length, 3);
});

test("a fork's head runs the metadata entry point only", async (t) => {
  const s = setup(t);
  await s.pass();
  const pull = s.world.openPull({
    head: "f".repeat(40),
    base: s.main(),
    crossRepository: true,
  });
  await s.pass();
  s.world.push(pull.number, "e".repeat(40));
  await s.pass();
  assert.deepEqual(kinds(s.runs), [
    `pr-metadata #${pull.number}`,
    `pr-metadata #${pull.number}`,
  ]);
});

test("entry points and the check command come from the delivery's pinned default-branch commit", async (t) => {
  const s = setup(t);
  await s.pass();
  const head = s.commit("tamper", {
    [entryPoints.validate]: "// the head's validator\n",
    [entryPoints.sandboxImage]: "// the head's image build\n",
    ".scriptorium/config.json": JSON.stringify({
      ...JSON.parse(defaultBranch[".scriptorium/config.json"]),
      checkCommand: "curl attacker.example",
    }),
  });
  s.world.openPull({ head, base: s.main() });
  await s.pass();
  const pinned = join(s.root, "state", "repositories", repository, "runner");
  for (const run of s.runs) {
    assert.ok(run.script.startsWith(join(pinned, "trusted", s.main())));
    assert.match(run.source, /the default branch's/);
  }
  const check = s.runs.find((run) => run.input?.kind === "check-command")!;
  assert.match(check.input!.command, /'pnpm validate'$/);

  // A later default branch pins the next delivery and retires the old one.
  const before = s.main();
  const after = s.advance({
    [entryPoints.validate]: "// the default branch's next validator\n",
  });
  s.runs.length = 0;
  s.world.openIssue();
  await s.pass();
  assert.ok(s.runs.length > 0);
  for (const run of s.runs) {
    assert.ok(run.script.startsWith(join(pinned, "trusted", after)));
    assert.match(run.source, /next validator/);
  }
  assert.deepEqual(readdirSync(join(pinned, "trusted")), [after]);
  assert.notEqual(before, after);
});

test("a repository without a check command gets the image build only", async (t) => {
  const config = JSON.parse(defaultBranch[".scriptorium/config.json"]);
  delete config.checkCommand;
  const s = setup(t, {
    files: { ".scriptorium/config.json": JSON.stringify(config) },
  });
  await s.pass();
  const head = s.commit("feature", { "feature.txt": "1" });
  s.world.openPull({ head, base: s.main() });
  await s.pass();
  assert.deepEqual(kinds(s.runs).sort(), [`image ${head}`, "pr-metadata #1"]);
  assert.match(s.reports.join("\n"), /no checkCommand/);
});

test("a head still gets its image build when the default branch's sandbox image did not build", async (t) => {
  const s = setup(t);
  await s.pass(null);
  const head = s.commit("fix-image", { ".scriptorium/Dockerfile": "FROM x\n" });
  s.world.openPull({ head, base: s.main() });
  await s.pass(null);
  assert.deepEqual(kinds(s.runs).sort(), [`image ${head}`, "pr-metadata #1"]);
  assert.match(
    s.reports.join("\n"),
    /no sandbox image from the default branch/,
  );
});

test("the check container mounts only the head checkout and an entry point gets only the runner token", () => {
  assert.equal(
    checkContainer(
      "factory-sandbox:abc",
      "/state/heads/pull-3-x",
      "pnpm install && pnpm validate",
      90_000,
      "scriptorium-check-1",
    ),
    "timeout --kill-after=30 90 docker run --rm --name scriptorium-check-1 --pull=never --volume /state/heads/pull-3-x:/home/agent/workspace --workdir /home/agent/workspace --entrypoint /usr/bin/tini factory-sandbox:abc -- sh -c 'pnpm install && pnpm validate'",
  );
  assert.equal(
    checkContainer(
      "image",
      "/checkout",
      "echo 'quoted'",
      1000,
      "scriptorium-check-1",
    ).endsWith(`sh -c 'echo '"'"'quoted'"'"''`),
    true,
  );
  assert.deepEqual(
    entryPointEnvironment("runner-token", {
      PATH: "/usr/bin",
      HOME: "/home/factory",
      DOCKER_HOST: "unix:///run/docker.sock",
      FACTORY_GITHUB_TOKEN: "ghs_host",
      GITHUB_TOKEN: "ghs_other",
      ANTHROPIC_API_KEY: "sk-provider",
      POSTERN_TOKEN: "stale",
    }),
    {
      PATH: "/usr/bin",
      HOME: "/home/factory",
      DOCKER_HOST: "unix:///run/docker.sock",
      POSTERN_TOKEN: "runner-token",
    },
  );
});

// The validator and its imports exactly as Repo Canon installed them here.
function installedValidator(): Record<string, string> {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files: Record<string, string> = {};
  const add = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), {
      withFileTypes: true,
      recursive: true,
    }))
      if (entry.isFile()) {
        const path = join(entry.parentPath, entry.name);
        files[relative(root, path)] = readFileSync(path, "utf8");
      }
  };
  for (const directory of ["vendor", ".github/scripts", "operations/lib"])
    add(directory);
  for (const name of readdirSync(join(root, "scripts")))
    if (name.endsWith(".mjs"))
      files[`scripts/${name}`] = readFileSync(
        join(root, "scripts", name),
        "utf8",
      );
  return files;
}

// Repo Canon v0.31.0, installed here, recognizes its own notices only as
// `github-actions[bot]`; acting-login resolution for other runner accounts
// arrives with its next release (Repo Canon #1226).
const installedRunner = "github-actions[bot]";

// Runs the pinned validator's own neutral entry point in this process, over
// the world, as the runner account.
async function realValidator(
  run: Run,
  world: ReturnType<typeof runnerWorld>,
): Promise<EntryPointResult> {
  const output: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = console.error = (...line: unknown[]) =>
    output.push(line.join(" "));
  try {
    const { main } = await import(pathToFileURL(run.script).href);
    const code = await main(run.args, {
      credential: run.token,
      fetch: world.fetchAs(installedRunner),
    });
    return { code: code ?? 0, output: output.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

// The validator's latest notice on the issue, as the runner account posted it.
function notice(world: ReturnType<typeof runnerWorld>, number: number) {
  const comment = world.items[number - 1]!.comments.findLast(
    (comment) =>
      comment.author === installedRunner &&
      comment.body.includes("repo-canon:issue-contract-state"),
  );
  const line = comment?.body
    .split("\n")
    .find((line) => line.startsWith("<!-- repo-canon:issue-contract-state "));
  return line
    ? JSON.parse(
        line.slice(
          "<!-- repo-canon:issue-contract-state ".length,
          -" -->".length,
        ),
      )
    : null;
}

test("the installed validator records an authorized reviewer's readiness delivered as its labeled event", async (t) => {
  const s = setup(t, {
    files: installedValidator(),
    respond: realValidator,
    validator: installedRunner,
  });
  const issue = s.world.openIssue({
    body: directTicket,
    labels: ["state:triage"],
  });
  await s.pass();
  assert.equal(notice(s.world, issue.number)?.status, "awaiting-review");
  s.runs.length = 0;
  s.world.label(issue.number, "state:ready", "maintainer");
  await s.pass();
  const labeled = events(s.runs).find((event) => event.kind === "labeled")!;
  assert.deepEqual(
    [labeled.actor, labeled.label],
    [{ login: "maintainer", bot: false }, "state:ready"],
  );
  const state = notice(s.world, issue.number);
  assert.equal(state.status, "approved", JSON.stringify(state));
  assert.equal(state.label, "state:ready");
  assert.equal(state.reviewer, "maintainer");
});

test("Scriptorium's own evaluation request reaches the installed validator without a workflow", async (t) => {
  const s = setup(t, {
    files: installedValidator(),
    respond: realValidator,
    validator: installedRunner,
  });
  await s.pass();
  const issue = s.world.openIssue({
    body: directTicket,
    labels: ["state:triage"],
  });
  s.runner.request(repository, issue.number);
  await s.drain();
  assert.deepEqual(
    events(s.runs).map((event) => [event.kind, event.actor.login]),
    [["edited", "factory[bot]"]],
  );
  assert.equal(notice(s.world, issue.number)?.status, "awaiting-review");
  assert.equal(
    s.world.requests.some((request) => request.path.endsWith("/dispatches")),
    false,
  );
});

test("an entry point runs in its own process with only the runner token, and stops at its limit", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "entry-point-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  process.env.FACTORY_HOST_SECRET = "host-secret";
  t.after(() => delete process.env.FACTORY_HOST_SECRET);
  const script = join(root, "entry.mjs");
  writeFileSync(
    script,
    "console.log(JSON.stringify({ environment: process.env, cwd: process.cwd(), args: process.argv.slice(2) })); process.exitCode = 3;",
  );
  const result = await runEntryPoint({
    script,
    args: ["input.json"],
    cwd: root,
    token: "runner-token",
    timeoutMs: 30_000,
  });
  assert.equal(result.code, 3);
  const seen = JSON.parse(result.output);
  assert.deepEqual(seen.args, ["input.json"]);
  assert.equal(seen.cwd, root);
  assert.equal(seen.environment.POSTERN_TOKEN, "runner-token");
  assert.equal(seen.environment.FACTORY_HOST_SECRET, undefined);
  assert.deepEqual(
    Object.keys(seen.environment).filter(
      (name) => !Object.hasOwn(entryPointEnvironment("x"), name),
    ),
    // Node.js itself may add nothing else.
    [],
  );

  writeFileSync(script, "setInterval(() => {}, 1000);");
  const stopped = await runEntryPoint({
    script,
    args: [],
    cwd: root,
    token: "runner-token",
    timeoutMs: 200,
  });
  assert.notEqual(stopped.code, 0);
  assert.match(stopped.output, /time limit/);
});

const docker =
  spawnSync("docker", ["info"], { stdio: "ignore", timeout: 30_000 }).status ===
  0;

// The host's secrets as files and as the entry point's environment: the
// runner credential, the App key and tokens, a provider login and the host
// configuration. Neither the check command's container nor an image build
// step may read any of them.
test(
  "neither the check container nor an image build step reads the host's credentials",
  { skip: !docker && "Docker is unavailable" },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), "runner-isolation-"));
    const image = `scriptorium-runner-probe:${process.pid}`;
    t.after(() => {
      spawnSync("docker", ["image", "rm", "--force", image, `${image}-build`], {
        stdio: "ignore",
      });
      rmSync(root, { recursive: true, force: true });
    });
    const secrets = {
      "host.json": "host-configuration-secret",
      "app-key.pem": "app-key-secret",
      "app-token": "ghs-app-token-secret",
      "provider/auth.json": "provider-login-secret",
    };
    write(root, secrets);
    const files = Object.keys(secrets)
      .map((name) => join(root, name))
      .join(" ");
    const environment = {
      ...entryPointEnvironment("runner-credential-secret"),
      FACTORY_GITHUB_TOKEN: "ghs-app-token-secret",
    };
    const leaked = (text: string) =>
      [...Object.values(secrets), "runner-credential-secret"].filter((secret) =>
        text.includes(secret),
      );
    const build = (tag: string, dockerfile: string) =>
      execFileSync("docker", ["build", "--quiet", "--tag", tag, "-"], {
        input: dockerfile,
        env: environment,
        encoding: "utf8",
      });
    // The sandbox image's entrypoint, reduced to running its command.
    build(
      image,
      `FROM busybox:1.36\nRUN printf '#!/bin/sh\\nshift\\nexec "$@"\\n' > /usr/bin/tini && chmod +x /usr/bin/tini\n`,
    );
    const checkout = join(root, "checkout");
    mkdirSync(checkout);
    const probe = `{ for file in ${files}; do cat "$file"; done; env; } > probe.txt 2>&1`;
    execFileSync(
      "sh",
      [
        "-c",
        checkContainer(
          image,
          checkout,
          probe,
          60_000,
          `scriptorium-runner-probe-${process.pid}`,
        ),
      ],
      { env: environment },
    );
    const inside = readFileSync(join(checkout, "probe.txt"), "utf8");
    assert.match(inside, /No such file or directory/);
    assert.deepEqual(leaked(inside), []);

    build(
      `${image}-build`,
      `FROM busybox:1.36\nRUN { for file in ${files}; do cat "$file"; done; env; } > /probe.txt 2>&1; true\n`,
    );
    const step = execFileSync(
      "docker",
      ["run", "--rm", `${image}-build`, "cat", "/probe.txt"],
      { encoding: "utf8" },
    );
    assert.match(step, /No such file or directory/);
    assert.deepEqual(leaked(step), []);
  },
);
