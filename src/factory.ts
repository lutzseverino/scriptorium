// The factory's decision core: a pure function from a snapshot of the host's
// repositories and runs to the decisions the host carries out.
import type { FactoryConfiguration } from "./factory-configuration.ts";
import { pauseDeadline } from "./pause.ts";
import type { Model, Registry } from "./providers.ts";
import {
  closes,
  readinessExclusion,
  references,
  type Policy,
  type Readiness,
} from "./readiness.ts";
import {
  runOutcome,
  type Observation,
  type PullRequestState,
} from "./run-outcome.ts";

// An issue's number in its own repository, or `<owner>/<name>#<n>` in another.
export type IssueId = number | string;

export type Issue = {
  number: number;
  createdAt: string;
  labels: string[];
  // The latest application of the ready label while the issue carries it, or
  // null when it doesn't or no event applying it was found.
  ready: Readiness | null;
  // When the body was last edited, or null when it never was. Title and
  // comment changes don't count.
  editedAt: string | null;
  // Its parent, or null when it has none.
  nativeParent: IssueId | null;
  // When a sub-issue was last linked, and which when the platform says, or
  // null when none was or the platform doesn't report it.
  latestLink: { ticket: IssueId | null; at: string } | null;
  subIssues: { number: IssueId; state: "open" | "closed" }[];
  blockedBy: { number: IssueId; state: "open" | "closed" }[];
};

// Why the factory paused a run, which it resumes by itself, and the reset the
// cause stated, if any: the agent exited on its provider's usage limit, or the
// factory stopped its sandbox once its provider's usage reached the pause
// threshold. `at` is when the run paused, and `until` when it stops waiting
// for its provider's usage to read, both fixed once as it pauses.
export type Pause = {
  cause: "usage limit" | "pause threshold";
  reset: string | null;
  at: string;
  until: string;
};

// A run the host started, in the repository named `<owner>/<name>`. `ended`
// is null while its sandbox runs, interrupted once a factory restart stopped
// its sandbox, and paused once its agent exited on a pause's cause, with
// whether its issue was told.
export type Run = {
  repository: string;
  issue: number;
  provider: string;
  model: string;
  effort: string;
  attempt: 1 | 2;
  // The first attempt's failure and log a retry launched with.
  retry?: { failure: string; log: string };
  startedAt: string;
  log: string;
  ended:
    | null
    | { interrupted: true }
    | { paused: Pause; commented: boolean }
    | {
        timedOut: boolean;
        orphaned?: true;
        pullRequest: PullRequestState;
        // Paths under the host's unpushable paths in commits the remote lacks.
        unpushedChanges?: string[];
      };
};

// A running- or paused-labelled issue that no run on the host holds.
export type Claim = {
  issue: number;
  pullRequest: PullRequestState;
  unpushedChanges?: string[];
};

// One repository the host configuration lists, as this pass read it: its open
// issues and its claims. A paused repository claims and launches nothing,
// while its runs keep settling.
export type Repository = {
  name: string;
  configuration: FactoryConfiguration;
  // Its platform's role names whose readiness the factory accepts, and the
  // accounts whose readiness it never accepts.
  authorization: { authorizedRoles: string[]; neverAuthorize: string[] };
  paused: string | null;
  issues: Issue[];
  claims: Claim[];
};

export type Settings = {
  defaultModel: string;
  retryModel: string;
  caps: Record<string, number>;
  // The usage percentages at or above which a provider claims no new issue,
  // and at or above which its running runs stop too, or null when off.
  drainThreshold: number | null;
  pauseThreshold: number | null;
  timeLimitMinutes: number;
};

// A provider's usage reading recent enough to trust: its fullest window's
// percentage, when it was read, and that window's reset when the provider
// reported one.
export type Usage = { used: number; at: string; reset?: string };

// A provider's usage hold: its latest reading at or above a threshold, which
// still holds it once its usage is unknown, until `until`. Both `since`, when
// the hold began, and `until` are fixed once as it begins.
export type UsageHold = Usage & { since: string; until: string };

// The owner's control of one provider's claims. An owner hold, set when the
// provider drained on an owner-resume host, holds every new claim until the
// owner's resume request lifts it, whatever its usage reads. A reserve raise,
// which a resume request grants, raises the drain threshold for new claims
// once, up to the pause threshold, until a reading below the configured drain
// threshold or `until`, the reset the provider reported, when it reported one.
// Neither holds nor releases running work or paused runs.
// `used` is the usage that set the owner hold, or null when the hold stands in
// for an owner record the factory could not read.
export type OwnerHold = { since: string; used: number | null };
export type ReserveRaise = {
  drainThreshold: number;
  since: string;
  until: string | null;
};
export type OwnerControl = {
  hold: OwnerHold | null;
  reserve: ReserveRaise | null;
};

// Runs of a repository this pass could not read are present only while their
// sandboxes run, so caps and the time limit still apply to them. A provider's
// usage is null or absent while unknown, and so is its usage hold while it has
// none, and so is the owner's control of it while it has neither an owner
// hold nor a reserve raise.
export type Snapshot = {
  now: string;
  repositories: Repository[];
  runs: Run[];
  usage: Record<string, Usage | null>;
  holds: Record<string, UsageHold | null>;
  owners: Record<string, OwnerControl | null>;
  settings: Settings;
};

// How the decision core resolves models: the provider registry.
export type Models = Pick<Registry, "resolveModel" | "resolveModelLabel">;

export type Launch = {
  kind: "launch";
  repository: string;
  issue: number;
  provider: string;
  model: string;
  effort: string;
  attempt: 1 | 2;
  retry?: { failure: string; log: string };
  // An interrupted or paused run launching again as the same attempt.
  relaunch?: true;
};

export type Decision = { repository: string; issue: number } & (
  | { kind: "claim" }
  | { kind: "close"; tickets: IssueId[] }
  | Launch
  | { kind: "skip"; reason: string }
  // Stops a running run's sandbox: at the time limit, or at the pause
  // threshold with the pause it ends with once its agent exits.
  | { kind: "stop"; reason: string; pause?: Pause }
  | {
      kind: "fail";
      failure: string;
      log: string | null;
      unpushedChanges?: string[];
    }
  | { kind: "keep" }
  | { kind: "release" }
  // Swaps the running label for the paused one and tells the issue why.
  | { kind: "pause"; pause: Pause }
  // Swaps the paused label for the running one.
  | { kind: "unpause" }
);

export function decideFactory(snapshot: Snapshot, models: Models): Decision[] {
  const decisions: Decision[] = [];
  const running = runningCounts(snapshot);
  const retries = new Map<string, Retry>();
  // Interrupted and paused runs, which launch again rather than settle.
  const held = new Map<string, Run>();
  const closing = new Set(
    snapshot.repositories.flatMap((repository) =>
      repository.issues
        .filter((issue) => closes(issue, policy(repository)))
        .map((issue) => key(repository.name, issue.number)),
    ),
  );
  for (const run of snapshot.runs) {
    if (closing.has(key(run.repository, run.issue))) continue;
    const settled = settle(run, snapshot, models);
    if ("failure" in settled)
      retries.set(key(run.repository, run.issue), settled);
    else if ("held" in settled)
      held.set(key(run.repository, run.issue), settled.held);
    else decisions.push(...settled);
  }
  for (const repository of snapshot.repositories)
    for (const claim of repository.claims)
      if (!closing.has(key(repository.name, claim.issue))) {
        const settled = settleOutcome(
          {
            repository: repository.name,
            issue: claim.issue,
            attempt: 1,
            log: null,
          },
          {
            ended: "orphaned",
            pullRequest: claim.pullRequest,
            unpushedChanges: claim.unpushedChanges,
          },
          repository,
          snapshot,
          models,
        );
        if ("failure" in settled)
          retries.set(key(repository.name, claim.issue), settled);
        else {
          // Nothing resumes a paused-labelled claim that awaits merge.
          if (
            settled.some(({ kind }) => kind === "keep") &&
            carriesPaused(repository, claim.issue)
          )
            decisions.push({
              kind: "unpause",
              repository: repository.name,
              issue: claim.issue,
            });
          decisions.push(...settled);
        }
      }
  for (const { repository, issue } of oldestFirst(snapshot.repositories)) {
    const at = { repository: repository.name, issue: issue.number };
    if (closing.has(key(repository.name, issue.number))) {
      decisions.push({
        kind: "close",
        ...at,
        tickets: issue.subIssues.map((ticket) => ticket.number),
      });
      continue;
    }
    const resumed = held.get(key(repository.name, issue.number));
    if (resumed) {
      held.delete(key(repository.name, issue.number));
      decisions.push(...resume(repository, issue, resumed, running, snapshot));
      continue;
    }
    const retry = retries.get(key(repository.name, issue.number));
    if (retry) {
      retries.delete(key(repository.name, issue.number));
      decisions.push(...relaunch(repository, issue, retry, running, snapshot));
      continue;
    }
    const { labels, modelLabelPrefix } = repository.configuration;
    if (!issue.labels.includes(labels.ready)) continue;
    const reason =
      needsInputExclusion(issue, labels) ??
      (issue.labels.includes(labels.running)
        ? "claimed by a running factory run"
        : null) ??
      (issue.labels.includes(labels.paused)
        ? `labelled ${labels.paused}; the factory resumes its run by itself`
        : null) ??
      exclusion(issue, repository) ??
      (snapshot.runs.some(
        (run) =>
          run.repository === repository.name && run.issue === issue.number,
      )
        ? "a factory run for it is still on the host"
        : null) ??
      paused(repository);
    if (reason) {
      decisions.push({ kind: "skip", ...at, reason });
      continue;
    }
    const model = issueModel(
      issue,
      modelLabelPrefix,
      snapshot.settings,
      models,
    );
    if ("error" in model) {
      decisions.push({ kind: "skip", ...at, reason: model.error });
      continue;
    }
    const gated = gate(model.provider, running, snapshot, "drain");
    if (gated) {
      decisions.push({ kind: "skip", ...at, reason: gated });
      continue;
    }
    running.set(model.provider, (running.get(model.provider) ?? 0) + 1);
    decisions.push(
      { kind: "claim", ...at },
      { kind: "launch", ...at, ...model, attempt: 1 },
    );
  }
  for (const retry of retries.values())
    decisions.push(unretried(retry, "its issue is no longer open"));
  // An interrupted or paused run whose issue closed has nothing left to do.
  for (const run of held.values())
    decisions.push({
      kind: "release",
      repository: run.repository,
      issue: run.issue,
    });
  return decisions;
}

function key(repository: string, issue: number): string {
  return `${repository}#${issue}`;
}

function policy(repository: Repository): Policy {
  return {
    ready: repository.configuration.labels.ready,
    ...repository.authorization,
  };
}

// Caps count running sandboxes across every repository; a claim whose pull
// request awaits merge, or an ended run, takes no slot.
function runningCounts(snapshot: Snapshot): Map<string, number> {
  const running = new Map<string, number>();
  for (const run of snapshot.runs.filter((run) => run.ended === null))
    running.set(run.provider, (running.get(run.provider) ?? 0) + 1);
  return running;
}

// A failed first run that may retry on the retry model.
type SettlingRun = Pick<Run, "repository" | "issue" | "attempt"> & {
  log: string | null;
};
type Retry = { run: SettlingRun; failure: string; model: Model };

// A running run over the time limit is stopped, and so is one whose provider's
// usage reached the pause threshold, which pauses it. An ended run releases its
// claim once its issue closes and keeps it while the pull request is open. A
// run needing the owner's input releases its claim without retry or failure.
// A failed first run may retry once on the retry model; any other failure
// fails the issue. An interrupted or paused run is not settled: it launches
// again.
function settle(
  run: Run,
  snapshot: Snapshot,
  models: Models,
): Decision[] | Retry | { held: Run } {
  const at = { repository: run.repository, issue: run.issue };
  const limit = snapshot.settings.timeLimitMinutes;
  const overtime = `the time limit of ${limit} minutes`;
  if (run.ended === null) {
    const elapsed = Date.parse(snapshot.now) - Date.parse(run.startedAt);
    if (elapsed > limit * 60_000)
      return [{ kind: "stop", ...at, reason: `exceeded ${overtime}` }];
    const high = highUsage(run.provider, snapshot);
    if (high?.threshold !== "pause") return [];
    const reset = high.usage.reset ?? null;
    return [
      {
        kind: "stop",
        ...at,
        reason: `${run.provider} ${described(high, snapshot.settings)}`,
        pause: {
          cause: "pause threshold",
          reset,
          at: snapshot.now,
          until: pauseDeadline(reset, new Date(snapshot.now)).toISOString(),
        },
      },
    ];
  }
  if ("interrupted" in run.ended || "paused" in run.ended) return { held: run };
  const repository = snapshot.repositories.find(
    (repository) => repository.name === run.repository,
  );
  // Unreadable repositories supply only running sandboxes.
  if (!repository) return [];
  return settleOutcome(
    run,
    {
      ended: run.ended.orphaned
        ? "orphaned"
        : run.ended.timedOut
          ? "timed out"
          : "exited",
      pullRequest: run.ended.pullRequest,
      unpushedChanges: run.ended.unpushedChanges,
    },
    repository,
    snapshot,
    models,
  );
}

// Runs and orphaned claims settle through the same outcome table. The core
// owns retries and gates; the outcome module owns observation precedence.
function settleOutcome(
  run: SettlingRun,
  observation: Pick<Observation, "ended" | "pullRequest" | "unpushedChanges">,
  repository: Repository,
  snapshot: Snapshot,
  models: Models,
): Decision[] | Retry {
  const at = { repository: run.repository, issue: run.issue };
  const issue = repository.issues.find((issue) => issue.number === run.issue);
  const outcome = runOutcome(
    {
      ...observation,
      issueClosed: !issue,
      needsInput:
        issue?.labels.includes(repository.configuration.labels.needsInput) ??
        false,
    },
    snapshot.settings.timeLimitMinutes,
  );
  if (outcome.kind === "awaiting merge") return [{ kind: "keep", ...at }];
  if (outcome.kind === "done" || outcome.kind === "needs input")
    return [{ kind: "release", ...at }];
  const fail: Decision = {
    kind: "fail",
    ...at,
    failure: outcome.failure,
    log: run.log,
    ...(outcome.unpushedChanges && {
      unpushedChanges: outcome.unpushedChanges,
    }),
  };
  if (outcome.final || run.attempt === 2) return [fail];
  const model = models.resolveModel(snapshot.settings.retryModel);
  if ("error" in model) return [fail];
  return { run, failure: outcome.failure, model };
}

// A retry takes its issue's turn in oldest-first order. It launches only
// while the issue would still be picked up, apart from its own claim, and
// waits for its provider's gate, as a new claim does, and for its repository
// to resume.
function relaunch(
  repository: Repository,
  issue: Issue,
  retry: Retry,
  running: Map<string, number>,
  snapshot: Snapshot,
): Decision[] {
  const at = { repository: repository.name, issue: issue.number };
  const { labels } = repository.configuration;
  const reason = issue.labels.includes(labels.ready)
    ? exclusion(issue, repository)
    : `it no longer carries ${labels.ready}`;
  if (reason) {
    const readiness = readinessExclusion(
      issue,
      repository.issues,
      policy(repository),
    );
    if (issue.labels.includes(labels.ready) && readiness?.waiting)
      return [{ kind: "skip", ...at, reason: `retry waits: ${reason}` }];
    return [unretried(retry, reason)];
  }
  const { provider } = retry.model;
  const gated =
    paused(repository) ?? gate(provider, running, snapshot, "drain");
  if (gated) return [{ kind: "skip", ...at, reason: `retry waits: ${gated}` }];
  running.set(provider, (running.get(provider) ?? 0) + 1);
  return [
    // A paused-labelled claim's retry runs under the running label.
    ...(issue.labels.includes(labels.paused)
      ? [{ kind: "unpause" as const, ...at }]
      : []),
    {
      kind: "launch",
      ...at,
      ...retry.model,
      attempt: 2,
      retry: { failure: retry.failure, log: retry.run.log ?? "" },
    },
  ];
}

// An interrupted run continues as it would have without the restart: it
// launches again as the same attempt on its branch, in its issue's turn, and
// pickup's exclusions don't hold it. As running work, it waits for its
// provider's gate only at the pause threshold, and for its repository to
// resume, and releases its claim once its issue needs input. A paused run
// first tells its issue, once, then resumes the same way, under the running
// label again, once its pause no longer holds it.
function resume(
  repository: Repository,
  issue: Issue,
  run: Run,
  running: Map<string, number>,
  snapshot: Snapshot,
): Decision[] {
  const at = { repository: repository.name, issue: issue.number };
  if (needsInputExclusion(issue, repository.configuration.labels))
    return [{ kind: "release", ...at }];
  const pause = run.ended && "paused" in run.ended ? run.ended : null;
  if (pause && !pause.commented)
    return [{ kind: "pause", ...at, pause: pause.paused }];
  const gated =
    paused(repository) ??
    (pause && limited(run.provider, pause.paused, snapshot)) ??
    gate(run.provider, running, snapshot, "pause");
  if (gated)
    return [{ kind: "skip", ...at, reason: `relaunch waits: ${gated}` }];
  running.set(run.provider, (running.get(run.provider) ?? 0) + 1);
  return [
    ...(pause ? [{ kind: "unpause" as const, ...at }] : []),
    {
      kind: "launch",
      ...at,
      provider: run.provider,
      model: run.model,
      effort: run.effort,
      attempt: run.attempt,
      ...(run.retry && { retry: run.retry }),
      relaunch: true,
    },
  ];
}

function unretried({ run, failure }: Retry, reason: string): Decision {
  return {
    kind: "fail",
    repository: run.repository,
    issue: run.issue,
    failure: `${failure}, and its retry did not launch: ${reason}`,
    log: run.log,
  };
}

// A paused run is held while its provider's usage is at or above a
// configured threshold, read or held, and released once a reading taken since
// the pause is below every configured threshold; an owner hold or a reserve
// raise changes neither. Unlike a fresh launch, which unknown usage holds
// only during a usage hold, the pause is evidence of exhaustion: unknown
// usage, a reading from before the pause, or a host that sets no threshold
// holds it until the pause's deadline, and no longer, so a provider whose
// usage stays unreadable cannot hold it forever.
function limited(
  provider: string,
  pause: Pause,
  snapshot: Snapshot,
): string | null {
  const { settings } = snapshot;
  const cause =
    pause.cause === "pause threshold"
      ? `${provider} reached its pause threshold`
      : `${provider} hit its usage limit`;
  const limit = `${cause}${pause.reset === null ? "" : ` (resets ${pause.reset})`}`;
  const high = highUsage(provider, snapshot);
  if (high) return `${limit}; ${described(high, settings)}`;
  const reading = snapshot.usage[provider];
  const thresholds =
    settings.drainThreshold !== null || settings.pauseThreshold !== null;
  if (thresholds && reading && Date.parse(reading.at) >= Date.parse(pause.at))
    return null;
  if (Date.parse(snapshot.now) >= Date.parse(pause.until)) return null;
  const unknown = !thresholds
    ? "the host sets no usage threshold"
    : reading
      ? "its usage was last read before the pause"
      : "its usage is unreadable";
  return `${limit}; ${unknown}, so it waits until ${pause.until} at most`;
}

export type Threshold = "drain" | "pause";

// The highest threshold a usage percentage is at or above, or null when it is
// below every threshold the host sets.
export function reached(
  used: number,
  settings: Pick<Settings, "drainThreshold" | "pauseThreshold">,
): Threshold | null {
  if (settings.pauseThreshold !== null && used >= settings.pauseThreshold)
    return "pause";
  if (settings.drainThreshold !== null && used >= settings.drainThreshold)
    return "drain";
  return null;
}

// A provider's usage in force: its reading while the snapshot trusts one, or
// else its usage hold until the hold ends, which `hold` then names.
export function usageInForce(
  reading: Usage | null,
  hold: UsageHold | null,
  now: string,
): { usage: Usage; hold: UsageHold | null } | null {
  if (reading !== null) return { usage: reading, hold: null };
  return hold !== null && Date.parse(now) < Date.parse(hold.until)
    ? { usage: hold, hold }
    : null;
}

// The thresholds that hold a provider's new claims: the configured ones, with
// the drain threshold its reserve raise grants while it lasts.
export function claimThresholds(
  settings: Pick<Settings, "drainThreshold" | "pauseThreshold">,
  control: OwnerControl | null,
): Pick<Settings, "drainThreshold" | "pauseThreshold"> {
  return {
    drainThreshold: control?.reserve?.drainThreshold ?? settings.drainThreshold,
    pauseThreshold: settings.pauseThreshold,
  };
}

// A provider's usage in force at or above one of `thresholds`, the configured
// ones unless a new claim's reserve raise lifts its drain threshold.
type HighUsage = {
  threshold: Threshold;
  usage: Usage;
  hold: UsageHold | null;
  thresholds: Pick<Settings, "drainThreshold" | "pauseThreshold">;
};

function highUsage(
  provider: string,
  snapshot: Snapshot,
  thresholds: HighUsage["thresholds"] = snapshot.settings,
): HighUsage | null {
  const inForce = usageInForce(
    snapshot.usage[provider] ?? null,
    snapshot.holds[provider] ?? null,
    snapshot.now,
  );
  const threshold = inForce && reached(inForce.usage.used, thresholds);
  return inForce && threshold ? { threshold, ...inForce, thresholds } : null;
}

function described(
  { threshold, usage, hold, thresholds }: HighUsage,
  settings: Settings,
) {
  const percent =
    threshold === "pause"
      ? thresholds.pauseThreshold
      : thresholds.drainThreshold;
  const raised =
    threshold === "drain" && percent !== settings.drainThreshold
      ? `, which the owner raised once from ${settings.drainThreshold}%`
      : "";
  const over = `at or above the ${percent}% ${threshold} threshold${raised}`;
  return hold
    ? `usage is unknown, and its usage hold from ${usage.used}% at ${usage.at}, ${over}, lasts until ${hold.until} at most`
    : `usage ${usage.used}% is ${over}`;
}

function carriesPaused(repository: Repository, number: number): boolean {
  return (
    repository.issues
      .find((issue) => issue.number === number)
      ?.labels.includes(repository.configuration.labels.paused) ?? false
  );
}

function paused(repository: Repository): string | null {
  return repository.paused === null
    ? null
    : `${repository.name} is paused: ${repository.paused}`;
}

// A launch needs fewer running sandboxes than the provider's cap, and its
// provider's usage, read or held, below the threshold that stops it: the drain
// threshold for a new claim, as its reserve raise sets it, and the pause
// threshold for running work. A new claim also waits for its provider's owner
// hold to be lifted.
function gate(
  provider: string,
  running: Map<string, number>,
  snapshot: Snapshot,
  stops: Threshold,
): string | null {
  const { settings } = snapshot;
  const cap = settings.caps[provider];
  if (cap === undefined) return `the host sets no cap for ${provider}`;
  const control = snapshot.owners[provider] ?? null;
  if (stops === "drain" && control?.hold)
    return `${provider} has an owner hold ${control.hold.used === null ? "since" : `from ${control.hold.used}% at`} ${control.hold.since}; only the owner's resume request lifts it`;
  if ((running.get(provider) ?? 0) >= cap)
    return `${provider} already runs its cap of ${cap} agent${cap === 1 ? "" : "s"}`;
  const high =
    stops === "drain"
      ? highUsage(provider, snapshot, claimThresholds(settings, control))
      : highUsage(provider, snapshot);
  return high && (stops === "drain" || high.threshold === "pause")
    ? `${provider} ${described(high, settings)}`
    : null;
}

function issueModel(
  issue: Pick<Issue, "labels">,
  modelLabelPrefix: string,
  settings: Settings,
  models: Models,
): Model | { error: string } {
  const named = issue.labels.filter((label) =>
    label.startsWith(modelLabelPrefix),
  );
  if (named.length > 1)
    return { error: `several model labels: ${named.join(", ")}` };
  if (named.length === 1)
    return models.resolveModelLabel(modelLabelPrefix, named[0]);
  return models.resolveModel(settings.defaultModel);
}

// One queue across every repository: oldest issue first, then by repository
// and number.
function oldestFirst(
  repositories: Repository[],
): { repository: Repository; issue: Issue }[] {
  return repositories
    .flatMap((repository) =>
      repository.issues.map((issue) => ({ repository, issue })),
    )
    .sort(
      (left, right) =>
        Date.parse(left.issue.createdAt) - Date.parse(right.issue.createdAt) ||
        (left.repository.name < right.repository.name
          ? -1
          : left.repository.name > right.repository.name
            ? 1
            : 0) ||
        left.issue.number - right.issue.number,
    );
}

// A ready-labelled issue's exclusion from pickup, given its repository, whose
// open issues may hold it.
function exclusion(issue: Issue, repository: Repository): string | null {
  const { labels } = repository.configuration;
  const needsInput = needsInputExclusion(issue, labels);
  if (needsInput) return needsInput;
  const held = readinessExclusion(issue, repository.issues, policy(repository));
  if (held) return held.reason;
  if (issue.labels.includes(labels.failed))
    return `labelled ${labels.failed}; remove the label to run it again`;
  const blockers = issue.blockedBy.filter(
    (blocker) => blocker.state === "open",
  );
  if (blockers.length > 0) return `blocked by ${references(blockers)}`;
  return null;
}

function needsInputExclusion(
  issue: Issue,
  labels: FactoryConfiguration["labels"],
): string | null {
  return issue.labels.includes(labels.needsInput)
    ? `labelled ${labels.needsInput}; answer the question and remove the label to run it again`
    : null;
}
