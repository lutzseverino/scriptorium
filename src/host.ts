// The host runner: each pass reads every repository the host configuration
// lists, asks the decision core what to do across all of them, and carries
// the decisions out through each repository's hosting platform, its clone and
// the providers' sandboxes.
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
  PlatformError,
  type ConnectOptions,
  type ConnectionWithLinkAdditions,
} from "@lutzseverino/postern";
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
  factoryHoldReason,
  releaseHoldReason,
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
  relationshipSections,
  repositoryPlatform,
  runBranch,
  type RepositoryPlatform,
  type MergeRelaunch,
  type InputResume,
} from "./platform.ts";
import {
  githubTokens,
  sandboxEnvironment,
  writeSandboxToken,
} from "./github-token.ts";
import type { HostConfiguration } from "./host-configuration.ts";
import { ImageStorageHold, type ImageStorageStatus } from "./image-storage.ts";
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
  // Connects to the hosting platform of the repository at the remote URL,
  // throwing a `PlatformError` with reason `unsupported` for a remote no
  // platform adapter serves.
  connect(remote: string, options: ConnectOptions): ConnectionWithLinkAdditions;
  // Runs Git in `cwd`, authenticating to GitHub as the token's holder.
  git(token: string, cwd: string, args: string[]): Promise<string>;
  // Runs the host's token command for the repository and resolves the token
  // it printed.
  token(repository: string): Promise<string>;
  // The URL the repository is cloned from, which names its platform.
  remoteUrl(repository: string): string;
  // Builds the sandbox image over the repository's toolchain Dockerfile, with
  // the host's image builder, and resolves its tag.
  buildImage(dockerfile: string): Promise<string>;
  // Private diagnostics of the last storage admission decision.
  imageStorageStatus?(): ImageStorageStatus | undefined;
  // Removes the factory's obsolete sandbox images beyond the host's
  // allowance, keeping every `current` and `running` image and every image a
  // container uses. Rejects, removing nothing, when its inventory fails.
  retainImages(current: string[], running: string[]): Promise<Retention>;
  // Prunes the factory builder's cache past the host's minimum age when the
  // host builds there, and resolves the space freed, or null when nothing was.
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
  // Successful awaiting-merge notice for this attempt, independent of the
  // ending observation refreshed on each pass and on startup.
  awaitingMergeNotified?: true;
  // PR/head pairs whose automatic merge recovery has already launched.
  mergeRelaunchHeads?: string[];
  // Items carrying the release or factory hold label observed during this
  // run, retained even after the hold clears. Both holds defer merges.
  releaseHoldObserved?: number[];
  releaseHoldSettled?: true;
  // Run-owned PRs whose merges this run deferred for either hold,
  // independent of eligibility.
  releaseHeld?: number[];
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
// platform reads this pass, so only its running sandboxes reach the snapshot.
type Pass = {
  name: string;
  paused: string | null;
  platform: RepositoryPlatform | null;
  image: string | null;
  read: Repository | null;
  configuration: FactoryConfiguration | null;
  hasReviewPolicy: boolean;
  releaseHold?: number[] | null;
  // Open issues and PRs carrying `labels.hold`; null when the read failed.
  factoryHold?: number[] | null;
  releaseHeld: Map<number, number[]>;
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
      claims: join(root, "claims"),
      // Each running sandbox's private directory.
      sandboxes: join(root, "sandboxes"),
    };
  }

  async function read(name: string): Promise<Pass> {
    const pass: Pass = {
      name,
      paused: null,
      platform: null,
      image: null,
      read: null,
      configuration: conventions.get(name) ?? null,
      hasReviewPolicy: false,
      releaseHeld: new Map(),
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
      pass.hasReviewPolicy =
        (
          await git(clone, [
            "ls-tree",
            "--name-only",
            "HEAD",
            "--",
            ".github/factory-review-policy.json",
          ])
        ).trim() === ".github/factory-review-policy.json";
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
          pause(
            error instanceof ImageStorageHold
              ? error.message
              : `its sandbox image did not build: ${error}`,
          );
        }
    } catch (error) {
      pause(`its clone did not update: ${error}`);
    }
    if (!pass.configuration) return pass;
    const served = connect(name);
    if ("refused" in served) {
      pause(served.refused);
      return pass;
    }
    const platform = repositoryPlatform(served.connection, pass.configuration);
    pass.platform = platform;
    try {
      await platform.createStateLabels();
    } catch (error) {
      if (pass.paused === null)
        pause(`its state labels could not be created: ${error}`);
    }
    if (pass.configuration.labels.releaseHold !== undefined) {
      try {
        pass.releaseHold = await platform.readReleaseHold();
      } catch (error) {
        pass.releaseHold = null;
        report(`${name} relaunch waits: release hold read failed: ${error}`);
      }
    }
    if (pass.configuration.labels.hold !== undefined) {
      try {
        pass.factoryHold = await platform.readHold();
      } catch (error) {
        pass.factoryHold = null;
        report(`${name} factory hold read failed: ${error}`);
      }
    }
    // Persist before settlement or launch decisions: a later clear read must
    // not erase a hold that affected a still-running attempt.
    const observed = [...(pass.releaseHold ?? []), ...(pass.factoryHold ?? [])];
    for (const run of runs.filter(
      (run) => run.repository === name && !run.releaseHoldSettled,
    )) {
      if (observed.length) {
        run.releaseHoldObserved = [
          ...new Set([...(run.releaseHoldObserved ?? []), ...observed]),
        ];
        record(run);
      }
    }
    try {
      const issues = await platform.readIssues();
      for (const run of runs.filter(
        (run) => run.repository === name && run.exited && !run.interrupted,
      )) {
        await run.finished;
        if (pausedEnding(run)) continue;
        const observation = await platform.pullRequestObservation(
          run.issue,
          run.pullRequestSince,
        );
        if (!run.releaseHoldSettled) {
          const held = observation.ownedPullRequests.filter(
            (own) =>
              pass.releaseHold === null ||
              pass.factoryHold === null ||
              (run.releaseHoldObserved ?? []).some((number) => number !== own),
          );
          if (held.length) {
            run.releaseHeld = held;
            // A merge attempt stopped by a hold did not spend its
            // head's recovery opportunity. Other consumed heads stay bounded.
            if (run.mergeRelaunch && held.includes(run.mergeRelaunch.number))
              run.mergeRelaunchHeads = run.mergeRelaunchHeads?.filter(
                (head) => head !== mergeHead(run.mergeRelaunch!),
              );
          }
          run.releaseHoldSettled = true;
          record(run);
        }
        // Historical marks survive temporary ineligibility; visible reasons
        // concern only PRs that are still open and owned in this pass.
        pass.releaseHeld.set(
          run.issue,
          (run.releaseHeld ?? []).filter((number) =>
            observation.ownedPullRequests.includes(number),
          ),
        );
        const mergeCandidate = await readMergeCandidate(
          git,
          clone,
          issues.find((issue) => issue.number === run.issue),
          observation.mergeCandidate,
          run.mergeRelaunchHeads ?? [],
          pass,
          run.releaseHeld,
        );
        run.ended = {
          ...(mergeCandidate && { mergeCandidate }),
          // Sandcastle's idle timeout can end a run at its limit before the
          // factory stops it, so the time it ran decides, not who ended it.
          timedOut:
            run.stopped ||
            run.exitedAt!.getTime() - Date.parse(run.startedAt) >=
              settings.timeLimitMinutes * 60_000,
          ...(run.ended && "orphaned" in run.ended && { orphaned: true }),
          pullRequest: observation.state,
          ...(observation.closesIssue && { closesIssue: true }),
        };
        const paths = await readUnpushableChanges(
          git,
          clone,
          issues.find((issue) => issue.number === run.issue),
          run.ended.pullRequest,
          pass.configuration.labels.needsInput,
        );
        if (paths.length) run.ended.unpushedChanges = paths;
      }
      pass.read = {
        name,
        configuration: pass.configuration,
        authorization: served.authorization,
        paused: pass.paused,
        issues,
        ...(pass.releaseHold !== undefined && {
          releaseHold: pass.releaseHold,
        }),
        ...(pass.factoryHold !== undefined && {
          factoryHold: pass.factoryHold,
        }),
        claims: await readClaims(
          name,
          platform,
          issues,
          pass.configuration.labels,
          pass,
        ),
      };
    } catch (error) {
      pause(`its platform reads failed: ${error}`);
    }
    return pass;
  }

  // The repository's platform connection and readiness policy, from the
  // platform its remote names and the host's settings for that platform, or
  // why the factory doesn't serve it. A platform that marks no bots needs the
  // accounts that never authorize named.
  function connect(name: string):
    | {
        connection: ConnectionWithLinkAdditions;
        authorization: Repository["authorization"];
      }
    | { refused: string } {
    let connection;
    try {
      connection = ports.connect(ports.remoteUrl(name), {
        // Each request takes the token as it stands.
        credential: () => tokens.get(name),
        relationshipSections,
      });
    } catch (error) {
      return {
        refused:
          error instanceof PlatformError && error.reason === "unsupported"
            ? `its remote is on no platform the factory serves: ${error.message}`
            : `its platform connection failed: ${error}`,
      };
    }
    const { platform } = connection.repository;
    const settings = configuration.platforms[platform];
    if (!settings)
      return {
        refused: `the host configuration has no settings for its platform, ${platform}`,
      };
    if (
      !connection.issueTracker.capabilities.botMarking &&
      settings.neverAuthorize === undefined
    )
      return {
        refused: `${platform} marks no bots, so the host configuration must list the accounts that never authorize in platforms.${platform}.neverAuthorize`,
      };
    return {
      connection,
      authorization: {
        authorizedRoles: settings.authorizedRoles,
        neverAuthorize: settings.neverAuthorize ?? [],
      },
    };
  }

  // Reconcile closed issues even when a live run holds them or their only
  // remaining marker is needs-input. Open claims keep pending questions.
  async function readClaims(
    name: string,
    platform: RepositoryPlatform,
    issues: Issue[],
    labels: FactoryConfiguration["labels"],
    pass: Pass,
  ): Promise<Claim[]> {
    const held = (number: number) =>
      runs.some((run) => run.repository === name && run.issue === number);
    const claims: Claim[] = [];
    const closed = await platform.readClosedClaims();
    for (const number of closed) await platform.releaseClosed(number);
    const markerDirectory = directory(name).claims;
    const waiting = existsSync(markerDirectory)
      ? readdirSync(markerDirectory)
          .filter((file) => /^issue-\d+\.json$/.test(file))
          .map((file) => Number(file.slice(6, -5)))
          .filter((number) => readClaimMarker(name, number).inputResume)
      : [];
    const numbers = [
      ...new Set([
        ...waiting,
        ...closed,
        ...issues
          .filter(
            (issue) =>
              issue.labels.includes(labels.running) ||
              issue.labels.includes(labels.paused) ||
              issue.labels.includes(labels.needsInput),
          )
          .map((issue) => issue.number),
      ]),
    ];
    const { clone } = directory(name);
    const git: Git = async (cwd, args) =>
      ports.git(await tokens.get(name), cwd, args);
    for (const number of numbers) {
      if (held(number)) continue;
      const marker = readClaimMarker(name, number);
      const issue = issues.find((issue) => issue.number === number);
      if (
        marker.inputResume &&
        issue &&
        !issue.labels.includes(labels.needsInput) &&
        (issue.labels.includes(labels.running) ||
          issue.labels.includes(labels.paused))
      ) {
        // A prior release may have failed after persisting its resume marker.
        // No host run owns this claim; finish releasing it before pickup gates.
        await platform.release(number);
        issue.labels = issue.labels.filter(
          (label) => label !== labels.running && label !== labels.paused,
        );
      }
      const observation = await platform.pullRequestObservation(
        number,
        marker.inputResume?.since,
      );
      const mergeCandidate = await readMergeCandidate(
        git,
        clone,
        issues.find((issue) => issue.number === number),
        observation.mergeCandidate,
        marker.mergeRelaunchHeads ?? [],
        pass,
      );
      const claim: Claim = {
        issue: number,
        ...(marker.inputResume && {
          inputResume: {
            ...marker.inputResume,
            pullRequests: [
              ...new Map(
                [
                  ...marker.inputResume.pullRequests,
                  ...observation.pullRequests,
                ].map((pr) => [pr.number, pr]),
              ).values(),
            ],
          },
        }),
        pullRequest: observation.state,
        ...(observation.closesIssue && { closesIssue: true }),
        ...(mergeCandidate && { mergeCandidate }),
      };
      const paths = await readUnpushableChanges(
        git,
        clone,
        issues.find((issue) => issue.number === number),
        claim.pullRequest,
        labels.needsInput,
      );
      if (paths.length) claim.unpushedChanges = paths;
      claims.push(claim);
    }
    // A label-only claim's notice lives as long as the observed claim. Keep
    // it across label swaps, but not after the claim disappears.
    const { claims: notices } = directory(name);
    const retained = new Set(claims.map(({ issue }) => `issue-${issue}.json`));
    if (existsSync(notices))
      for (const file of readdirSync(notices))
        if (/^issue-\d+\.json$/.test(file) && !retained.has(file))
          rmSync(join(notices, file));
    return claims;
  }

  function claimNoticePath(repository: string, issue: number): string {
    return join(directory(repository).claims, `issue-${issue}.json`);
  }

  function readClaimMarker(
    repository: string,
    issue: number,
  ): {
    awaitingMergeNotified?: true;
    inputResume?: InputResume;
    mergeRelaunchHeads?: string[];
  } {
    const path = claimNoticePath(repository, issue);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  }

  // This is observation only. Delivery Git operations stay with the agent.
  // rev-list is empty exactly when origin/HEAD is an ancestor of the head,
  // including diverged histories without relying on a platform freshness fact.
  async function readMergeCandidate(
    git: Git,
    clone: string,
    issue: Issue | undefined,
    candidate: MergeRelaunch | undefined,
    consumed: string[],
    pass: Pass,
    releaseHeld?: number[],
  ): Promise<MergeRelaunch | undefined> {
    if (
      !candidate ||
      !issue ||
      pass.paused !== null ||
      issue.labels.includes(pass.configuration!.labels.needsInput) ||
      issue.labels.includes(pass.configuration!.labels.failed) ||
      consumed.includes(mergeHead(candidate))
    )
      return undefined;
    const defaultRef = (
      await git(clone, ["symbolic-ref", "refs/remotes/origin/HEAD"])
    ).trim();
    if (
      candidate.baseBranch !== defaultRef.slice("refs/remotes/origin/".length)
    )
      return undefined;
    if (releaseHeld?.includes(candidate.number)) return candidate;
    await git(clone, [
      "fetch",
      "--quiet",
      "--no-tags",
      "origin",
      candidate.headCommit,
    ]);
    const behind = (
      await git(clone, [
        "rev-list",
        "--max-count=1",
        `${candidate.headCommit}..refs/remotes/origin/HEAD`,
      ])
    ).trim();
    return behind ? candidate : undefined;
  }

  function mergeHead(target: MergeRelaunch): string {
    return `${target.number}:${target.headCommit}`;
  }

  // Earlier outcome rows settle without consulting the branch. Both runs
  // and claims assess delivery against the same refreshed remote default branch.
  async function readUnpushableChanges(
    git: Git,
    clone: string,
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
    rmSync(claimNoticePath(decision.repository, decision.issue), {
      force: true,
    });
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
          // Older awaiting-merge records predate this hold; they acquire no
          // new sticky evidence merely because the process restarted.
          ...((recorded.releaseHoldSettled ||
            (recorded.ended && "pullRequest" in recorded.ended)) && {
            releaseHoldSettled: true,
          }),
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
    const marker = previous ?? readClaimMarker(repository, issue);
    const mergeRelaunchHeads = [...(marker.mergeRelaunchHeads ?? [])];
    if (
      decision.mergeRelaunch &&
      !mergeRelaunchHeads.includes(mergeHead(decision.mergeRelaunch))
    )
      mergeRelaunchHeads.push(mergeHead(decision.mergeRelaunch));
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
      ...(decision.inputResume && { inputResume: decision.inputResume }),
      ...(decision.mergeRelaunch && { mergeRelaunch: decision.mergeRelaunch }),
      ...(mergeRelaunchHeads.length && { mergeRelaunchHeads }),
      releaseHoldObserved: [
        ...new Set([
          ...(previous?.ended &&
          ("interrupted" in previous.ended || "paused" in previous.ended)
            ? (previous.releaseHoldObserved ?? [])
            : []),
          ...(pass.releaseHold ?? []),
          ...(pass.factoryHold ?? []),
        ]),
      ],
      ...(decision.relaunch &&
        marker.awaitingMergeNotified && { awaitingMergeNotified: true }),
      startedAt,
      pullRequestSince:
        previous?.pullRequestSince ??
        decision.inputResume?.since ??
        decision.inputResume?.pullRequests[0]?.createdAt ??
        decision.mergeRelaunch?.createdAt ??
        startedAt,
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
          registry.providers
            .get(run.provider)!
            .renderInvocation(
              pass.configuration!.skill,
              pass.configuration!.arguments.replaceAll(
                "{issue}",
                String(issue),
              ),
            ),
          pass.hasReviewPolicy,
          decision.retry,
          recovery,
          decision.mergeRelaunch,
          decision.inputResume,
          pass.configuration!.labels.releaseHold,
          pass.configuration!.labels.hold,
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
    const platform = pass.platform!;
    switch (decision.kind) {
      case "close": {
        await platform.close(decision.issue, decision.tickets);
        const run = find(decision);
        if (run && !run.exited)
          run.controller.abort(new Error("its parent issue is closed"));
        forget(decision);
        return;
      }
      case "complete":
        await platform.complete(decision.issue);
        forget(decision);
        return;
      case "claim":
        await platform.claim(decision.issue);
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
        await platform.fail(
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
        if (run) {
          if (!run.awaitingMergeNotified) {
            await platform.awaitingMerge(
              decision.issue,
              awaitingMergeComment(pass.configuration!, run),
            );
            run.awaitingMergeNotified = true;
          }
          record(run);
        } else {
          const path = claimNoticePath(decision.repository, decision.issue);
          if (!existsSync(path)) {
            await platform.awaitingMerge(
              decision.issue,
              awaitingMergeComment(pass.configuration!),
            );
            mkdirSync(directory(decision.repository).claims, {
              recursive: true,
            });
            writeFileSync(
              `${path}.partial`,
              '{"awaitingMergeNotified":true}\n',
            );
            renameSync(`${path}.partial`, path);
          }
        }
        return;
      }
      case "release": {
        const issue = pass.read?.issues.find(
          (issue) => issue.number === decision.issue,
        );
        const waiting = issue?.labels.includes(
          pass.configuration!.labels.needsInput,
        );
        const previous = find(decision);
        const marker = readClaimMarker(decision.repository, decision.issue);
        if (waiting) {
          const since = previous?.pullRequestSince ?? marker.inputResume?.since;
          const observation = await platform.pullRequestObservation(
            decision.issue,
            since,
          );
          const path = claimNoticePath(decision.repository, decision.issue);
          mkdirSync(directory(decision.repository).claims, { recursive: true });
          writeFileSync(
            `${path}.partial`,
            JSON.stringify({
              ...marker,
              inputResume: {
                ...(since && { since }),
                pullRequests: observation.pullRequests,
              },
            }),
          );
          renameSync(`${path}.partial`, path);
        }
        await platform.release(decision.issue);
        if (waiting) {
          // Keep the durable resume marker while retiring the attempt.
          if (previous) {
            runs.splice(runs.indexOf(previous), 1);
            previous.settled = true;
            record(previous);
          }
        } else forget(decision);
        return;
      }
      case "pause": {
        const run = find(decision);
        const ended = run && pausedEnding(run);
        if (!ended) return;
        await platform.pause(
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
        await platform.unpause(decision.issue);
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
          ...(run.inputResume && { inputResume: run.inputResume }),
          ...(run.mergeRelaunch && { mergeRelaunch: run.mergeRelaunch }),
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
    for (const pass of passes) {
      if (pass.paused !== null)
        report(`${pass.name} is paused: ${pass.paused}`);
      const held = factoryHeld(pass);
      if (held !== null) report(`${pass.name} is held: ${held}`);
    }
    const decisions = decideFactory(snapshot, registry);
    // Hold comments retry independently; their availability never prevents
    // a time-limit stop or settlement of existing work.
    for (const pass of passes) {
      if (!pass.read || !pass.platform) continue;
      for (const issue of pass.read.issues) {
        if (interrupting) break;
        const holds = decisions.flatMap((decision) =>
          decision.repository === pass.name &&
          decision.issue === issue.number &&
          decision.kind === "skip" &&
          decision.hold
            ? [{ key: decision.hold, reason: decision.reason }]
            : [],
        );
        const held = pass.releaseHeld.get(issue.number);
        if (
          held?.length &&
          !holds.some((hold) => hold.key === "release-hold")
        ) {
          const reason = releaseHoldReason(pass.releaseHold, held);
          if (reason) holds.push({ key: "release-hold", reason });
        }
        if (
          held?.length &&
          !holds.some((hold) => hold.key === "factory-hold")
        ) {
          const reason = factoryHoldReason(
            pass.configuration?.labels.hold,
            pass.factoryHold,
            held,
          );
          if (reason) holds.push({ key: "factory-hold", reason });
        }
        try {
          await pass.platform.reconcileHolds(issue.number, holds);
        } catch (error) {
          report(
            `${pass.name}#${issue.number} hold comments failed; reconciliation retries next pass: ${error}`,
          );
        }
      }
    }
    // A failed transition stops the repository's later decisions, such as
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
    const imageStorage = ports.imageStorageStatus?.();
    try {
      await writeStatus(
        join(configuration.stateDirectory, "status.json"),
        hostStatus(
          snapshot.now,
          passes.map((pass) => ({
            name: pass.name,
            paused: pass.paused ?? factoryHeld(pass),
          })),
          decisions,
          providers,
          imageStorage
            ? (JSON.parse(
                redactor.redact(JSON.stringify(imageStorage)),
              ) as ImageStorageStatus)
            : undefined,
          runs.filter((run) => !run.exited),
        ),
      );
    } catch (error) {
      report(`the status file was not written: ${error}`);
    }
    if (!interrupting) await retain(passes);
    return decisions;
  }

  // Once a pass has prepared every repository's image, the factory's obsolete
  // images beyond the host's allowance go. A repository without one this pass
  // could still need any of them, so until then none goes. On a host that
  // builds in the factory builder, its old cache is pruned either way. A
  // failure here is reported and leaves the pass and its images as they are.
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

  // Why the repository's factory hold pauses it this pass, or null.
  function factoryHeld(pass: Pass): string | null {
    return factoryHoldReason(
      pass.configuration?.labels.hold,
      pass.factoryHold,
      [],
    );
  }

  // After launches have been stopped or finished, wait for their log and
  // record writes, including runs a later pass has already forgotten.
  async function drain(): Promise<void> {
    await Promise.all(pending);
  }

  return { tick, interrupt, drain, refreshTokens, report };
}

export function prompt(
  start: string,
  hasReviewPolicy: boolean,
  retry?: { failure: string; log: string },
  recovery?: Recovery,
  mergeRelaunch?: MergeRelaunch,
  inputResume?: InputResume,
  releaseHoldLabel?: string,
  holdLabel?: string,
): string {
  const guidance = [
    "Unattended execution:",
    `This is a factory run.${hasReviewPolicy ? " Apply the repository-owned app-author review policy before requesting or waiting for external review of this run's own PRs, including after fixes, rebases, retries and resumed runs." : ""} Keep required checks, internal reviews, merge authorization and handling of findings that arrive enforced. Use only the supplied credentials; never discover or switch identities to trigger a review.`,
    "Before every delivery push, fetch origin and resolve its remote default branch again (for example, git fetch --prune origin, then git remote set-head origin --auto). Inspect the outgoing commits, including per-parent patches for merges (git log --stat --patch -m origin/HEAD..HEAD), and the change against that refreshed base (git diff origin/HEAD...HEAD). Keep both history and diff limited to the issue's work. A clean final diff can conceal reverted workflow edits or unrelated rewritten commits. When an update is needed, safely rebase or replay only the issue's own changes onto the current base. Never merge the default branch into the issue branch. Intentional workflow edits must remain visible; never discard them to bypass permissions. Revalidate a reconstructed change before publication.",
    "Preserve committed, staged, unstaged and untracked work and existing PR, review and handoff context before changing history. Continuing a branch does not require retaining unrelated history or override an owner's explicit request to reconstruct the issue's changes on the current base. If ownership is uncertain or reconstruction has conflicts, preserve the work and hand off under the repository's owner-question rules. After any permission refusal, stop with an explicit owner handoff: no second push, credential discovery or identity switch. Do not assume broader App permissions are necessary; ask the owner how to proceed.",
    "There is no interactive notification or resume loop. Keep commands in the foreground and wait for validation to finish; inspect its final exit status before PR delivery. Do not yield while work is pending; detaching shell commands with &, nohup, disown or similar is not a substitute. A timeout is a failure to resolve, never evidence of a pass. Use bounded foreground command timeouts within the run's time limit.",
    `Emit ${completionSignal} only after the requested delivery or explicit owner handoff is actually recorded. The signal is loop control; GitHub outcomes still determine delivery.`,
    ...(releaseHoldLabel === undefined
      ? []
      : [
          `Release hold: before any merge, check for open PRs carrying the label ${JSON.stringify(releaseHoldLabel)}, other than your own PR. While any exists, do not merge: finish implementation, validation and review, leave your PR open and end the run. The factory resumes merging after the hold ends. Installed babysit's merge check (repo-canon #742) supplies the mid-run guard and its release-hold exit; the prompt alone cannot prevent a release PR opened mid-run from racing a merge.`,
        ]),
    ...(holdLabel === undefined
      ? []
      : [
          `Factory hold: before any merge, check for open issues and PRs carrying the label ${JSON.stringify(holdLabel)}, other than your own PR. While any exists, do not merge: finish implementation, validation and review, leave your PR open and end the run. The factory resumes merging after the hold ends. Installed babysit's merge check (repo-canon #789) supplies the mid-run guard and its hold exit; the prompt alone cannot stop a merge already under way.`,
        ]),
    ...(mergeRelaunch
      ? [
          `Merge relaunch: bring PR #${mergeRelaunch.number}, relaunched for head ${mergeRelaunch.headCommit}, onto the current default branch (${mergeRelaunch.baseBranch}); revalidate it; push; wait for current-head checks and reviews; then merge it through the repository's installed babysit under the existing merge authorization. Preserve this same PR, its reviews and handoff context and all dirty work. Where installed babysit supports branch-update recovery, follow it, including stale-base exit 4. Otherwise use the delivery-push instructions above to rebase or replay only this issue's changes and revalidate; babysit's other merge gates still apply. Conflicts, failed validation or checks, uncertain ownership and permission refusals require preserving work and a reasoned owner handoff without merging. Never use GitHub update-branch or merge the default branch into the issue branch.`,
          "The recovery-state restriction below applies only to restoring local state. After that restoration, this merge-relaunch delivery is authorized subject to the repository's existing merge rules.",
        ]
      : []),
    ...(inputResume
      ? [
          `Needs-input resume: continue ${inputResume.pullRequests.length ? inputResume.pullRequests.map((pr) => `PR #${pr.number} (${pr.state}, branch ${pr.headBranch})`).join(", ") : "the preserved issue work"}. Preserve the same PR, its reviews, owner answers and handoff context, and bring only this issue's work onto the current default branch under the delivery instructions above. Reopen an existing closed-unmerged PR when needed. Never open a replacement PR. If PR ownership or identity is uncertain, preserve work and record an owner handoff. Readiness, usage and merge authorization still apply. The recovery-state restriction below applies only to restoring local state; after restoration this continuation and delivery are authorized under the repository's merge rules.`,
        ]
      : []),
    ...(recovery
      ? [
          `Recovery state: ${JSON.stringify(recovery)}. Continue from this preserved branch and worktree, including committed, staged, unstaged and untracked changes, applying the delivery and reconstruction instructions above. Revalidate recovered work before publication. Recovery itself must not push, open a PR, merge, close the issue or grant readiness.`,
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

// A retained claim without a host run has no model or log to name.
function awaitingMergeComment(
  configuration: FactoryConfiguration,
  run?: HostRun,
): string {
  return renderComment("awaitingMerge", configuration.comments?.awaitingMerge, {
    provider: run?.provider,
    model: run?.model,
    effort: run?.effort,
    attempt: run?.attempt,
    log: run?.log,
    label: configuration.labels.running,
  });
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
