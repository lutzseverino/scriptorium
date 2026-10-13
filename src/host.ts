// The host runner: each pass reads every repository the host configuration
// lists, asks the decision core what to do across all of them, and carries
// the decisions out through GitHub, the repositories' clones and the
// providers' sandboxes.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { updateClone, unpushedChanges, type Git } from "./clone.ts";
import {
  factoryConfigurationPath,
  readFactoryConfiguration,
  type FactoryConfiguration,
} from "./factory-configuration.ts";
import {
  decideFactory,
  type Claim,
  type Decision,
  type Issue,
  type Repository,
  type Run,
  type Settings,
  type Snapshot,
} from "./factory.ts";
import {
  repositoryGitHub,
  runBranch,
  type RepositoryGitHub,
} from "./github.ts";
import {
  githubTokens,
  sandboxEnvironment,
  writeSandboxToken,
} from "./github-token.ts";
import type { HostConfiguration } from "./host-configuration.ts";
import type { LaunchRequest, Registry } from "./providers.ts";
import { createRedactor } from "./redaction.ts";
import { followRunLog } from "./run-log.ts";
import { hostStatus, writeStatus } from "./status.ts";

export type HostPorts = {
  // Runs the GitHub CLI as the token's holder.
  gh(token: string, args: string[]): Promise<string>;
  // Runs Git in `cwd`, authenticating to GitHub as the token's holder.
  git(token: string, cwd: string, args: string[]): Promise<string>;
  // Runs the host's token command for the repository and resolves the token
  // it printed.
  token(repository: string): Promise<string>;
  // The URL the repository is cloned from.
  remoteUrl(repository: string): string;
  // Builds the sandbox image over the repository's toolchain Dockerfile and
  // resolves its tag.
  buildImage(dockerfile: string): Promise<string>;
  readUsage(provider: string): Promise<number | null>;
  // Resolves or rejects when the run's agent exits.
  launch(provider: string, request: LaunchRequest): Promise<void>;
  // Removes every sandbox container on the host before it returns.
  stopSandboxes(): void;
  now(): Date;
  // Writes a line to the process log.
  report(line: string): void;
};

// The repository's sandbox Dockerfile, fixed by the factory.
export const dockerfilePath = ".factory/Dockerfile";

type HostRun = Run & {
  // Keeps repository conventions available after restart if its config is invalid.
  configuration: FactoryConfiguration;
  base: string;
  // The first attempt's start; a retry continues its pull request.
  pullRequestSince: string;
  // The run's private directory, holding its token directory and the
  // agent's raw log while its agent runs.
  sandbox: string;
  // The token the sandbox's token file holds; it is never recorded.
  token: string;
  // Resolves once the run's log is published and its directory removed.
  finished: Promise<void>;
  controller: AbortController;
  exited: boolean;
  exitedAt: Date | null;
  stopped: boolean;
  // A factory restart stopped its sandbox, so it launches again.
  interrupted: boolean;
  // The host no longer holds it.
  settled: boolean;
};

// One repository as this pass found it. An unreadable repository has no
// GitHub reads this pass, so only its running sandboxes reach the snapshot.
type Pass = {
  name: string;
  paused: string | null;
  github: RepositoryGitHub | null;
  image: string | null;
  read: Repository | null;
  configuration: FactoryConfiguration | null;
};

export function createHost(
  configuration: HostConfiguration,
  registry: Registry,
  ports: HostPorts,
) {
  const runs: HostRun[] = [];
  // A bad edit pauses pickup, but runs still settle with the last valid conventions.
  const conventions = new Map<string, FactoryConfiguration>();
  // Every token the command prints and every provider credential value a
  // launch delivers stays out of the logs and the status file.
  const redactor = createRedactor();
  const tokens = githubTokens(ports.token, ports.now, redactor);
  const report = (line: string) => ports.report(redactor.redact(line));
  let started = false;
  let interrupting = false;
  const settings: Settings = {
    defaultModel: configuration.models.default,
    retryModel: configuration.models.retry,
    caps: Object.fromEntries(
      Object.entries(configuration.providers).map(([name, { cap }]) => [
        name,
        cap,
      ]),
    ),
    usageThreshold: configuration.usageThreshold,
    timeLimitMinutes: configuration.timeLimitMinutes,
  };

  // Everything the process owns for a repository lives under its directory.
  function directory(repository: string) {
    const root = join(
      configuration.stateDirectory,
      "repositories",
      ...repository.split("/"),
    );
    return {
      clone: join(root, "clone"),
      logs: join(root, "logs"),
      runs: join(root, "runs"),
      // Each running sandbox's private directory.
      sandboxes: join(root, "sandboxes"),
    };
  }

  async function read(name: string): Promise<Pass> {
    const pass: Pass = {
      name,
      paused: null,
      github: null,
      image: null,
      read: null,
      configuration: conventions.get(name) ?? null,
    };
    const pause = (reason: string) => (pass.paused = redactor.redact(reason));
    try {
      await deliver(name, await tokens.get(name));
    } catch (error) {
      pause(`${error instanceof Error ? error.message : error}`);
      return pass;
    }
    // Each call takes the token as it stands, so a long pass outlives none.
    const git: Git = async (cwd, args) =>
      ports.git(await tokens.get(name), cwd, args);
    const { clone } = directory(name);
    try {
      await updateClone(
        git,
        clone,
        ports.remoteUrl(name),
        configuration.gitIdentity,
      );
      try {
        pass.configuration = readFactoryConfiguration(
          join(clone, factoryConfigurationPath),
        );
        conventions.set(name, pass.configuration);
      } catch (error) {
        pause(`${error instanceof Error ? error.message : error}`);
      }
      const dockerfile = join(clone, dockerfilePath);
      if (pass.paused === null && !existsSync(dockerfile))
        pause(`it has no ${dockerfilePath}`);
      else if (pass.paused === null)
        try {
          pass.image = await ports.buildImage(
            await readFile(dockerfile, "utf8"),
          );
        } catch (error) {
          pause(`its sandbox image did not build: ${error}`);
        }
    } catch (error) {
      pause(`its clone did not update: ${error}`);
    }
    if (!pass.configuration) return pass;
    const github = repositoryGitHub(
      name,
      pass.configuration.labels,
      async (args) => ports.gh(await tokens.get(name), args),
    );
    pass.github = github;
    try {
      await github.createStateLabels();
    } catch (error) {
      if (pass.paused === null)
        pause(`its state labels could not be created: ${error}`);
    }
    try {
      for (const run of runs.filter(
        (run) => run.repository === name && run.exited && !run.interrupted,
      )) {
        await run.finished;
        run.ended = {
          // Sandcastle's idle timeout can end a run at its limit before the
          // factory stops it, so the time it ran decides, not who ended it.
          timedOut:
            run.stopped ||
            run.exitedAt!.getTime() - Date.parse(run.startedAt) >=
              settings.timeLimitMinutes * 60_000,
          pullRequest: await github.pullRequestState(
            run.issue,
            run.pullRequestSince,
          ),
        };
        if (
          !run.ended.timedOut &&
          ["none", "closed"].includes(run.ended.pullRequest)
        ) {
          const paths = await unpushedChanges(
            git,
            clone,
            runBranch(run.issue),
            run.base,
            configuration.unpushablePaths,
          );
          if (paths.length) run.ended.unpushedChanges = paths;
        }
      }
      const issues = await github.readIssues();
      pass.read = {
        name,
        configuration: pass.configuration,
        paused: pass.paused,
        issues,
        claims: await readClaims(
          name,
          github,
          issues,
          pass.configuration.labels,
        ),
      };
    } catch (error) {
      pause(`its GitHub reads failed: ${error}`);
    }
    return pass;
  }

  // Every running-labelled issue, open or closed, that no run on the host
  // holds. A closed issue's work counts as merged.
  async function readClaims(
    name: string,
    github: RepositoryGitHub,
    issues: Issue[],
    labels: FactoryConfiguration["labels"],
  ): Promise<Claim[]> {
    const held = (number: number) =>
      runs.some((run) => run.repository === name && run.issue === number);
    const claims: Claim[] = (await github.readClosedClaims())
      .filter((number) => !held(number))
      .map((number) => ({ issue: number, pullRequest: "merged" }));
    for (const issue of issues)
      if (issue.labels.includes(labels.running) && !held(issue.number))
        claims.push({
          issue: issue.number,
          pullRequest: await github.pullRequestState(issue.number),
        });
    return claims;
  }

  async function readUsage() {
    const usage: Record<string, number | null> = {};
    for (const provider of Object.keys(configuration.providers)) {
      try {
        usage[provider] = await ports.readUsage(provider);
      } catch (error) {
        report(`usage for ${provider} is unreadable: ${error}`);
        usage[provider] = null;
      }
    }
    return usage;
  }

  function find(decision: { repository: string; issue: number }) {
    return runs.find(
      (run) =>
        run.repository === decision.repository && run.issue === decision.issue,
    );
  }

  function forget(decision: { repository: string; issue: number }) {
    const run = find(decision);
    if (!run) return;
    runs.splice(runs.indexOf(run), 1);
    run.settled = true;
    record(run);
  }

  // Replaces the run's record whole and at once, so a signal handler can
  // record it before the process exits.
  function record(run: HostRun) {
    const { controller: _c, token: _t, finished: _f, ...recorded } = run;
    const runsDirectory = directory(run.repository).runs;
    mkdirSync(runsDirectory, { recursive: true });
    const path = join(
      runsDirectory,
      `issue-${run.issue}-attempt-${run.attempt}.json`,
    );
    writeFileSync(`${path}.partial`, `${JSON.stringify(recorded, null, 2)}\n`);
    renameSync(`${path}.partial`, path);
  }

  // Before anything else, the first pass removes the sandboxes an earlier
  // process left and takes up the runs it recorded as interrupted.
  function start() {
    ports.stopSandboxes();
    const interrupted: HostRun[] = [];
    for (const name of configuration.repositories) {
      const runsDirectory = directory(name).runs;
      if (!existsSync(runsDirectory)) continue;
      for (const file of readdirSync(runsDirectory).filter((file) =>
        file.endsWith(".json"),
      )) {
        let recorded;
        try {
          recorded = JSON.parse(
            readFileSync(join(runsDirectory, file), "utf8"),
          );
        } catch (error) {
          report(`the run record ${file} of ${name} is unreadable: ${error}`);
          continue;
        }
        if (!recorded.interrupted || recorded.settled) continue;
        if (recorded.configuration)
          conventions.set(name, recorded.configuration);
        interrupted.push({
          ...recorded,
          exitedAt: new Date(recorded.exitedAt),
          token: "",
          finished: Promise.resolve(),
          controller: new AbortController(),
        });
      }
    }
    runs.push(...interrupted);
  }

  // On a stop signal: stop claiming and launching, record every running run
  // as interrupted, and remove the sandboxes without waiting for the runs.
  function interrupt() {
    interrupting = true;
    for (const run of runs.filter((run) => !run.exited)) {
      run.exited = true;
      run.exitedAt = ports.now();
      run.interrupted = true;
      run.ended = { interrupted: true };
      // Its published log keeps what was copied; the raw log and the token go
      // with the sandbox.
      rmSync(run.sandbox, { recursive: true, force: true });
      record(run);
    }
    ports.stopSandboxes();
  }

  // Rewrites the token file of each of the repository's running sandboxes
  // that holds another token.
  async function deliver(repository: string, token: string) {
    for (const run of runs)
      if (run.repository === repository && !run.exited && run.token !== token)
        try {
          await writeSandboxToken(join(run.sandbox, "github"), token);
          run.token = token;
        } catch (error) {
          // A run that exited meanwhile took its token file with it.
          if (!run.exited)
            report(
              `${repository}#${run.issue}'s token file was not rewritten: ${error}`,
            );
        }
  }

  // Refreshes the token of every repository with a running sandbox, between
  // passes as well as during them, so a run outlives its first token.
  async function refreshTokens() {
    const repositories = new Set(
      runs.filter((run) => !run.exited).map((run) => run.repository),
    );
    for (const repository of repositories)
      try {
        await deliver(repository, await tokens.get(repository));
      } catch (error) {
        report(`${repository}'s token was not refreshed: ${error}`);
      }
  }

  async function launch(decision: Decision & { kind: "launch" }, pass: Pass) {
    const { repository, issue } = decision;
    const paths = directory(repository);
    const token = await tokens.get(repository);
    const base = (
      await ports.git(token, paths.clone, ["rev-parse", "HEAD"])
    ).trim();
    const previous = find(decision);
    const controller = new AbortController();
    const startedAt = ports.now().toISOString();
    // A relaunch appends to its attempt's log.
    const log = join(
      paths.logs,
      `issue-${issue}-attempt-${decision.attempt}.log`,
    );
    await mkdir(paths.sandboxes, { recursive: true, mode: 0o700 });
    const sandbox = await mkdtemp(join(paths.sandboxes, `issue-${issue}-`));
    const raw = join(sandbox, "agent.log");
    let github, follower;
    try {
      await mkdir(join(sandbox, "github"), { mode: 0o700 });
      github = await writeSandboxToken(join(sandbox, "github"), token);
      follower = await followRunLog(raw, log, redactor.redact);
    } catch (error) {
      await rm(sandbox, { recursive: true, force: true });
      throw error;
    }
    if (interrupting) {
      await follower.close();
      await rm(sandbox, { recursive: true, force: true });
      return;
    }
    forget(decision);
    const run: HostRun = {
      configuration: pass.configuration!,
      repository,
      base,
      issue,
      provider: decision.provider,
      model: decision.model,
      effort: decision.effort,
      attempt: decision.attempt,
      ...(decision.retry && { retry: decision.retry }),
      startedAt,
      pullRequestSince: previous?.pullRequestSince ?? startedAt,
      log,
      ended: null,
      sandbox,
      token,
      finished: Promise.resolve(),
      controller,
      exited: false,
      exitedAt: null,
      stopped: false,
      interrupted: false,
      settled: false,
    };
    runs.push(run);
    record(run);
    run.finished = ports
      .launch(run.provider, {
        model: run.model,
        effort: run.effort,
        name: `${repository}#${issue}`,
        cwd: paths.clone,
        image: pass.image!,
        prompt: prompt(
          pass.configuration!.prompt,
          registry.providers.get(run.provider)!.skillPrefix,
          issue,
          decision.retry,
        ),
        branch: runBranch(issue),
        log: raw,
        idleTimeoutSeconds: settings.timeLimitMinutes * 60,
        mounts: [github],
        env: sandboxEnvironment,
        signal: controller.signal,
        delivered: redactor.add,
      })
      .catch((error) =>
        report(`run for ${repository}#${issue} ended with an error: ${error}`),
      )
      .then(async () => {
        // An interrupted run's record and directory are already settled.
        if (run.interrupted) {
          await follower.close().catch(() => {});
          return;
        }
        run.exited = true;
        run.exitedAt = ports.now();
        try {
          await follower.close();
        } catch (error) {
          report(`run for ${repository}#${issue} lost its log's end: ${error}`);
        }
        try {
          // A token outlives no run.
          await rm(sandbox, { recursive: true, force: true });
          record(run);
        } catch (error) {
          report(
            `run for ${repository}#${issue} did not finish its records: ${error}`,
          );
        }
      });
  }

  async function apply(decision: Decision, pass: Pass) {
    const github = pass.github!;
    switch (decision.kind) {
      case "close": {
        await github.close(decision.issue, decision.tickets);
        const run = find(decision);
        if (run && !run.exited)
          run.controller.abort(new Error("its parent issue is closed"));
        forget(decision);
        return;
      }
      case "claim":
        await github.claim(decision.issue);
        return;
      case "launch":
        await launch(decision, pass);
        return;
      case "stop": {
        const run = find(decision);
        if (!run) return;
        run.stopped = true;
        run.controller.abort(new Error(decision.reason));
        return;
      }
      case "fail":
        await github.fail(
          decision.issue,
          failureComment(
            pass.configuration!.labels.failed,
            decision.failure,
            decision.log,
            find(decision),
            decision.unpushedChanges,
          ),
        );
        forget(decision);
        return;
      case "keep":
        forget(decision);
        return;
      case "release":
        await github.release(decision.issue);
        forget(decision);
        return;
      case "skip":
        report(
          `${decision.repository}#${decision.issue} skipped: ${decision.reason}`,
        );
        return;
    }
  }

  async function tick(): Promise<Decision[]> {
    if (interrupting) return [];
    if (!started) {
      start();
      started = true;
    }
    const passes: Pass[] = [];
    for (const name of configuration.repositories)
      passes.push(await read(name));
    const readable = new Set(
      passes.filter((pass) => pass.read).map((pass) => pass.name),
    );
    const snapshot: Snapshot = {
      now: ports.now().toISOString(),
      repositories: passes.flatMap((pass) => (pass.read ? [pass.read] : [])),
      runs: runs
        .filter((run) => readable.has(run.repository) || !run.exited)
        .map((run): Run => ({
          repository: run.repository,
          issue: run.issue,
          provider: run.provider,
          model: run.model,
          effort: run.effort,
          attempt: run.attempt,
          ...(run.retry && { retry: run.retry }),
          startedAt: run.startedAt,
          log: run.log,
          ended: run.exited ? run.ended : null,
        })),
      usage: await readUsage(),
      settings,
    };
    for (const pass of passes)
      if (pass.paused !== null)
        report(`${pass.name} is paused: ${pass.paused}`);
    const decisions = decideFactory(snapshot, registry);
    // A failed write stops that repository's decisions for this pass, such as
    // a launch after a claim that did not apply; other repositories continue.
    const stopped = new Set<string>();
    for (const decision of decisions) {
      if (interrupting) break;
      if (stopped.has(decision.repository)) continue;
      try {
        await apply(
          decision,
          passes.find((pass) => pass.name === decision.repository)!,
        );
      } catch (error) {
        stopped.add(decision.repository);
        report(
          `${decision.repository}#${decision.issue} ${decision.kind} failed, so ${decision.repository} waits for the next pass: ${error}`,
        );
      }
    }
    try {
      await writeStatus(
        join(configuration.stateDirectory, "status.json"),
        hostStatus(snapshot.now, passes, decisions),
      );
    } catch (error) {
      report(`the status file was not written: ${error}`);
    }
    return decisions;
  }

  return { tick, interrupt, refreshTokens, report };
}

export function prompt(
  template: string,
  skillPrefix: string,
  issue: number,
  retry?: { failure: string; log: string },
): string {
  const start = template.replace(
    /\{(skillPrefix|issue)\}/g,
    (_match, field: string) =>
      field === "skillPrefix" ? skillPrefix : String(issue),
  );
  if (!retry) return start;
  let tail = "";
  try {
    const log = readFileSync(retry.log, "utf8");
    const lines = log.split("\n");
    const terminated = lines.at(-1) === "";
    if (terminated) lines.pop();
    tail = lines.slice(-200).join("\n") + (log && terminated ? "\n" : "");
    const bytes = Buffer.from(tail);
    let begin = Math.max(0, bytes.length - 16 * 1024);
    // Keep valid UTF-8 when the byte cap lands inside a character.
    while (begin < bytes.length && (bytes[begin] & 0xc0) === 0x80) begin++;
    tail = bytes.subarray(begin).toString("utf8");
  } catch {
    // A missing or unreadable first-attempt log does not prevent a retry.
  }
  return [
    start,
    `First attempt failure: ${retry.failure}`,
    ...(tail ? [`First attempt log tail:\n${tail}`] : []),
  ].join("\n\n");
}

// A claim no run holds has no model or log to name.
function failureComment(
  failedLabel: string,
  failure: string,
  log: string | null,
  run?: HostRun,
  unpushed?: string[],
): string {
  const details = [
    ...(run
      ? [
          `- Model: \`${run.provider}/${run.model}@${run.effort}\`, attempt ${run.attempt}`,
        ]
      : []),
    ...(log ? [`- Log: \`${log}\` on the factory host`] : []),
  ];
  return [
    `The factory run failed: ${failure}.`,
    "",
    ...(details.length > 0 ? [...details, ""] : []),
    ...(unpushed?.length
      ? [
          ...unpushed.map((path) => `- Unpushable: \`${path}\``),
          "",
          "A person with permission to push these paths must deliver the change.",
          "",
        ]
      : []),
    `Remove \`${failedLabel}\` to let the factory pick this issue up again.`,
  ].join("\n");
}
