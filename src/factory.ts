// The factory's decision core: a pure function from a snapshot of the host's
// repositories and runs to the decisions the host carries out.
import { labels, modelLabelPrefix } from "./conventions.ts";
import type { Model, Registry } from "./providers.ts";

// An issue's number in its own repository, or `<owner>/<name>#<n>` in another.
export type IssueId = number | string;

export type Issue = {
  number: number;
  createdAt: string;
  labels: string[];
  // When the ready label was last applied, or null when it is unknown.
  readyAt: string | null;
  // Its native parent, or null when it has none.
  nativeParent: IssueId | null;
  // When a native sub-issue was last added, and which, or null when none was.
  latestLink: { ticket: IssueId | null; at: string } | null;
  subIssues: { number: IssueId; state: "open" | "closed" }[];
  blockedBy: { number: number; state: "open" | "closed" }[];
};

// The state of the pull requests for an issue: merged once the issue closed,
// merged-issue-open when one merged but the issue is still open, else open
// while one is open.
export type PullRequestState =
  "open" | "merged" | "merged-issue-open" | "closed" | "none";

// A run the host started, in the repository named `<owner>/<name>`. `ended`
// is null while its sandbox runs, and interrupted once a factory restart
// stopped its sandbox.
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
    | {
        timedOut: boolean;
        pullRequest: PullRequestState;
        // Paths under the host's unpushable paths in commits the remote lacks.
        unpushedChanges?: string[];
      };
};

// A running-labelled issue that no run on the host holds.
export type Claim = { issue: number; pullRequest: PullRequestState };

// One repository the host configuration lists, as this pass read it: its open
// issues and its claims. A paused repository claims and launches nothing,
// while its runs keep settling.
export type Repository = {
  name: string;
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
  // An interrupted run launching again as the same attempt.
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
);

// Running the issue again could redo merged work, so this failure never
// retries.
const mergedIssueOpen =
  "its pull request merged without closing the issue; close the issue if that finished it";

export function decideFactory(snapshot: Snapshot, models: Models): Decision[] {
  const decisions: Decision[] = [];
  const running = runningCounts(snapshot);
  const retries = new Map<string, Retry>();
  const interrupted = new Map<string, Run>();
  const closing = new Set(
    snapshot.repositories.flatMap((repository) =>
      repository.issues
        .filter(
          (issue) =>
            issue.labels.includes(labels.ready) &&
            issue.subIssues.length > 0 &&
            issue.subIssues.every((ticket) => ticket.state === "closed"),
        )
        .map((issue) => key(repository.name, issue.number)),
    ),
  );
  for (const run of snapshot.runs) {
    if (closing.has(key(run.repository, run.issue))) continue;
    const settled = settle(run, snapshot, models);
    if ("failure" in settled)
      retries.set(key(run.repository, run.issue), settled);
    else if ("interrupted" in settled)
      interrupted.set(key(run.repository, run.issue), settled.interrupted);
    else decisions.push(...settled);
  }
  for (const repository of snapshot.repositories)
    for (const claim of repository.claims)
      if (!closing.has(key(repository.name, claim.issue)))
        decisions.push(...settleClaim(repository, claim));
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
    const resumed = interrupted.get(key(repository.name, issue.number));
    if (resumed) {
      interrupted.delete(key(repository.name, issue.number));
      decisions.push(...resume(repository, issue, resumed, running, snapshot));
      continue;
    }
    const retry = retries.get(key(repository.name, issue.number));
    if (retry) {
      retries.delete(key(repository.name, issue.number));
      decisions.push(...relaunch(repository, issue, retry, running, snapshot));
      continue;
    }
    if (!issue.labels.includes(labels.ready)) continue;
    const reason =
      needsInputExclusion(issue) ??
      (issue.labels.includes(labels.running)
        ? "claimed by a running factory run"
        : null) ??
      exclusion(issue, repository.issues) ??
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
    const model = issueModel(issue, snapshot.settings, models);
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
  // An interrupted run whose issue closed has nothing left to do.
  for (const run of interrupted.values())
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

// Caps count running sandboxes across every repository; a claim whose pull
// request awaits merge, or an ended run, takes no slot.
function runningCounts(snapshot: Snapshot): Map<string, number> {
  const running = new Map<string, number>();
  for (const run of snapshot.runs.filter((run) => run.ended === null))
    running.set(run.provider, (running.get(run.provider) ?? 0) + 1);
  return running;
}

// A failed first run that may retry on the retry model.
type Retry = { run: Run; failure: string; model: Model };

// A running run over the time limit is stopped. An ended run releases its
// claim once its issue closes and keeps it while the pull request is open. A
// run needing the owner's input releases its claim without retry or failure.
// A failed first run may retry once on the retry model; any other failure
// fails the issue. An interrupted run is not settled: it launches again.
function settle(
  run: Run,
  snapshot: Snapshot,
  models: Models,
): Decision[] | Retry | { interrupted: Run } {
  const at = { repository: run.repository, issue: run.issue };
  const limit = snapshot.settings.timeLimitMinutes;
  const overtime = `the time limit of ${limit} minutes`;
  if (run.ended === null) {
    const elapsed = Date.parse(snapshot.now) - Date.parse(run.startedAt);
    return elapsed > limit * 60_000
      ? [{ kind: "stop", ...at, reason: `exceeded ${overtime}` }]
      : [];
  }
  if ("interrupted" in run.ended) return { interrupted: run };
  if (run.ended.pullRequest !== "open" && needsInput(run, snapshot))
    return [{ kind: "release", ...at }];
  if (run.ended.pullRequest === "merged-issue-open")
    return [{ kind: "fail", ...at, failure: mergedIssueOpen, log: run.log }];
  if (!run.ended.timedOut && run.ended.pullRequest === "merged")
    return [{ kind: "release", ...at }];
  if (run.ended.pullRequest === "open") return [{ kind: "keep", ...at }];
  if (!run.ended.timedOut && run.ended.unpushedChanges?.length)
    return [
      {
        kind: "fail",
        ...at,
        failure:
          "the run's branch changes paths the factory's GitHub App can't push",
        unpushedChanges: run.ended.unpushedChanges,
        log: run.log,
      },
    ];
  const failure = run.ended.timedOut
    ? `the run exceeded ${overtime}`
    : "the run ended without an open pull request";
  const fail: Decision = { kind: "fail", ...at, failure, log: run.log };
  if (run.attempt === 2) return [fail];
  const model = models.resolveModel(snapshot.settings.retryModel);
  if ("error" in model) return [fail];
  return { run, failure, model };
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
  const reason = issue.labels.includes(labels.ready)
    ? exclusion(issue, repository.issues)
    : `it no longer carries ${labels.ready}`;
  if (reason) return [unretried(retry, reason)];
  const { provider } = retry.model;
  const gated = paused(repository) ?? gate(provider, running, snapshot);
  if (gated) return [{ kind: "skip", ...at, reason: `retry waits: ${gated}` }];
  running.set(provider, (running.get(provider) ?? 0) + 1);
  return [
    {
      kind: "launch",
      ...at,
      ...retry.model,
      attempt: 2,
      retry: { failure: retry.failure, log: retry.run.log },
    },
  ];
}

// An interrupted run continues as it would have without the restart: it
// launches again as the same attempt on its branch, in its issue's turn, and
// pickup's exclusions don't hold it. It waits for its provider's gate and for
// its repository to resume, and releases its claim once its issue needs input.
function resume(
  repository: Repository,
  issue: Issue,
  run: Run,
  running: Map<string, number>,
  snapshot: Snapshot,
): Decision[] {
  const at = { repository: repository.name, issue: issue.number };
  if (needsInputExclusion(issue)) return [{ kind: "release", ...at }];
  const gated = paused(repository) ?? gate(run.provider, running, snapshot);
  if (gated)
    return [{ kind: "skip", ...at, reason: `relaunch waits: ${gated}` }];
  running.set(run.provider, (running.get(run.provider) ?? 0) + 1);
  return [
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

// A claim no run holds stays while its pull request is open and is released
// once its issue closes or needs input. Any other claim, such as one left by
// a factory restart, fails its issue.
function settleClaim(
  repository: Repository,
  { issue, pullRequest }: Claim,
): Decision[] {
  const at = { repository: repository.name, issue };
  if (pullRequest === "open") return [];
  if (
    repository.issues.some(
      (open) =>
        open.number === issue && open.labels.includes(labels.needsInput),
    )
  )
    return [{ kind: "release", ...at }];
  if (pullRequest === "merged") return [{ kind: "release", ...at }];
  const failure =
    pullRequest === "merged-issue-open"
      ? mergedIssueOpen
      : pullRequest === "closed"
        ? "its pull request closed without merging"
        : "no factory run or open pull request holds its claim";
  return [{ kind: "fail", ...at, failure, log: null }];
}

function needsInput(run: Run, snapshot: Snapshot): boolean {
  return snapshot.repositories.some(
    (repository) =>
      repository.name === run.repository &&
      repository.issues.some(
        (issue) =>
          issue.number === run.issue &&
          issue.labels.includes(labels.needsInput),
      ),
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

// An issue's exclusion from pickup, given its repository's open issues, which
// may hold it.
function exclusion(issue: Issue, openIssues: Issue[]): string | null {
  const needsInput = needsInputExclusion(issue);
  if (needsInput) return needsInput;
  if (issue.subIssues.length > 0)
    return "an issue with sub-issues never runs; its readiness releases its tickets";
  const held = parentExclusion(issue, openIssues);
  if (held) return held;
  if (issue.labels.includes(labels.failed))
    return `labelled ${labels.failed}; remove the label to run it again`;
  const blockers = issue.blockedBy.filter(
    (blocker) => blocker.state === "open",
  );
  if (blockers.length > 0) return `blocked by ${references(blockers)}`;
  return null;
}

function needsInputExclusion(issue: Issue): string | null {
  return issue.labels.includes(labels.needsInput)
    ? `labelled ${labels.needsInput}; answer the question and remove the label to run it again`
    : null;
}

// A sub-issue waits on its native parent while that parent is open in its
// repository. A closed parent or one in another repository holds nothing.
function parentExclusion(issue: Issue, openIssues: Issue[]): string | null {
  const parent = openIssues.find(
    (other) => other.number === issue.nativeParent,
  );
  if (!parent) return null;
  const held = parentHold(parent);
  return held ? `sub-issue of ${reference(parent.number)}, ${held}` : null;
}

// A parent's readiness releases its sub-issues once it was applied after its
// latest ticket link, while no open blocker holds it.
function parentHold(parent: Issue): string | null {
  const name = reference(parent.number);
  if (!parent.labels.includes(labels.ready))
    return `which is not ready for agent; apply ${labels.ready} to ${name} once its tickets are published`;
  const link = parent.latestLink;
  if (
    link &&
    (parent.readyAt === null ||
      Date.parse(parent.readyAt) <= Date.parse(link.at))
  )
    return `whose readiness predates its latest ticket${link.ticket === null ? "" : ` ${reference(link.ticket)}`}; remove and re-apply ${labels.ready} on ${name} once its tickets are published`;
  const blockers = parent.blockedBy.filter(
    (blocker) => blocker.state === "open",
  );
  if (blockers.length > 0)
    return `which is blocked by ${references(blockers)}; it waits until ${name}'s blockers close`;
  return null;
}

function references(issues: { number: IssueId }[]): string {
  return issues.map((issue) => reference(issue.number)).join(", ");
}

export function reference(id: IssueId): string {
  return typeof id === "number" ? `#${id}` : id;
}
