// The host runner: each pass reads every repository the host configuration
// lists, asks the decision core what to do across all of them, and carries
// the decisions out through each repository's hosting platform, its clone and
// the providers' sandboxes.
import { randomUUID } from "node:crypto";
import { trustedFinding, type Provenance } from "./triggers.ts";
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
import { updateClone, readRecovery, type Git } from "./clone.ts";
import {
  factoryConfigurationPath,
  launchArguments,
  readFactoryConfiguration,
  runKind,
  type FactoryConfiguration,
  type RunKindName,
} from "./factory-configuration.ts";
import {
  askLabels,
  claimLabels,
  gateLabels,
  isStopped,
  stopLabels,
  transition,
} from "./label-roles.ts";
import {
  modelPolicyPath,
  readModelPolicy,
  type ModelPolicy,
} from "./model-policy.ts";
import {
  decideFactory,
  pullRequestIdentity,
  providerRunCounts,
  type Claim,
  type Continuation,
  type Decision,
  type Issue,
  type Pause,
  type Repository,
  type Run,
  type Settings,
  type Snapshot,
} from "./factory.ts";
import {
  ownedPullRequests,
  repositoryHold,
  observeHolds,
} from "./repository-holds.ts";
import {
  relationshipSections,
  repositoryPlatform,
  runBranch,
  type RepositoryPlatform,
} from "./platform.ts";
import {
  githubTokens,
  runKindPermissions,
  sandboxEnvironment,
  version2Permissions,
  writeSandboxToken,
  type TokenCommand,
} from "./github-token.ts";
import type { HostConfiguration } from "./host-configuration.ts";
import { ImageStorageHold, type ImageStorageStatus } from "./image-storage.ts";
import type { Retention } from "./image-retention.ts";
import type { LaunchRequest, LaunchResult, Registry } from "./providers.ts";
import type { UsageWindow } from "./providers/usage.ts";
import {
  mergeHead,
  observeEnding,
  observeOwnership,
  type EndingReads,
} from "./run-ending.ts";
import {
  postedLabels,
  readRunResult,
  resultFile,
  resultGuidance,
  resultPost,
  sandboxResultDirectory,
} from "./run-result.ts";
import { createOwner } from "./owner.ts";
import { createRedactor } from "./redaction.ts";
import { pauseDeadline } from "./pause.ts";
import { followRunLog, readLogEnd } from "./run-log.ts";
import { prompt } from "./prompt.ts";
import { hostStatus, writeStatus } from "./status.ts";
import { createUsage } from "./usage.ts";
import type { Action, Phase, RunUpdate } from "./run-comment.ts";
import { createEvents, providerStatus } from "./events.ts";

export type HostPorts = {
  // Connects to the hosting platform of the repository at the remote URL,
  // throwing a `PlatformError` with reason `unsupported` for a remote no
  // platform adapter serves.
  connect(remote: string, options: ConnectOptions): ConnectionWithLinkAdditions;
  // Runs Git in `cwd`, authenticating to GitHub as the token's holder.
  git(token: string, cwd: string, args: string[]): Promise<string>;
  // Runs the host's token command for the repository, narrowed to the
  // permissions for a sandbox's token, and resolves the token it printed.
  token: TokenCommand;
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
export const dockerfilePath = ".scriptorium/Dockerfile";

type HostRun = Run & {
  provenance?: Provenance;
  // Its run result's comment and labels are on the issue.
  resultPosted?: true;
  // PR/head pairs whose automatic merge recovery has already launched.
  mergeRelaunchHeads?: string[];
  launchResult?: LaunchResult;
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
  // The token the sandbox's token file holds, narrowed to its run kind; it is
  // never recorded.
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
  // The repository's model policy from the same revision, null without one.
  modelPolicy: ModelPolicy | null;
  releaseHold?: number[] | null;
  // Open issues and PRs carrying `labels.hold`; null when the read failed.
  factoryHold?: number[] | null;
  // Open PRs carrying a gate label; null when the read failed.
  gated?: number[] | null;
};

export function createHost(
  configuration: HostConfiguration,
  registry: Registry,
  ports: HostPorts,
) {
  const runs: HostRun[] = [];
  // Recovered endings that still need their first platform observation.
  const unobserved = new WeakSet<HostRun>();
  // A bad edit pauses pickup, but runs still settle with the last valid conventions.
  const conventions = new Map<string, FactoryConfiguration>();
  // Every token the command prints and every provider credential value a
  // launch delivers stays out of the logs and the status file.
  const redactor = createRedactor();
  const tokens = githubTokens(ports.token, ports.now, redactor);
  const report = (line: string) => ports.report(redactor.redact(line));
  // Git as the repository's own token holder, a token no sandbox gets. Each
  // call takes the token as it stands, so a long pass outlives none.
  const hostGit =
    (repository: string): Git =>
    async (cwd, args) =>
      ports.git(await tokens.get(repository), cwd, args);
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
    ...(configuration.models.triage !== undefined && {
      triageModel: configuration.models.triage,
    }),
    ...(configuration.models.review !== undefined && {
      reviewModel: configuration.models.review,
    }),
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
    const counts = providerRunCounts(
      runs.map((run) => ({
        provider: run.provider,
        ended: run.exited ? run.ended : null,
      })),
    );
    return Object.keys(configuration.providers).map((provider) =>
      providerStatus(
        provider,
        ports.now().toISOString(),
        providerReadings[provider] ?? null,
        providerHolds[provider] ?? null,
        controls[provider] ?? null,
        configuration.usage,
        counts.get(provider)?.running ?? 0,
        (counts.get(provider)?.paused ?? 0) +
          runs.filter(
            (run) => run.provider === provider && !run.exited && run.pausing,
          ).length,
        {
          cap: configuration.providers[provider]!.cap,
          retained: counts.get(provider)?.retained ?? 0,
        },
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
      modelPolicy: null,
    };
    const pause = (reason: string) => (pass.paused = redactor.redact(reason));
    // A repository whose own token fails to print is paused for the pass.
    try {
      await tokens.get(name);
    } catch (error) {
      pause(`${error instanceof Error ? error.message : error}`);
      return pass;
    }
    const git = hostGit(name);
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
      // Model policy belongs to version 3. Version 2 keeps its configured
      // issue-label selection and host defaults, regardless of this file.
      if (pass.configuration?.version === 3)
        try {
          // A present unreadable policy holds launches rather than reading
          // as absence, just as invalid configuration does.
          pass.modelPolicy = readModelPolicy(join(clone, modelPolicyPath));
        } catch (error) {
          if (pass.paused === null)
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
              : `its sandbox image did not build from ${dockerfilePath}: ${error}`,
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
    // A review stopped at a gate resumes once no gate label remains.
    if (
      runKind(pass.configuration, "review") &&
      gateLabels(pass.configuration.labels).length
    ) {
      try {
        pass.gated = await platform.readGated();
      } catch (error) {
        pass.gated = null;
        report(`${name} gate read failed: ${error}`);
      }
    }
    // Persist before settlement or launch decisions: a later clear read must
    // not erase a hold that affected a still-running attempt.
    for (const run of runs.filter(
      (run) =>
        run.repository === name &&
        (!run.ended ||
          "interrupted" in run.ended ||
          "paused" in run.ended ||
          unobserved.has(run)),
    )) {
      run.holdObserved = observeHolds(run.holdObserved, pass);
      record(run);
    }
    try {
      const issues = await platform.readIssues();
      if (runKind(pass.configuration, "review"))
        issues.push(
          ...(await platform.readPullRequests(
            new Set(readProvenance(name).map((record) => record.issue)),
          )),
        );
      // A running worker can publish on another branch. Establish ownership
      // before admitting independent drafts, rather than waiting for its exit.
      if (issues.some((issue) => issue.pullRequest?.draft))
        for (const run of runs.filter(
          (run) => run.repository === name && !run.exited,
        )) {
          const observation = await platform.pullRequestObservation(
            run.issue,
            run.pullRequestSince,
            false,
            run.continuation.target?.number,
          );
          run.ownedPullRequests = [
            ...new Set([
              ...(run.ownedPullRequests ?? []),
              ...observation.ownedPullRequests,
            ]),
          ];
          record(run);
        }
      const provenance = readProvenance(name);
      for (const issue of issues) {
        const history = provenance.filter(
          (record) => record.issue === issue.number,
        );
        issue.trustedHistory = history.some((record) => record.trusted);
        issue.lastTriageAt = history
          .filter(
            (record) =>
              record.trigger && !record.trigger.id.startsWith("draft:"),
          )
          .map((record) => record.at)
          .sort()
          .at(-1);
        issue.reviewedHeads = history.flatMap((record) =>
          record.trigger?.id.startsWith("draft:")
            ? [record.trigger.id.slice(6)]
            : [],
        );
        issue.filedByTrustedRun = trustedFinding(issue, provenance, {
          ready: pass.configuration.labels.ready,
          ...served.authorization,
        });
      }
      const reads: EndingReads = {
        platform,
        git,
        clone,
        configuration: pass.configuration,
        paused: pass.paused !== null,
        unpushablePaths: configuration.unpushablePaths,
      };
      for (const run of runs.filter(
        (run) => run.repository === name && run.exited,
      )) {
        await run.finished;
        const issue = issues.find((issue) => issue.number === run.issue);
        const ended = {
          ...run,
          since: run.pullRequestSince,
          review: run.continuation.runKind === "review",
        };
        // An interrupted or paused run launches again; only its owned PRs
        // accumulate.
        if (run.interrupted || pausedEnding(run)) {
          run.ownedPullRequests = (
            await observeOwnership(platform, ended)
          ).owned;
          record(run);
          continue;
        }
        // The result's comment and labels land before its ending is
        // observed, so the ending reads the state it asked for.
        if (
          issue &&
          run.result &&
          !("invalid" in run.result) &&
          !run.resultPosted
        ) {
          const post = resultPost(
            run.result,
            {
              ...run,
              id: run.provenance?.id ?? run.startedAt,
              kind: run.continuation.runKind ?? "implement",
              attempt: run.continuation.attempt,
            },
            run.configuration,
          );
          const link = await platform.postResult(run.issue, post);
          issue.labels = postedLabels(issue.labels, post);
          run.resultPosted = true;
          record(run);
          await tell(pass, issue, {
            phase: phaseOf(run),
            facts: {
              state: outcomeStates[run.result.outcome],
              reason: run.result.reason,
              link,
            },
            result: run.result,
          });
        }
        const ending = await observeEnding(reads, issue, ended);
        run.ownedPullRequests = ending.ownedPullRequests;
        run.mergeRelaunchHeads = ending.mergeRelaunchHeads;
        run.ended = {
          ...ending.facts,
          // Sandcastle's idle timeout can end a run at its limit before the
          // factory stops it, so the time it ran decides, not who ended it.
          timedOut:
            run.stopped ||
            run.exitedAt!.getTime() - Date.parse(run.startedAt) >=
              settings.timeLimitMinutes * 60_000,
          ...(run.ended && "orphaned" in run.ended && { orphaned: true }),
        };
        unobserved.delete(run);
        record(run);
      }
      pass.read = {
        name,
        configuration: pass.configuration,
        authorization: served.authorization,
        ownedPullRequests: recordedPullRequests(name),
        paused: pass.paused,
        issues,
        ...(pass.releaseHold !== undefined && {
          releaseHold: pass.releaseHold,
        }),
        ...(pass.factoryHold !== undefined && {
          factoryHold: pass.factoryHold,
        }),
        modelPolicy: pass.modelPolicy,
        ...(pass.gated !== undefined && { gated: pass.gated }),
        claims: await readClaims(name, platform, issues, reads),
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
  // remaining marker is needs-input. Open claims keep pending questions, and
  // so does an issue whose run comment holds a released stop's continuation.
  async function readClaims(
    name: string,
    platform: RepositoryPlatform,
    issues: Issue[],
    reads: EndingReads,
  ): Promise<Claim[]> {
    const { labels } = reads.configuration;
    const held = (number: number) =>
      runs.some((run) => run.repository === name && run.issue === number);
    const claims: Claim[] = [];
    const closed = await platform.readClosedClaims();
    for (const number of closed) await platform.transition(number, "closed");
    const numbers = [
      ...new Set([
        ...issues
          .filter((issue) => issue.continuation)
          .map((issue) => issue.number),
        ...closed,
        ...issues
          .filter((issue) =>
            claimLabels(labels).some((label) => issue.labels.includes(label)),
          )
          .map((issue) => issue.number),
      ]),
    ];
    for (const number of numbers) {
      if (held(number)) continue;
      const issue = issues.find((issue) => issue.number === number);
      const inputResume = issue?.continuation;
      if (
        inputResume &&
        issue &&
        !isStopped(issue.labels, labels) &&
        transition(labels, "release").remove.some((label) =>
          issue.labels.includes(label),
        )
      ) {
        // A prior release may have failed after recording its continuation.
        // No host run owns this claim; finish releasing it before pickup.
        await platform.transition(number, "release");
        const released = transition(labels, "release").remove;
        issue.labels = issue.labels.filter(
          (label) => !released.includes(label),
        );
      }
      const ending = await observeEnding(reads, issue, {
        issue: number,
        since: inputResume?.since,
        continuation: {
          target: inputResume?.review?.target ?? issue?.pullRequest?.target,
        },
      });
      const claim: Claim = {
        issue: number,
        ...(inputResume && {
          inputResume: {
            ...inputResume,
            pullRequests: [
              ...new Map(
                [...inputResume.pullRequests, ...ending.pullRequests].map(
                  (pr) => [pr.number, pr],
                ),
              ).values(),
            ],
          },
        }),
        ...ending.facts,
      };
      claims.push(claim);
    }
    return claims;
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

  function readProvenance(name: string): Provenance[] {
    const path = join(directory(name).runs, "provenance");
    return existsSync(path)
      ? readdirSync(path)
          .filter((file) => file.endsWith(".json"))
          .map(
            (file) =>
              JSON.parse(readFileSync(join(path, file), "utf8")) as Provenance,
          )
      : [];
  }

  function recordedPullRequests(name: string): number[] {
    const path = directory(name).runs;
    const archived = readProvenance(name).flatMap(
      (record) => record.ownedPullRequests ?? [],
    );
    return existsSync(path)
      ? [
          ...archived,
          ...readdirSync(path)
            .filter((file) => /^issue-\d+-attempt-\d+\.json$/.test(file))
            .flatMap((file) => {
              const run: Partial<Run> & Pick<Continuation, "target"> =
                JSON.parse(readFileSync(join(path, file), "utf8"));
              // Settled legacy records are not migrated by startup.
              const target = run.continuation?.target ?? run.target;
              return [
                ...(run.ownedPullRequests ?? []),
                ...(target ? [target.number] : []),
              ];
            }),
        ]
      : archived;
  }

  // Replaces the run's record whole and at once, so a signal handler can
  // record it before the process exits.
  function record(run: HostRun) {
    const { controller: _c, token: _t, finished: _f, ...recorded } = run;
    const runsDirectory = directory(run.repository).runs;
    mkdirSync(runsDirectory, { recursive: true });
    const path = join(
      runsDirectory,
      `issue-${run.issue}-attempt-${run.continuation.attempt}.json`,
    );
    writeFileSync(`${path}.partial`, `${JSON.stringify(recorded, null, 2)}\n`);
    renameSync(`${path}.partial`, path);
    if (run.provenance) {
      const archive = join(runsDirectory, "provenance");
      mkdirSync(archive, { recursive: true });
      const provenancePath = join(archive, `${run.provenance.id}.json`);
      run.provenance.ownedPullRequests = [
        ...new Set([
          ...(run.provenance.ownedPullRequests ?? []),
          ...(run.ownedPullRequests ?? []),
          ...(run.continuation.target ? [run.continuation.target.number] : []),
        ]),
      ];
      writeFileSync(
        `${provenancePath}.partial`,
        `${JSON.stringify(run.provenance)}\n`,
      );
      renameSync(`${provenancePath}.partial`, provenancePath);
    }
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
        const holdSettled =
          recorded.releaseHoldSettled ||
          (recorded.ended && "pullRequest" in recorded.ended);
        if (!recorded.continuation) {
          recorded.continuation = {};
          for (const field of [
            "attempt",
            "retry",
            "inputResume",
            "mergeRelaunch",
            "runKind",
            "target",
            "handBacks",
            "implementedBy",
            "relaunch",
            "recovery",
            "trigger",
          ]) {
            if (recorded[field] !== undefined)
              recorded.continuation[field] = recorded[field];
            delete recorded[field];
          }
        }
        const restored: HostRun = {
          ...recorded,
          ownedPullRequests:
            recorded.ownedPullRequests ?? (holdSettled ? [] : undefined),
          // v3.0.1 stored derived held PRs. Preserve settled classification;
          // unsettled records retain their observations until the first read.
          holdObserved:
            "holdObserved" in recorded
              ? recorded.holdObserved
              : holdSettled
                ? recorded.releaseHeld?.length
                  ? null
                  : []
                : recorded.releaseHoldObserved,
          releaseHoldObserved: undefined,
          releaseHoldSettled: undefined,
          releaseHeld: undefined,
          exited: true,
          exitedAt: new Date(recorded.exitedAt ?? ports.now()),
          ended: recorded.interrupted
            ? { interrupted: true }
            : pausedEnding(recorded)
              ? recoveredPause(recorded)
              : recorded.pausing
                ? { paused: recorded.pausing }
                : {
                    timedOut: false,
                    pullRequest: "none",
                    // A run that left its result ended by itself; one
                    // without it ended with the earlier process.
                    ...(!recorded.result && { orphaned: true as const }),
                  },
          token: "",
          finished: Promise.resolve(),
          controller: new AbortController(),
        };
        if (!holdSettled) unobserved.add(restored);
        recovered.push(restored);
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
      if (run.pausing) run.ended = { paused: run.pausing };
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

  // A sandbox's token, narrowed to its run kind's permissions, or to version
  // 2's for a repository on that configuration version.
  const sandboxToken = (
    repository: string,
    { version }: FactoryConfiguration,
    kind: RunKindName,
  ) =>
    tokens.get(
      repository,
      version === 2 ? version2Permissions : runKindPermissions[kind],
    );

  // Refreshes every running sandbox's token within its run kind's
  // permissions, between passes as well as during them, so a run outlives
  // its first token and no run's token file holds another kind's token.
  async function refreshTokens() {
    for (const run of runs.filter((run) => !run.exited)) {
      const name = `${run.repository}#${run.issue}`;
      let token;
      try {
        token = await sandboxToken(
          run.repository,
          run.configuration,
          run.continuation.runKind ?? "implement",
        );
      } catch (error) {
        report(`${name}'s token was not refreshed: ${error}`);
        continue;
      }
      if (run.token !== token)
        try {
          await writeSandboxToken(join(run.sandbox, "github"), token);
          run.token = token;
        } catch (error) {
          // A run that exited meanwhile took its token file with it.
          if (!run.exited)
            report(`${name}'s token file was not rewritten: ${error}`);
        }
    }
  }

  async function launch(decision: Decision & { kind: "launch" }, pass: Pass) {
    const { repository, issue, continuation } = decision;
    const kind = continuation.runKind ?? "implement";
    // The decision core checked the arguments' placeholders for this launch.
    const invocationArguments = launchArguments(
      pass.configuration!,
      kind,
      issue,
      (continuation.target ?? continuation.mergeRelaunch)?.number,
    ) as string;
    const paths = directory(repository);
    // Run start mints the sandbox's token for its run kind alone.
    const token = await sandboxToken(repository, pass.configuration!, kind);
    const git = hostGit(repository);
    const base = (await git(paths.clone, ["rev-parse", "HEAD"])).trim();
    const previous = find(decision);
    const mergeRelaunchHeads = [...(previous?.mergeRelaunchHeads ?? [])];
    if (
      continuation.mergeRelaunch &&
      !mergeRelaunchHeads.includes(mergeHead(continuation.mergeRelaunch))
    )
      mergeRelaunchHeads.push(mergeHead(continuation.mergeRelaunch));
    const recovery = await readRecovery(git, paths.clone, runBranch(issue));
    const controller = new AbortController();
    const startedAt = ports.now().toISOString();
    // A relaunch appends to its attempt's log. Triage and review runs keep
    // their own logs beside implement's.
    const log = join(
      paths.logs,
      `issue-${issue}-${continuation.runKind ? `${continuation.runKind}-` : ""}attempt-${continuation.attempt}.log`,
    );
    await mkdir(paths.sandboxes, { recursive: true, mode: 0o700 });
    const sandbox = await mkdtemp(join(paths.sandboxes, `issue-${issue}-`));
    const raw = join(sandbox, "agent.log");
    let github, follower;
    try {
      await mkdir(join(sandbox, "github"), { mode: 0o700 });
      await mkdir(join(sandbox, "result"), { mode: 0o700 });
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
    const holdObserved =
      previous?.ended &&
      ("interrupted" in previous.ended || "paused" in previous.ended)
        ? previous.holdObserved
        : [];
    let account: string | null = null;
    try {
      account = await pass.platform!.filingAccount();
    } catch {
      // Installation tokens need not expose a viewer. Findings from an
      // unidentifiable credential require a person's trusted label.
    }
    const provenance: Provenance =
      continuation.relaunch && previous?.provenance
        ? previous.provenance
        : {
            id: randomUUID(),
            issue,
            at: startedAt,
            account,
            trusted: true,
            ...(decision.continuation.trigger && {
              trigger: decision.continuation.trigger,
            }),
          };
    const run: HostRun = {
      provenance,
      configuration: pass.configuration!,
      repository,
      base,
      image: pass.image!,
      issue,
      continuation: { ...continuation, ...(recovery && { recovery }) },
      provider: decision.provider,
      model: decision.model,
      effort: decision.effort,
      selection: decision.selection,
      ...(decision.diversity && { diversity: decision.diversity }),
      ...(mergeRelaunchHeads.length && { mergeRelaunchHeads }),
      holdObserved: observeHolds(holdObserved, pass),
      ownedPullRequests:
        previous?.ownedPullRequests ??
        continuation.inputResume?.pullRequests.map(({ number }) => number),
      startedAt,
      pullRequestSince:
        previous?.pullRequestSince ??
        continuation.inputResume?.since ??
        continuation.inputResume?.pullRequests[0]?.createdAt ??
        continuation.mergeRelaunch?.createdAt ??
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
    };
    try {
      record(run);
    } catch (error) {
      await follower.close().catch(() => {});
      await rm(sandbox, { recursive: true, force: true });
      throw error;
    }
    runs.push(run);
    if (decision.diversity === "unavailable")
      report(
        `${repository}#${issue} review runs on ${run.provider}, the provider of the implement attempt it reviews: provider diversity was unavailable`,
      );
    run.finished = ports
      .launch(run.provider, {
        model: run.model,
        effort: run.effort,
        name: `${repository}#${issue}`,
        cwd: paths.clone,
        image: pass.image!,
        prompt: prompt(run.continuation, {
          invocation: registry.providers
            .get(run.provider)!
            .renderInvocation(
              runKind(pass.configuration!, kind)!.skill,
              invocationArguments,
            ),
          retryTail: run.continuation.retry
            ? await retryLogTail(run.continuation.retry.log)
            : "",
          holds: ["release", "factory"].flatMap((scope) => {
            const held = repositoryHold(
              scope as "release" | "factory",
              pass,
              ownedPullRequests(
                run,
                run.continuation.target ?? run.continuation.mergeRelaunch,
              ),
            );
            return held ? [held] : [];
          }),
          resultPath: `${sandboxResultDirectory}/${resultFile}`,
          resultInstructions: resultGuidance(pass.configuration!, kind),
          reviewTarget:
            kind === "review"
              ? (continuation.target ?? continuation.mergeRelaunch)?.number
              : undefined,
          filingRun: provenance.id,
          models: kind === "triage" ? registry.modelFacts : undefined,
          credentialLimits:
            "Use only the supplied credentials; never discover or switch identities.",
        }),
        branch: runBranch(issue),
        log: raw,
        idleTimeoutSeconds: settings.timeLimitMinutes * 60,
        mounts: [
          github,
          {
            hostPath: join(sandbox, "result"),
            sandboxPath: sandboxResultDirectory,
          },
        ],
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
          const recovery = await readRecovery(
            git,
            paths.clone,
            runBranch(issue),
          );
          if (recovery) run.continuation.recovery = recovery;
          else delete run.continuation.recovery;
        } catch (error) {
          report(
            `recovery inspection for ${repository}#${issue} failed; retain the clone and inspect its run branch before retry: ${error}`,
          );
        }
        if (!run.launchResult?.completionSignal) {
          report(
            `${repository}#${issue} exited without completion signal; GitHub still decides delivery. Recovery state: ${JSON.stringify(run.continuation.recovery ?? { branch: runBranch(issue) })}; launch metadata: ${JSON.stringify(run.launchResult ?? null)}. Retain this clone and revalidate recovered work before publication.`,
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
        if (run.pausing) run.ended = { paused: run.pausing };
        else {
          run.result = readRunResult(
            join(sandbox, "result", resultFile),
            run.configuration,
            kind,
          );
          report(
            `${repository}#${issue} ${"invalid" in run.result ? `ended without a valid run result: ${run.result.invalid}` : `ended with its run result, ${run.result.outcome}${run.result.reason ? `: ${run.result.reason}` : ""}`}`,
          );
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
              };
            }
          } catch (error) {
            report(
              `run for ${repository}#${issue} could not read its raw log's end: ${error}`,
            );
          }
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
    await tell(
      pass,
      pass.read?.issues.find((item) => item.number === issue),
      {
        phase: phaseOf(run),
        facts: {
          state: "running",
          ...runFacts(run),
          link: undefined,
        },
      },
    );
  }

  // What an ended run or a claim observed of the issue's pull requests.
  function endedFacts(decision: Decision, pass: Pass) {
    const run = find(decision);
    return run?.ended && "pullRequest" in run.ended
      ? run.ended
      : pass.read?.claims.find((claim) => claim.issue === decision.issue);
  }

  // Writes the open issue's run comment and an action to tell once. A
  // progress write is best-effort. A final write, a continuation or an
  // action is required and rejects, so its decision retries on a later pass.
  async function tell(
    pass: Pass,
    issue: Issue | undefined,
    update: RunUpdate,
    action?: Action,
  ) {
    if (!issue) return;
    try {
      await pass.platform!.comments.write(issue.number, update, action);
    } catch (error) {
      if (action || update.final || update.resume) throw error;
      report(
        `${pass.name}#${issue.number} run comment was not written; a later write retries it: ${error}`,
      );
    }
  }

  async function apply(decision: Decision, pass: Pass) {
    const platform = pass.platform!;
    const issue = pass.read?.issues.find(
      (issue) => issue.number === decision.issue,
    );
    const { labels } = pass.configuration!;
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
        await tell(pass, issue, {
          phase: "merge",
          facts: { state: "merged" },
          final: true,
        });
        await platform.complete(decision.issue);
        forget(decision);
        return;
      case "claim":
        await platform.transition(decision.issue, "claim");
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
      case "fail": {
        // A pull request that closed or merged fails the merge itself.
        const run = find(decision);
        const ended = endedFacts(decision, pass);
        await tell(
          pass,
          issue,
          {
            phase:
              ended?.pullRequest === "closed" || ended?.pullRequest === "merged"
                ? "merge"
                : run
                  ? phaseOf(run)
                  : "implement",
            facts: {
              state: "failed",
              reason: decision.failure,
              unpushable: decision.unpushedChanges,
            },
            final: true,
          },
          {
            key: `failed:${run?.provenance?.id ?? "claim"}`,
            failed: labels.failed,
            reason: decision.failure,
            unpushable: decision.unpushedChanges
              ?.map((path) => `\`${path}\``)
              .join(", "),
          },
        );
        await platform.transition(decision.issue, "fail");
        forget(decision);
        return;
      }
      case "keep": {
        // Awaiting merge takes no cap slot but retains its attempt and PR
        // history until the claim settles, including across a restart. The
        // next run kind takes a quiet keep's PR, so nothing awaits merge yet.
        if (!decision.quiet)
          await tell(pass, issue, {
            phase: "merge",
            facts: { state: "awaiting merge", reason: decision.reason },
          });
        const run = find(decision);
        if (run) record(run);
        return;
      }
      case "release": {
        const stop =
          issue &&
          stopLabels(labels).find((label) => issue.labels.includes(label));
        const previous = find(decision);
        // A merged pull request that closed its issue ends the pass.
        if (!issue && endedFacts(decision, pass)?.pullRequest === "merged")
          await platform.comments.write(decision.issue, {
            phase: "merge",
            facts: { state: "merged" },
            final: true,
          });
        if (stop) {
          const since = previous?.pullRequestSince ?? issue.continuation?.since;
          const observation = await platform.pullRequestObservation(
            decision.issue,
            since,
            false,
            previous?.continuation.target?.number ??
              issue.pullRequest?.target.number,
          );
          // A review stopped with its PR ready to merge resumes as review,
          // and once its gate is cleared when it stopped at one.
          const ended =
            previous?.ended && "pullRequest" in previous.ended
              ? previous.ended
              : undefined;
          const ready =
            previous?.continuation.runKind === "review" &&
            ended?.openPullRequest &&
            !ended.openPullRequest.draft
              ? ended.openPullRequest
              : undefined;
          const gates = gateLabels(labels);
          const review = ready
            ? {
                target: pullRequestIdentity(ready),
                ...(previous!.continuation.implementedBy !== undefined && {
                  implementedBy: previous!.continuation.implementedBy,
                }),
                handBacks: previous!.continuation.handBacks ?? 0,
                gated:
                  gates.some((label) => issue.labels.includes(label)) ||
                  pass.gated === null ||
                  (pass.gated?.includes(ready.number) ?? false),
              }
            : previous
              ? undefined
              : issue.continuation?.review;
          // A person must act on a gate review reached, or on a stop in their
          // state; an unreadable gate read reaches none. A recorded
          // continuation's stop was told when its run stopped.
          const id = previous?.provenance?.id ?? "claim";
          const reached = gates.filter((label) => issue.labels.includes(label));
          const gate =
            ready && (reached.length || pass.gated?.includes(ready.number))
              ? (reached.length ? reached : gates).join(", ")
              : undefined;
          const asked = askLabels(labels).find((label) =>
            issue.labels.includes(label),
          );
          const action: Action | undefined =
            !previous && issue.continuation
              ? undefined
              : gate
                ? { key: `gate:${id}`, gate }
                : asked
                  ? { key: `stop:${id}`, stopped: asked }
                  : undefined;
          // The run comment keeps the continuation until the work resumes. A
          // stop with no run, continuation or PR has nothing to continue.
          if (previous || issue.continuation || observation.pullRequests.length)
            await tell(
              pass,
              issue,
              {
                phase: previous ? phaseOf(previous) : "implement",
                facts: { state: "stopped", reason: `waits in \`${stop}\`` },
                resume: {
                  ...(since && { since }),
                  pullRequests: observation.pullRequests,
                  ...(review && { review }),
                },
              },
              action,
            );
        }
        await platform.transition(decision.issue, "release");
        if (!stop) forget(decision);
        else if (previous) {
          // Retire the attempt; its continuation is on the issue.
          runs.splice(runs.indexOf(previous), 1);
          previous.settled = true;
          record(previous);
        }
        return;
      }
      case "pause": {
        const run = find(decision);
        if (!run || !pausedEnding(run)) return;
        await platform.transition(decision.issue, "pause");
        await tell(pass, issue, {
          phase: phaseOf(run),
          facts: {
            state: "paused",
            reason: decision.pause.cause,
            reset: decision.pause.reset,
          },
        });
        return;
      }
      case "unpause":
        await platform.transition(decision.issue, "unpause");
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
          continuation: run.continuation,
          ...(run.selection && { selection: run.selection }),
          holdObserved: run.holdObserved,
          ownedPullRequests: run.ownedPullRequests,
          ...(run.result && { result: run.result }),
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
      const held = repositoryHold("factory", pass)?.reason;
      if (held) report(`${pass.name} is held: ${held}`);
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
            paused:
              pass.paused ?? repositoryHold("factory", pass)?.reason ?? null,
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

  // After launches have been stopped or finished, wait for their log and
  // record writes, including runs a later pass has already forgotten.
  async function drain(): Promise<void> {
    await Promise.all(pending);
  }

  return { tick, interrupt, drain, refreshTokens, report };
}

// How a run ended, when it paused.
function pausedEnding(run: Pick<Run, "ended">): { paused: Pause } | null {
  return run.ended && "paused" in run.ended ? run.ended : null;
}

// A recovered paused run keeps the pause time and deadline it recorded. A
// record from before they were recorded pauses at its exit, or, lacking that,
// at its start, so its deadline counts from then and never from the restart.
function recoveredPause(recorded: {
  ended: { paused: Partial<Pause> & Pick<Pause, "reset"> };
  exitedAt?: string | null;
  startedAt: string;
}): { paused: Pause } {
  const { paused } = recorded.ended;
  if (typeof paused.at === "string" && typeof paused.until === "string")
    return { paused: paused as Pause };
  const at = new Date(recorded.exitedAt ?? recorded.startedAt);
  return {
    paused: {
      cause: "usage limit",
      reset: paused.reset,
      at: at.toISOString(),
      until: pauseDeadline(paused.reset, at).toISOString(),
    },
  };
}

// The run comment's phase a run works in: a merge relaunch merges.
function phaseOf(run: Pick<Run, "continuation">): Phase {
  return run.continuation.mergeRelaunch
    ? "merge"
    : (run.continuation.runKind ?? "implement");
}

// A run's facts on its phase's line; review rounds count its hand-backs.
function runFacts(run: Run) {
  return {
    provider: run.provider,
    model: run.model,
    effort: run.effort,
    attempt: run.continuation.attempt,
    round:
      run.continuation.runKind === "review" ||
      run.continuation.handBacks !== undefined
        ? (run.continuation.handBacks ?? 0) + 1
        : undefined,
  };
}

// The state a run result's outcome leaves its phase in.
const outcomeStates = {
  done: "done",
  stop: "stopped",
  failed: "failed",
} as const;

async function retryLogTail(path: string): Promise<string> {
  let tail = "";
  try {
    const log = await readFile(path, "utf8");
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
  return tail;
}
