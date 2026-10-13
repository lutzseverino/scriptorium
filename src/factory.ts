// The factory's decision core: a pure function from a snapshot of the host's
// repositories and runs to the decisions the host carries out.
import type { FactoryConfiguration } from "./factory-configuration.ts";
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
  // Its native parent, or null when it has none.
  nativeParent: IssueId | null;
  // When a native sub-issue was last added, and which, or null when none was.
  latestLink: { ticket: IssueId | null; at: string } | null;
  subIssues: { number: IssueId; state: "open" | "closed" }[];
  blockedBy: { number: number; state: "open" | "closed" }[];
};

// Why the factory paused a run, which it resumes by itself, and the reset the
// cause stated, if any. A provider's usage limit is the only cause so far.
export type Pause = { cause: "usage limit"; reset: string | null };

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
  paused: string | null;
  issues: Issue[];
  claims: Claim[];
};

export type Settings = {
  defaultModel: string;
  retryModel: string;
  caps: Record<string, number>;
  usageThreshold: number;
  timeLimitMinutes: number;
  // The repository roles whose readiness the factory accepts.
  authorizedRoles: string[];
};

// Runs of a repository this pass could not read are present only while their
// sandboxes run, so caps and the time limit still apply to them.
export type Snapshot = {
  now: string;
  repositories: Repository[];
  runs: Run[];
  usage: Record<string, number | null>;
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
  | { kind: "stop"; reason: string }
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
        .filter((issue) => closes(issue, policy(repository, snapshot.settings)))
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
      exclusion(issue, repository, snapshot.settings) ??
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
    const gated = gate(model.provider, running, snapshot);
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

function policy(repository: Repository, settings: Settings): Policy {
  return {
    ready: repository.configuration.labels.ready,
    authorizedRoles: settings.authorizedRoles,
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

// A running run over the time limit is stopped. An ended run releases its
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
    return elapsed > limit * 60_000
      ? [{ kind: "stop", ...at, reason: `exceeded ${overtime}` }]
      : [];
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
// waits for its provider's gate and for its repository to resume.
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
    ? exclusion(issue, repository, snapshot.settings)
    : `it no longer carries ${labels.ready}`;
  if (reason) {
    const readiness = readinessExclusion(
      issue,
      repository.issues,
      policy(repository, snapshot.settings),
    );
    if (issue.labels.includes(labels.ready) && readiness?.waiting)
      return [{ kind: "skip", ...at, reason: `retry waits: ${reason}` }];
    return [unretried(retry, reason)];
  }
  const { provider } = retry.model;
  const gated = paused(repository) ?? gate(provider, running, snapshot);
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
// pickup's exclusions don't hold it. It waits for its provider's gate and for
// its repository to resume, and releases its claim once its issue needs input.
// A paused run first tells its issue, once, then resumes the same way, under
// the running label again, and only on its provider's readable usage below
// the threshold.
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
    gate(run.provider, running, snapshot);
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

// A paused run's usage limit holds it until its provider's usage reads below
// the threshold; an unreadable usage holds it too, so a failed read cannot
// relaunch it into its limit.
function limited(
  provider: string,
  pause: Pause,
  { settings, usage }: Snapshot,
): string | null {
  const limit = `${provider} hit its usage limit${pause.reset === null ? "" : ` (resets ${pause.reset})`}`;
  const used = usage[provider];
  if (typeof used !== "number") return `${limit}; its usage is unreadable`;
  if (used >= settings.usageThreshold)
    return `${limit}; usage ${used}% is at or above the ${settings.usageThreshold}% threshold`;
  return null;
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

// A launch needs fewer running sandboxes than the provider's cap and, when
// its usage is readable, usage below the threshold.
function gate(
  provider: string,
  running: Map<string, number>,
  { settings, usage }: Snapshot,
): string | null {
  const cap = settings.caps[provider];
  if (cap === undefined) return `the host sets no cap for ${provider}`;
  if ((running.get(provider) ?? 0) >= cap)
    return `${provider} already runs its cap of ${cap} agent${cap === 1 ? "" : "s"}`;
  const used = usage[provider];
  if (typeof used === "number" && used >= settings.usageThreshold)
    return `${provider} usage ${used}% is at or above the ${settings.usageThreshold}% threshold`;
  return null;
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
function exclusion(
  issue: Issue,
  repository: Repository,
  settings: Settings,
): string | null {
  const { labels } = repository.configuration;
  const needsInput = needsInputExclusion(issue, labels);
  if (needsInput) return needsInput;
  const held = readinessExclusion(
    issue,
    repository.issues,
    policy(repository, settings),
  );
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
