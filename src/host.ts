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
import {
  updateClone,
  unpushedChanges,
  readRecovery,
  type Recovery,
  type Git,
} from "./clone.ts";
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
  type Pause,
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
import type { Retention } from "./image-retention.ts";
import {
  completionSignal,
  type LaunchRequest,
  type LaunchResult,
  type Registry,
} from "./providers.ts";
import type { UsageWindow } from "./providers/usage.ts";
import type { PullRequestState } from "./run-outcome.ts";
import { createOwner } from "./owner.ts";
import { createRedactor } from "./redaction.ts";
import { pauseDeadline } from "./pause.ts";
import { followRunLog, readLogEnd } from "./run-log.ts";
import { hostStatus, writeStatus } from "./status.ts";
import { createUsage } from "./usage.ts";
import { renderComment } from "./comment-template.ts";
import { createEvents, providerStatus } from "./events.ts";

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
  // Removes the factory's obsolete sandbox images beyond the host's
  // allowance, keeping every `current` and `running` image and every image a
  // container uses. Rejects, removing nothing, when its inventory fails.
  retainImages(current: string[], running: string[]): Promise<Retention>;
  // Prunes the factory builder's cache past the host's minimum age, and
  // resolves the space freed, or null when nothing was.
  pruneBuildCache(): Promise<string | null>;
  // The provider's usage as its adapter reads it, rejecting with a
  // `UsageReadError` when the provider refuses the read.
  readUsage(provider: string): Promise<UsageWindow | null>;
  // Resolves or rejects when the run's agent exits.
  launch(provider: string, request: LaunchRequest): Promise<LaunchResult>;
  // Removes every sandbox container on the host before it returns.
  stopSandboxes(): void;
  now(): Date;
  // Writes a line to the process log.
  report(line: string): void;
};

// The repository's sandbox Dockerfile, fixed by the factory.
export const dockerfilePath = ".factory/Dockerfile";

type HostRun = Run & {
  launchResult?: LaunchResult;
  recovery?: Recovery;
  // Keeps repository conventions available after restart if its config is invalid.
  configuration: FactoryConfiguration;
  base: string;
  // The sandbox image the run launched from.
  image: string;
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
  // The pause its stop at the pause threshold fixed, which becomes how it
  // ended once its agent exits, however it exits.
  pausing: Pause | null;
  // A factory restart stopped its sandbox, so it launches again. A paused
  // run, which also launches again, records its pause as how it ended.
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
  // Why image retention last waited, reported once until it changes.
  let retentionWait: string | null = null;
  const pending = new Set<Promise<void>>();
  const events = createEvents(configuration.stateDirectory);
  let providerReadings: Snapshot["usage"] = {};
  let providerHolds: Snapshot["holds"] = {};
  const settings: Settings = {
    defaultModel: configuration.models.default,
    retryModel: configuration.models.retry,
    caps: Object.fromEntries(
      Object.entries(configuration.providers).map(([name, { cap }]) => [
        name,
        cap,
      ]),
    ),
    drainThreshold: configuration.usage.drainThreshold,
    pauseThreshold: configuration.usage.pauseThreshold,
    timeLimitMinutes: configuration.timeLimitMinutes,
    authorizedRoles: configuration.readiness.authorizedRoles,
  };
  const usage = createUsage({
    providers: Object.keys(configuration.providers),
    thresholds: settings,
    read: ports.readUsage,
    now: ports.now,
    report,
    path: join(configuration.stateDirectory, "usage.json"),
    persist(text, readings, holds) {
      providerReadings = readings;
      providerHolds = holds;
      events.commit(providerStatuses(), { file: "usage.json", text });
    },
  });
  const owner = createOwner({
    providers: Object.keys(configuration.providers),
    policy: configuration.usage,
    now: ports.now,
    report,
    stateDirectory: configuration.stateDirectory,
    persist(text, resume) {
      events.commit(providerStatuses(), { file: "owner.json", text }, resume);
    },
  });

  function providerStatuses() {
    const controls = owner.controls();
    return Object.keys(configuration.providers).map((provider) =>
      providerStatus(
        provider,
        ports.now().toISOString(),
        providerReadings[provider] ?? null,
        providerHolds[provider] ?? null,
        controls[provider] ?? null,
        configuration.usage,
        runs.filter(
          (run) =>
            run.provider === provider &&
            (!run.exited || (run.ended && "interrupted" in run.ended)),
        ).length,
        runs.filter(
          (run) =>
            run.provider === provider && (run.pausing || pausedEnding(run)),
        ).length,
      ),
    );
  }

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
      pass.configuration.comments?.close,
    );
    pass.github = github;
    try {
      await github.createStateLabels();
    } catch (error) {
      if (pass.paused === null)
        pause(`its state labels could not be created: ${error}`);
    }
    try {
      const issues = await github.readIssues();
      for (const run of runs.filter(
        (run) => run.repository === name && run.exited && !run.interrupted,
      )) {
        await run.finished;
        if (pausedEnding(run)) continue;
        run.ended = {
          // Sandcastle's idle timeout can end a run at its limit before the
          // factory stops it, so the time it ran decides, not who ended it.
          timedOut:
            run.stopped ||
            run.exitedAt!.getTime() - Date.parse(run.startedAt) >=
              settings.timeLimitMinutes * 60_000,
          ...(run.ended && "orphaned" in run.ended && { orphaned: true }),
          pullRequest: await github.pullRequestState(
            run.issue,
            run.pullRequestSince,
          ),
        };
        const paths = await readUnpushableChanges(
          git,
          clone,
          run.base,
          issues.find((issue) => issue.number === run.issue),
          run.ended.pullRequest,
          pass.configuration.labels.needsInput,
        );
        if (paths.length) run.ended.unpushedChanges = paths;
      }
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

  // Every running- or paused-labelled issue, open or closed, that no run on
  // the host holds. Pull request state and issue closure remain independent.
  async function readClaims(
    name: string,
    github: RepositoryGitHub,
    issues: Issue[],
    labels: FactoryConfiguration["labels"],
  ): Promise<Claim[]> {
    const held = (number: number) =>
      runs.some((run) => run.repository === name && run.issue === number);
    const claims: Claim[] = [];
    const numbers = [
      ...(await github.readClosedClaims()),
      ...issues
        .filter(
          (issue) =>
            issue.labels.includes(labels.running) ||
            issue.labels.includes(labels.paused),
        )
        .map((issue) => issue.number),
    ];
    const { clone } = directory(name);
    const git: Git = async (cwd, args) =>
      ports.git(await tokens.get(name), cwd, args);
    for (const number of numbers) {
      if (held(number)) continue;
      const claim: Claim = {
        issue: number,
        pullRequest: await github.pullRequestState(number),
      };
      const paths = await readUnpushableChanges(
        git,
        clone,
        "HEAD",
        issues.find((issue) => issue.number === number),
        claim.pullRequest,
        labels.needsInput,
      );
      if (paths.length) claim.unpushedChanges = paths;
      claims.push(claim);
    }
    return claims;
  }

  // Earlier outcome rows settle without consulting the branch. Both runs
  // and claims use the same eligibility rule; their base commits differ.
  async function readUnpushableChanges(
    git: Git,
    clone: string,
    base: string,
    issue: Issue | undefined,
    pullRequest: PullRequestState,
    needsInputLabel: string,
  ): Promise<string[]> {
    if (
      !issue ||
      !["none", "closed"].includes(pullRequest) ||
      issue.labels.includes(needsInputLabel)
    )
      return [];
    return unpushedChanges(
      git,
      clone,
      runBranch(issue.number),
      base,
      configuration.unpushablePaths,
    );
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
  // process left and recovers unsettled runs: interrupted and paused ones
  // relaunch, and so does one the earlier process was stopping at the pause
  // threshold, as paused, while orphans settle through the outcome table.
  function start() {
    ports.stopSandboxes();
    const recovered: HostRun[] = [];
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
        if (recorded.settled) continue;
        if (recorded.configuration)
          conventions.set(name, recorded.configuration);
        recovered.push({
          ...recorded,
          exited: true,
          exitedAt: new Date(recorded.exitedAt ?? ports.now()),
          ended: recorded.interrupted
            ? { interrupted: true }
            : pausedEnding(recorded)
              ? recoveredPause(recorded)
              : recorded.pausing
                ? { paused: recorded.pausing, commented: false }
                : { timedOut: false, pullRequest: "none", orphaned: true },
          token: "",
          finished: Promise.resolve(),
          controller: new AbortController(),
        });
      }
    }
    runs.push(...recovered);
  }

  // On a stop signal: stop claiming and launching, record every running run
  // as interrupted, or as paused when the pause threshold was stopping it, and
  // remove the sandboxes without waiting for the runs.
  function interrupt() {
    interrupting = true;
    for (const run of runs.filter((run) => !run.exited)) {
      run.exited = true;
      run.exitedAt = ports.now();
      if (run.pausing) run.ended = { paused: run.pausing, commented: false };
      else {
        run.interrupted = true;
        run.ended = { interrupted: true };
      }
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
    const recovery = await readRecovery(
      async (cwd, args) => ports.git(await tokens.get(repository), cwd, args),
      paths.clone,
      runBranch(issue),
    );
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
      image: pass.image!,
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
      pausing: null,
      interrupted: false,
      settled: false,
      recovery,
    };
    try {
      record(run);
    } catch (error) {
      await follower.close().catch(() => {});
      await rm(sandbox, { recursive: true, force: true });
      throw error;
    }
    runs.push(run);
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
          recovery,
        ),
        branch: runBranch(issue),
        log: raw,
        idleTimeoutSeconds: settings.timeLimitMinutes * 60,
        mounts: [github],
        env: sandboxEnvironment,
        signal: controller.signal,
        delivered: redactor.add,
      })
      .then((result) => {
        // Metadata is selected by the launcher; redact even these identities
        // before they become durable records or operator diagnostics.
        run.launchResult = Object.fromEntries(
          Object.entries(result).map(([key, value]) => [
            key,
            typeof value === "string" ? redactor.redact(value) : value,
          ]),
        ) as LaunchResult;
      })
      .catch((error) =>
        report(`run for ${repository}#${issue} ended with an error: ${error}`),
      )
      .then(async () => {
        // An interrupted run's successor owns the durable record now. The
        // successor inspects its preserved branch before relaunching.
        if (run.exited) {
          await follower.close().catch(() => {});
          return;
        }
        try {
          run.recovery = await readRecovery(
            async (cwd, args) =>
              ports.git(await tokens.get(repository), cwd, args),
            paths.clone,
            runBranch(issue),
          );
        } catch (error) {
          report(
            `recovery inspection for ${repository}#${issue} failed; retain the clone and inspect its run branch before retry: ${error}`,
          );
        }
        if (!run.launchResult?.completionSignal) {
          report(
            `${repository}#${issue} exited without completion signal; GitHub still decides delivery. Recovery state: ${JSON.stringify(run.recovery ?? { branch: runBranch(issue) })}; launch metadata: ${JSON.stringify(run.launchResult ?? null)}. Retain this clone and revalidate recovered work before publication.`,
          );
        }
        // A run the stop signal recorded has its record and directory settled.
        if (run.exited) {
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
        // The raw log goes with the sandbox, so its end is read first. A stop
        // at the pause threshold decides how the run ended, whatever the log
        // says.
        if (run.pausing) run.ended = { paused: run.pausing, commented: false };
        else
          try {
            const limit = registry.providers
              .get(run.provider)!
              .usageLimit(await readLogEnd(raw));
            if (limit) {
              const reset = limit.reset && redactor.redact(limit.reset);
              run.ended = {
                paused: {
                  cause: "usage limit",
                  reset,
                  at: run.exitedAt.toISOString(),
                  until: pauseDeadline(reset, run.exitedAt).toISOString(),
                },
                commented: false,
              };
            }
          } catch (error) {
            report(
              `run for ${repository}#${issue} could not read its raw log's end: ${error}`,
            );
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
      })
      .finally(() => pending.delete(run.finished));
    pending.add(run.finished);
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
        if (!decision.pause) run.stopped = true;
        // The first stop at the pause threshold fixes the run's pause, kept
        // across a restart; a run that already exited ends as it exited.
        else if (!run.exited && !run.pausing) {
          run.pausing = decision.pause;
          record(run);
        }
        run.controller.abort(new Error(decision.reason));
        return;
      }
      case "fail":
        await github.fail(
          decision.issue,
          failureComment(
            pass.configuration!,
            decision.failure,
            decision.log,
            find(decision),
            decision.unpushedChanges,
          ),
        );
        forget(decision);
        return;
      case "keep": {
        // Awaiting merge takes no cap slot but retains its attempt and PR
        // history until the claim settles, including across a restart.
        const run = find(decision);
        if (run) record(run);
        return;
      }
      case "release":
        await github.release(decision.issue);
        forget(decision);
        return;
      case "pause": {
        const run = find(decision);
        const ended = run && pausedEnding(run);
        if (!ended) return;
        await github.pause(
          decision.issue,
          pauseComment(
            pass.configuration!,
            decision.pause,
            run,
            configuration.usage.pauseThreshold,
          ),
        );
        // Recorded as told, so neither a later pass nor a restart tells it
        // again.
        ended.commented = true;
        record(run);
        return;
      }
      case "unpause":
        await github.unpause(decision.issue);
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
    // Finish any earlier append and policy write before loading policy or
    // making a new observation. Persistence failure prevents this pass.
    events.recover();
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
    const readings = await usage.read();
    const holds = usage.holds();
    providerReadings = readings;
    providerHolds = holds;
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
      usage: readings,
      holds,
      // The owner's resume requests apply here, at the pass's start.
      owners: owner.pass(readings, holds),
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
    const providers = providerStatuses();
    events.commit(providers);
    try {
      await writeStatus(
        join(configuration.stateDirectory, "status.json"),
        hostStatus(snapshot.now, passes, decisions, providers),
      );
    } catch (error) {
      report(`the status file was not written: ${error}`);
    }
    if (!interrupting) await retain(passes);
    return decisions;
  }

  // Once a pass has prepared every repository's image, the factory's obsolete
  // images beyond the host's allowance go. A repository without one this pass
  // could still need any of them, so until then none goes. The factory
  // builder's old cache is pruned either way. A failure here is reported and
  // leaves the pass and its images as they are.
  async function retain(passes: Pass[]) {
    const waiting = passes.filter((pass) => pass.image === null);
    const wait = waiting.length
      ? `sandbox image retention waits for the current images of ${waiting.map((pass) => pass.name).join(", ")}`
      : null;
    if (wait !== null && wait !== retentionWait) report(wait);
    retentionWait = wait;
    if (wait === null)
      try {
        const { removed, problems } = await ports.retainImages(
          passes.map((pass) => pass.image!),
          runs.filter((run) => !run.exited).map((run) => run.image),
        );
        if (removed.length > 0)
          report(`removed obsolete sandbox images: ${removed.join(", ")}`);
        for (const problem of problems)
          report(`sandbox image retention: ${problem}`);
      } catch (error) {
        report(`sandbox image retention removed nothing: ${error}`);
      }
    try {
      const freed = await ports.pruneBuildCache();
      if (freed !== null)
        report(`pruned the sandbox build cache, freeing ${freed}`);
    } catch (error) {
      report(`the sandbox build cache was not pruned: ${error}`);
    }
  }

  // After launches have been stopped or finished, wait for their log and
  // record writes, including runs a later pass has already forgotten.
  async function drain(): Promise<void> {
    await Promise.all(pending);
  }

  return { tick, interrupt, drain, refreshTokens, report };
}

export function prompt(
  template: string,
  skillPrefix: string,
  issue: number,
  retry?: { failure: string; log: string },
  recovery?: Recovery,
): string {
  const start = template.replace(
    /\{(skillPrefix|issue)\}/g,
    (_match, field: string) =>
      field === "skillPrefix" ? skillPrefix : String(issue),
  );
  const guidance = [
    "Unattended execution:",
    "There is no interactive notification or resume loop. Keep commands in the foreground and wait for validation to finish; inspect its final exit status before PR delivery. Do not yield while work is pending; detaching shell commands with &, nohup, disown or similar is not a substitute. A timeout is a failure to resolve, never evidence of a pass. Use bounded foreground command timeouts within the run's time limit.",
    `Emit ${completionSignal} only after the requested delivery or explicit owner handoff is actually recorded. The signal is loop control; GitHub outcomes still determine delivery.`,
    ...(recovery
      ? [
          `Recovery state: ${JSON.stringify(recovery)}. Continue this preserved branch and worktree, including staged, unstaged and untracked changes. Revalidate recovered work before publication. Recovery itself must not push, open a PR, merge, close the issue or grant readiness.`,
        ]
      : []),
  ].join("\n");
  if (!retry) return `${start}\n\n${guidance}`;
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
    guidance,
  ].join("\n\n");
}

// How a run ended, when it paused.
function pausedEnding(
  run: Pick<Run, "ended">,
): { paused: Pause; commented: boolean } | null {
  return run.ended && "paused" in run.ended ? run.ended : null;
}

// A recovered paused run keeps the pause time and deadline it recorded. A
// record from before they were recorded pauses at its exit, or, lacking that,
// at its start, so its deadline counts from then and never from the restart.
function recoveredPause(recorded: {
  ended: { paused: Partial<Pause> & Pick<Pause, "reset">; commented: boolean };
  exitedAt?: string | null;
  startedAt: string;
}): { paused: Pause; commented: boolean } {
  const { paused, commented } = recorded.ended;
  if (typeof paused.at === "string" && typeof paused.until === "string")
    return { paused: paused as Pause, commented };
  const at = new Date(recorded.exitedAt ?? recorded.startedAt);
  return {
    paused: {
      cause: "usage limit",
      reset: paused.reset,
      at: at.toISOString(),
      until: pauseDeadline(paused.reset, at).toISOString(),
    },
    commented,
  };
}

// Each pause tells its issue once; it names no log output.
function pauseComment(
  configuration: FactoryConfiguration,
  pause: Pause,
  run: HostRun,
  threshold: number | null,
): string {
  return renderComment("pause", configuration.comments?.pause, {
    provider: run.provider,
    model: run.model,
    effort: run.effort,
    attempt: run.attempt,
    cause: pause.cause,
    reset: pause.reset,
    threshold: pause.cause === "pause threshold" ? threshold : null,
    label: configuration.labels.paused,
  });
}

// A claim no run holds has no model or log to name.
function failureComment(
  configuration: FactoryConfiguration,
  failure: string,
  log: string | null,
  run?: HostRun,
  unpushed?: string[],
): string {
  return renderComment("failure", configuration.comments?.failure, {
    failure,
    provider: run?.provider,
    model: run?.model,
    effort: run?.effort,
    attempt: run?.attempt,
    log,
    unpushable: unpushed,
    unpushableCount: unpushed?.length || undefined,
    label: configuration.labels.failed,
  });
}
