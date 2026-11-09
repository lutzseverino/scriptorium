// The factory's decision core: a pure function from a snapshot of the host's
// repositories and runs to the decisions the host carries out.
import type { ImplementLimits } from "./host-configuration.ts";
import type { Recovery } from "./clone.ts";
import {
  launchArguments,
  runKind,
  type FactoryConfiguration,
  type RunKindName,
} from "./factory-configuration.ts";
import { holdKeys, type HoldKey } from "./hold-comments.ts";
import {
  configured,
  exclusionReason,
  gateLabels,
  isStopped,
  priority,
  stopLabels,
  type Continuing,
} from "./label-roles.ts";
import type { ModelPolicy } from "./model-policy.ts";
import {
  repositoryHold,
  repositoryGate,
  ownedPullRequests,
  heldPullRequests,
} from "./repository-holds.ts";
import { pauseDeadline } from "./pause.ts";
import type { Model, Registry } from "./providers.ts";
import type { ReadResult } from "./run-result.ts";
import type { MergeRelaunch, InputResume } from "./platform.ts";
import { triageTrigger, draftTrigger, type Trigger } from "./triggers.ts";
import {
  closes,
  readinessExclusion,
  readinessExclusions,
  references,
  triageRefusal,
  type Actor,
  type Policy,
  type Readiness,
  type ReadinessHold,
} from "./readiness.ts";
import {
  handBackLimit,
  settleEnding,
  type EndingFacts,
  type Retry,
  type RunEnding,
} from "./run-ending.ts";

// An issue's number in its own repository, or `<owner>/<name>#<n>` in another.
export type IssueId = number | string;

export type Issue = {
  number: number;
  createdAt: string;
  labels: string[];
  // The latest application of the ready label while the issue carries it, or
  // null when it doesn't or no event applying it was found.
  ready: Readiness | null;
  // The latest application of the triage label while the issue carries it,
  // or null or absent when it doesn't or no event applying it was found.
  triage?: Readiness | null;
  author?: Actor;
  reporter?: Readiness | null;
  authorReply?: string | null;
  filingRun?: string | null;
  filedByTrustedRun?: boolean;
  trustedHistory?: boolean;
  lastTriageAt?: string;
  reviewedHeads?: string[];
  // The continuation its unfinished pass's run comment holds for a released
  // stop, which resumes its work on the same PRs.
  continuation?: InputResume;
  // A PR is also a work item, claimed by its own number. Linked issues stay
  // available to the review skill; an issue-less PR uses its body as the spec.
  pullRequest?: { target: MergeRelaunch; draft: boolean; headBranch?: string };
  // When the body was last edited, or null when it never was. Title and
  // ordinary discussion changes don't count. Only a parent's readiness reads
  // it.
  editedAt: string | null;
  // Why the issue-contract validator's posted result doesn't approve the
  // current readiness, or null when it does or the issue isn't ready.
  contractHold: ReadinessHold | null;
  // Its parent, or null when it has none.
  nativeParent: IssueId | null;
  // When a sub-issue was last linked, and which when the platform says, or
  // null when none was or the platform doesn't report it.
  latestLink: { ticket: IssueId | null; at: string } | null;
  // Complete link additions in platform order, including repeats and unknown
  // facts; null when the capability is unsupported or history wasn't needed.
  linkAdditions:
    { ticket: IssueId | null; at: string | null; actor: Actor }[] | null;
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

// Launch facts retained whole through the host, snapshots and restarts.
export type Continuation = {
  trigger?: Trigger;
  recovery?: Recovery;
  // Absent for implement, the kind every version-2 run is.
  runKind?: Exclude<RunKindName, "implement">;
  attempt: 1 | 2;
  // The first attempt's failure and log a retry launched with.
  retry?: { failure: string; log: string };
  // The delivery task, retained through interruptions and provider pauses.
  mergeRelaunch?: MergeRelaunch;
  inputResume?: InputResume;
  // The PR a review or a review's hand-back works on, the hand-backs its
  // issue's reviews have made, and, for a review, the provider of the
  // implement attempt that produced the PR.
  target?: MergeRelaunch;
  handBacks?: number;
  implementedBy?: string;
  // An interrupted or paused run launching again as the same attempt.
  relaunch?: true;
};

// A run the host started, in the repository named `<owner>/<name>`. `ended`
// is null while its sandbox runs, interrupted once a factory restart stopped
// its sandbox, and paused once its agent exited on a pause's cause.
export type Run = {
  repository: string;
  issue: number;
  continuation: Continuation;
  provider: string;
  model: string;
  effort: string;
  // Where the model came from, and whether a review that asked for another
  // provider than its implement attempt's could not have one.
  selection?: Selection;
  diversity?: "unavailable";
  // Observed hold numbers; null means a read failed during the run.
  holdObserved?: number[] | null;
  // PRs the run owns, retaining ownership of PRs that have since closed.
  ownedPullRequests?: number[];
  startedAt: string;
  log: string;
  // The result the run left when its agent exited, as the host read it.
  result?: ReadResult;
  ended: null | { interrupted: true } | { paused: Pause } | RunEnding;
};

// A running- or paused-labelled issue that no run on the host holds.
export type Claim = EndingFacts & { issue: number; inputResume?: InputResume };

// One repository the host configuration lists, as this pass read it: its open
// issues and its claims. A paused repository claims and launches nothing,
// while its runs keep settling, and so does a factory-held one, except that a
// merge relaunch whose target PR alone carries the hold label launches.
export type Repository = {
  name: string;
  configuration: FactoryConfiguration;
  // Its platform's role names whose readiness the factory accepts, and the
  // accounts whose readiness it never accepts.
  authorization: { authorizedRoles: string[]; neverAuthorize: string[] };
  paused: string | null;
  issues: Issue[];
  claims: Claim[];
  ownedPullRequests?: number[];
  // Open labelled PR numbers; null means the configured hold read failed.
  releaseHold?: number[] | null;
  // Open issue and PR numbers carrying `labels.hold`; null means the
  // configured hold read failed.
  factoryHold?: number[] | null;
  // The repository's model policy, null when it has none.
  modelPolicy?: ModelPolicy | null;
  // Open PRs carrying a configured gate label; null means the read failed.
  gated?: number[] | null;
};

// The host's default models: for an implement attempt, its retry, and when
// set, a triage and a review run, which otherwise take the default.
export type Settings = {
  defaultModel: string;
  retryModel: string;
  triageModel?: string;
  reviewModel?: string;
  caps: Record<string, number>;
  implement?: ImplementLimits;
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

// Where a launch's model came from: the issue's model label, the repository's
// model policy, the host's default for its kind, the host default the policy's
// fallback chose while the choice was unavailable, the host's review default
// a review switched to for a provider other than its implement attempt's, or
// the run it relaunches.
export type Selection =
  | "issue-label"
  | "policy"
  | "host-default"
  | "fallback"
  | "diversity"
  | "recorded";

export type Launch = {
  kind: "launch";
  repository: string;
  issue: number;
  continuation: Continuation;
  provider: string;
  model: string;
  effort: string;
  selection: Selection;
  diversity?: "unavailable";
};

export type Decision = { repository: string; issue: number } & (
  | { kind: "claim" }
  | { kind: "close"; tickets: IssueId[] }
  | Launch
  | { kind: "skip"; reason: string; hold?: HoldKey }
  // Stops a running run's sandbox: at the time limit, or at the pause
  // threshold with the pause it ends with once its agent exits.
  | { kind: "stop"; reason: string; pause?: Pause }
  | {
      kind: "fail";
      failure: string;
      log: string | null;
      unpushedChanges?: string[];
    }
  // Retains the claim, telling the issue it awaits merge, and why the run
  // ended, unless a run kind takes the PR next.
  | { kind: "keep"; quiet?: true; reason?: string }
  | { kind: "complete" }
  | { kind: "release" }
  // Swaps the running label for the paused one and tells the issue why.
  | { kind: "pause"; pause: Pause }
  // Swaps the paused label for the running one.
  | { kind: "unpause" }
);

export function decideFactory(snapshot: Snapshot, models: Models): Decision[] {
  const decisions: Decision[] = [];
  const running = runningCounts(snapshot.runs);
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
      if (
        !closing.has(key(repository.name, claim.issue)) &&
        !(
          claim.inputResume &&
          claim.pullRequest !== "merged" &&
          resumes(repository, claim)
        )
      ) {
        const settled = settleEnding({ claim }, repository, snapshot, models);
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
  const continuations = snapshot.repositories.flatMap((repository) =>
    repository.issues.map((issue) =>
      continuation(
        repository,
        issue,
        held.get(key(repository.name, issue.number)),
        retries.get(key(repository.name, issue.number)),
        snapshot,
        models,
      ),
    ),
  );
  for (const next of priorityFirst(continuations)) {
    const { repository, issue } = next;
    const at = { repository: repository.name, issue: issue.number };
    if (closing.has(key(repository.name, issue.number))) {
      decisions.push({
        kind: "close",
        ...at,
        tickets: issue.subIssues.map((ticket) => ticket.number),
      });
      continue;
    }
    if (
      decisions.some(
        (decision) =>
          decision.repository === at.repository &&
          decision.issue === at.issue &&
          (decision.kind === "complete" || decision.kind === "fail"),
      )
    )
      continue;
    if (next.kind === "resume") held.delete(key(repository.name, issue.number));
    if (next.kind === "retry")
      retries.delete(key(repository.name, issue.number));
    decisions.push(...admit(next, running, snapshot, models));
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
  // Reconcile every actionable reason independently of pickup's precedence.
  // A blocked issue may also have a model error; neither clears the other.
  for (const next of continuations) {
    const { repository, issue, previous, own, reconcile, label } = next;
    const { labels } = repository.configuration;
    const at = { repository: repository.name, issue: issue.number };
    const holds: { hold: HoldKey; reason: string }[] = [];
    // Labels that exclude fresh pickup already explain the issue, except a
    // claim's own while its continuation is pending.
    if (!(
      (reconcile.readiness && !issue.labels.includes(labels.ready)) ||
      configured(
        labels,
        (role) =>
          role.excludes?.some(({ from }) => from.includes("fresh")) &&
          !(reconcile.pending && role.removes?.includes("release")),
      ).some((label) => issue.labels.includes(label)) ||
      !decisions.some(
        (decision) =>
          decision.repository === at.repository &&
          decision.issue === at.issue &&
          decision.kind === "skip",
      )
    )) {
      holds.push(
        ...(reconcile.readiness
          ? readinessExclusions(issue, repository.issues, policy(repository))
          : []
        ).flatMap((hold) =>
          hold.key ? [{ hold: hold.key, reason: hold.reason }] : [],
        ),
      );
      if (issue.subIssues.length === 0) {
        if (label && "error" in label)
          holds.push({ hold: holdKeys.model, reason: label.error });
        const configuration = repositoryGate(repository);
        if (configuration?.hold === holdKeys.configuration)
          holds.push(configuration);
        const held = repositoryHold("factory", repository, own);
        if (held) holds.push(held);
      }
    }
    const observedOwn = ownedPullRequests(previous);
    if (
      previous?.ended &&
      "pullRequest" in previous.ended &&
      previous.ended.pullRequest === "open" &&
      heldPullRequests(previous.holdObserved, observedOwn).length
    )
      for (const scope of ["release", "factory"] as const) {
        const held = repositoryHold(scope, repository, observedOwn);
        if (held) holds.push(held);
      }
    for (const hold of holds)
      if (
        !decisions.some(
          (decision) =>
            decision.repository === at.repository &&
            decision.issue === at.issue &&
            decision.kind === "skip" &&
            decision.hold === hold.hold,
        )
      )
        decisions.push({
          kind: "skip",
          ...at,
          ...hold,
        });
  }
  return decisions;
}

// The identity of an open PR the factory continues, without the rest of its
// observation.
export function pullRequestIdentity({
  number,
  headCommit,
  baseBranch,
  createdAt,
}: MergeRelaunch): MergeRelaunch {
  return { number, headCommit, baseBranch, createdAt };
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
export type RunKindCounts = Record<RunKindName, number>;

export function emptyRunKindCounts(): RunKindCounts {
  return { implement: 0, triage: 0, review: 0 };
}

type RunningCounts = ReturnType<typeof runningCounts>;

// This projection is also the admission pass's mutable accounting. Missing
// kinds are v2 implement work; only a non-ended sandbox occupies capacity.
export function runningCounts(runs: readonly Run[]) {
  const host = emptyRunKindCounts();
  const repositories = new Map<string, RunKindCounts>();
  for (const run of runs) {
    if (run.ended !== null) continue;
    const kinds = repositories.get(run.repository) ?? emptyRunKindCounts();
    const kind = run.continuation.runKind ?? "implement";
    host[kind]++;
    kinds[kind]++;
    repositories.set(run.repository, kinds);
  }
  return {
    providers: new Map(
      [...providerRunCounts(runs)].map(([provider, counts]) => [
        provider,
        counts.running,
      ]),
    ),
    host,
    repositories,
  };
}

// Shared by admission and operational status. Retained ended work, including
// interrupted runs and claims awaiting merge, occupies no sandbox slot.
export function providerRunCounts(
  runs: readonly Pick<Run, "provider" | "ended">[],
): Map<string, { running: number; paused: number; retained: number }> {
  const counts = new Map<
    string,
    { running: number; paused: number; retained: number }
  >();
  for (const run of runs) {
    const entry = counts.get(run.provider) ?? {
      running: 0,
      paused: 0,
      retained: 0,
    };
    if (run.ended === null) entry.running++;
    else {
      entry.retained++;
      if ("paused" in run.ended) entry.paused++;
    }
    counts.set(run.provider, entry);
  }
  return counts;
}

// A running run over the time limit is stopped, and so is one whose provider's
// usage reached the pause threshold, which pauses it. An interrupted or paused
// run is not settled: it launches again. Any other ended run settles through
// its ending.
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
  return settleEnding({ run, ending: run.ended }, repository, snapshot, models);
}

// Every issue has one continuation for both admission and hold reconciliation.
// The table makes hold applicability explicit; owned PRs include a merge or
// review target. Each row's stage picks its model: an implement attempt's,
// its retry's, a triage or review run's, or the run it relaunches.
const continuationRules = {
  triage: {
    factoryHold: "all",
    releaseHold: false,
    threshold: "drain",
    prefix: "triage waits: ",
    modelBeforeRepository: false,
    stage: "triage",
  },
  fresh: {
    factoryHold: "all",
    releaseHold: false,
    threshold: "drain",
    prefix: "",
    modelBeforeRepository: false,
    stage: "initial",
  },
  retry: {
    factoryHold: "all",
    releaseHold: false,
    threshold: "drain",
    prefix: "retry waits: ",
    modelBeforeRepository: true,
    stage: "retry",
  },
  review: {
    factoryHold: "unowned",
    releaseHold: false,
    threshold: "drain",
    prefix: "review waits: ",
    modelBeforeRepository: true,
    stage: "review",
  },
  handBack: {
    factoryHold: "all",
    releaseHold: false,
    threshold: "drain",
    prefix: "hand-back waits: ",
    modelBeforeRepository: true,
    stage: "initial",
  },
  resume: {
    factoryHold: "unowned",
    releaseHold: false,
    threshold: "pause",
    prefix: "relaunch waits: ",
    modelBeforeRepository: true,
    stage: "recorded",
  },
  merge: {
    factoryHold: "unowned",
    releaseHold: true,
    threshold: "pause",
    prefix: "merge relaunch waits: ",
    modelBeforeRepository: true,
    stage: "recorded",
  },
} as const;

type Stage = "triage" | "initial" | "retry" | "review";

type ContinuationState =
  | { kind: "triage" | "fresh" | "merge" }
  | { kind: "retry"; retry: Retry }
  | { kind: "resume"; run: Run }
  // A review of an implement attempt's PR, or of a stopped review's PR once
  // its stop is answered, which claims the issue again.
  | {
      kind: "review";
      target: MergeRelaunch;
      implementedBy?: string;
      handBacks: number;
      claim?: true;
    }
  | { kind: "handBack"; target: MergeRelaunch; handBacks: number };

type Admission = {
  kind: ContinuationState["kind"];
  repository: Repository;
  issue: Issue;
  previous: Run | undefined;
  own: number[];
  // The issue's model label, null without one.
  label: Model | { error: string } | null;
  modelSource:
    | { kind: "stage"; stage: Stage }
    | { kind: "recorded"; run: Run; retain: boolean };
  // Whether the launch asks for a provider other than the implement
  // attempt's that produced its PR, which it names.
  diversity: string | null;
  exclusions: Decision[] | null;
  afterModel: Decision[] | null;
  pause: Pause | null;
  reconcile: { readiness: boolean; pending: boolean };
  launch: Continuation;
  claim: boolean;
  unpause: boolean;
};

function continuation(
  repository: Repository,
  issue: Issue,
  resumed: Run | undefined,
  retry: Retry | undefined,
  snapshot: Snapshot,
  models: Models,
): Admission {
  const { configuration } = repository;
  const { labels } = configuration;
  const previous = snapshot.runs.find(
    (run) => run.repository === repository.name && run.issue === issue.number,
  );
  const claim = repository.claims.find((claim) => claim.issue === issue.number);
  const target = mergeTarget(previous, claim);
  const running = snapshot.runs.some(
    (run) =>
      run.repository === repository.name &&
      run.issue === issue.number &&
      run.ended === null,
  );
  const merge = !claim?.inputResume && target && !running;
  const reviews = runKind(configuration, "review");
  const ended =
    previous?.ended && "pullRequest" in previous.ended
      ? previous.ended
      : undefined;
  const open =
    ended?.pullRequest === "open" ? ended.openPullRequest : undefined;
  const pullRequest = open && pullRequestIdentity(open);
  const handBacks = previous?.continuation.handBacks ?? 0;
  const handoff: ContinuationState | undefined =
    reviews && previous && pullRequest && !isStopped(issue.labels, labels)
      ? previous.continuation.runKind === undefined
        ? {
            kind: "review",
            target: pullRequest,
            implementedBy: previous.provider,
            handBacks,
          }
        : previous.continuation.runKind === "review" &&
            open.draft &&
            handBacks < handBackLimit
          ? { kind: "handBack", target: pullRequest, handBacks: handBacks + 1 }
          : undefined
      : reviews &&
          claim?.inputResume?.review &&
          claim.pullRequest === "open" &&
          resumes(repository, claim)
        ? {
            kind: "review",
            target: claim.inputResume.review.target,
            implementedBy: claim.inputResume.review.implementedBy,
            handBacks: claim.inputResume.review.handBacks,
            claim: true,
          }
        : undefined;
  const trigger =
    runKind(configuration, "triage") && !issue.pullRequest
      ? triageTrigger(issue, labels, policy(repository))
      : null;
  const externalReview =
    reviews &&
    issue.pullRequest &&
    !previous &&
    !claim &&
    !repository.ownedPullRequests?.includes(issue.number) &&
    !snapshot.runs.some(
      (run) =>
        run.repository === repository.name &&
        (ownedPullRequests(run, run.continuation.target).includes(
          issue.number,
        ) ||
          issue.pullRequest?.headBranch === `factory/issue-${run.issue}`),
    ) &&
    draftTrigger(issue, policy(repository));
  const state: ContinuationState = resumed
    ? { kind: "resume", run: resumed }
    : (handoff ??
      (externalReview
        ? {
            kind: "review",
            target: issue.pullRequest!.target,
            handBacks: 0,
            claim: true,
          }
        : undefined) ??
      (merge
        ? { kind: "merge" }
        : retry
          ? { kind: "retry", retry }
          : !issue.pullRequest &&
              runKind(configuration, "triage") &&
              labels.triage !== undefined &&
              (issue.labels.includes(labels.triage) || trigger !== null)
            ? { kind: "triage" }
            : { kind: "fresh" }));
  // A stopped claim can defer a fresh merge launch while the previous
  // candidate still keeps its continuation holds actionable.
  const continuing = Boolean(
    (previous?.ended &&
      ("interrupted" in previous.ended ||
        "paused" in previous.ended ||
        ("mergeCandidate" in previous.ended &&
          previous.ended.mergeCandidate))) ||
    (claim?.mergeCandidate && !claim.inputResume) ||
    handoff,
  );
  const run = resumed ?? previous;
  const classified = { ...state, repository, issue, previous };
  const recorded = resumed ?? (state.kind === "merge" ? previous : undefined);
  const mergeExcluded = resumed?.continuation.mergeRelaunch
    ? exclusionReason(issue.labels, labels, "merge")
    : null;
  const pause =
    resumed?.ended && "paused" in resumed.ended ? resumed.ended : null;
  const handedOn =
    state.kind === "review" || state.kind === "handBack" ? state : undefined;
  // The PR this launch works on and the kind it runs: a merge relaunch is
  // review's once review is on, since only review then merges.
  const launchTarget =
    handedOn?.target ??
    (state.kind === "merge"
      ? target
      : (run?.continuation.target ?? run?.continuation.mergeRelaunch));
  const kind: RunKindName =
    state.kind === "triage"
      ? "triage"
      : state.kind === "review" || (state.kind === "merge" && reviews)
        ? "review"
        : state.kind === "resume"
          ? (resumed!.continuation.runKind ?? "implement")
          : "implement";
  // The current configuration selects the kind; retained facts cannot override it.
  const retained = { ...(run?.continuation ?? { attempt: 1 as const }) };
  delete retained.runKind;
  const expanded = launchArguments(
    configuration,
    kind,
    issue.number,
    launchTarget?.number,
  );
  return {
    ...classified,
    modelSource: recorded
      ? { kind: "recorded", run: recorded, retain: state.kind === "resume" }
      : ({
          kind: "stage",
          stage:
            state.kind === "merge"
              ? reviews
                ? "review"
                : "initial"
              : continuationRules[state.kind].stage,
        } as Admission["modelSource"]),
    diversity:
      kind === "review" &&
      reviews?.differentProvider === true &&
      !recorded &&
      handedOn?.kind === "review"
        ? (handedOn.implementedBy ?? null)
        : null,
    exclusions: continuationExclusions(classified),
    afterModel: mergeExcluded
      ? skipped(classified, mergeExcluded, undefined, "merge relaunch waits: ")
      : typeof expanded === "object"
        ? skipped(classified, expanded.error)
        : null,
    pause: pause?.paused ?? null,
    own: ownedPullRequests(run, target ?? handedOn?.target),
    label: labelModel(issue, configuration.modelLabelPrefix, models),
    reconcile: {
      readiness: !continuing,
      pending:
        continuing ||
        Boolean(
          (previous?.ended &&
            "pullRequest" in previous.ended &&
            previous.ended.pullRequest !== "open") ||
          (claim && claim.pullRequest !== "open"),
        ),
    },
    launch: {
      ...((trigger || externalReview) && {
        trigger: trigger || externalReview || undefined,
      }),
      ...(kind !== "implement" && { runKind: kind }),
      ...(state.kind === "fresh" || state.kind === "triage"
        ? {
            attempt: 1,
            ...(state.kind === "fresh" &&
              claim?.inputResume && { inputResume: claim.inputResume }),
          }
        : state.kind === "retry"
          ? {
              attempt: 2,
              retry: {
                failure: state.retry.failure,
                log: state.retry.run.log ?? "",
              },
              ...(state.retry.run.continuation.inputResume && {
                inputResume: state.retry.run.continuation.inputResume,
              }),
              // A hand-back's retry continues the same PR.
              ...(state.retry.run.continuation.target && {
                target: state.retry.run.continuation.target,
                handBacks: state.retry.run.continuation.handBacks,
              }),
            }
          : handedOn
            ? {
                attempt: 1,
                target: handedOn.target,
                handBacks: handedOn.handBacks,
                ...(handedOn.kind === "review" &&
                  handedOn.implementedBy !== undefined && {
                    implementedBy: handedOn.implementedBy,
                  }),
                ...((claim?.inputResume ??
                  previous?.continuation.inputResume) && {
                  inputResume:
                    claim?.inputResume ?? previous?.continuation.inputResume,
                }),
              }
            : {
                ...retained,
                relaunch: true,
                ...((state.kind === "merge"
                  ? target
                  : run?.continuation.mergeRelaunch) && {
                  mergeRelaunch:
                    state.kind === "merge"
                      ? target
                      : run?.continuation.mergeRelaunch,
                }),
              }),
    },
    claim:
      state.kind === "fresh" ||
      state.kind === "triage" ||
      (state.kind === "review" && state.claim === true),
    unpause:
      state.kind === "resume"
        ? Boolean(resumed?.ended && "paused" in resumed.ended)
        : state.kind !== "fresh" &&
          state.kind !== "triage" &&
          issue.labels.includes(labels.paused),
  };
}

// Whether a released claim's stop is answered, so its work resumes: a review
// stopped at a gate once no gate label remains on its issue or PR, outside
// every other stop; any other work once its issue is out of every stop.
function resumes(repository: Repository, claim: Claim): boolean {
  const issue = repository.issues.find((issue) => issue.number === claim.issue);
  if (!issue) return false;
  const { labels } = repository.configuration;
  const review = claim.inputResume?.review;
  if (!review?.gated) return !isStopped(issue.labels, labels);
  return (
    repository.gated !== null &&
    !repository.gated?.includes(review.target.number) &&
    !gateLabels(labels).some((label) => issue.labels.includes(label)) &&
    !stopLabels(labels).some(
      (label) => label !== labels.owner && issue.labels.includes(label),
    )
  );
}

// Exclusions are selected once with the continuation, before admission.
function continuationExclusions(
  next: ContinuationState &
    Pick<Admission, "repository" | "issue" | "previous">,
): Decision[] | null {
  const { repository, issue } = next;
  const { labels } = repository.configuration;
  const at = { repository: repository.name, issue: issue.number };
  const pause =
    next.kind === "resume" && next.run.ended && "paused" in next.run.ended
      ? next.run.ended
      : null;
  if (next.kind === "resume") {
    if (exclusionReason(issue.labels, labels, "resume"))
      return [{ kind: "release", ...at }];
    // Its issue is told once, as the paused label replaces the running one.
    if (pause && !issue.labels.includes(labels.paused))
      return [{ kind: "pause", ...at, pause: pause.paused }];
  } else if (
    next.kind === "merge" ||
    next.kind === "review" ||
    next.kind === "handBack"
  ) {
    // A review resumed from its stop is in that stop until it runs.
    const answered = next.kind === "review" && next.claim;
    const reason = exclusionReason(
      answered
        ? issue.labels.filter((label) => !stopLabels(labels).includes(label))
        : issue.labels,
      labels,
      "merge",
    );
    if (reason) return skipped(next, reason);
    if (
      next.kind !== "merge" &&
      !answered &&
      !issue.pullRequest &&
      !issue.labels.includes(labels.ready)
    )
      return skipped(next, `it no longer carries ${labels.ready}`);
  } else if (next.kind === "triage") {
    const reason =
      exclusionReason(issue.labels, labels, "triage") ??
      (next.previous ? "a factory run for it is still on the host" : null) ??
      (triageTrigger(issue, labels, policy(repository))
        ? null
        : (triageRefusal(issue, policy(repository), labels.triage!)?.reason ??
          "no new trusted triage trigger"));
    if (reason) return skipped(next, reason);
  } else {
    if (!issue.labels.includes(labels.ready))
      return next.kind === "retry"
        ? [unretried(next.retry, `it no longer carries ${labels.ready}`)]
        : [];
    const excluded = exclusion(issue, repository, next.kind);
    if (next.kind === "retry" && excluded) {
      const readiness = readinessExclusion(
        issue,
        repository.issues,
        policy(repository),
      );
      return readiness?.waiting
        ? skipped(next, excluded.reason)
        : [unretried(next.retry, excluded.reason)];
    }
    if (next.kind === "fresh") {
      if (excluded) return skipped(next, excluded.reason, excluded.key);
      if (next.previous)
        return skipped(next, "a factory run for it is still on the host");
    }
  }
  return null;
}

function skipped(
  next: Pick<Admission, "repository" | "issue" | "kind">,
  reason: string,
  hold?: HoldKey,
  prefix: string = continuationRules[next.kind].prefix,
): Decision[] {
  return [
    {
      kind: "skip",
      repository: next.repository.name,
      issue: next.issue.number,
      reason: `${prefix}${reason}`,
      ...(hold && { hold }),
    },
  ];
}

type Choice = { model: Model; selection: Selection; diversity?: "unavailable" };

// Admission preserves reason precedence: fresh repository gates and a fresh
// merge's release hold precede model validation; retry/resume models precede
// repository gates. A paused run's first notice precedes all admission holds.
// A model chosen for a stage that is unavailable falls back to the host's
// default for that stage only when the repository's model policy says so,
// and only when that default is available; otherwise the launch waits.
function admit(
  next: Admission,
  running: RunningCounts,
  snapshot: Snapshot,
  models: Models,
): Decision[] {
  const { repository, issue, label, modelSource } = next;
  const policy = repository.modelPolicy ?? null;
  const rules = continuationRules[next.kind];
  const at = { repository: repository.name, issue: issue.number };
  if (next.exclusions !== null) return next.exclusions;
  const repositoryHeld = repositoryGate(
    repository,
    rules.factoryHold === "all" ? [] : next.own,
  );
  if (!rules.modelBeforeRepository && repositoryHeld)
    return skipped(next, repositoryHeld.reason, repositoryHeld.hold);
  if (rules.releaseHold) {
    const held = repositoryHold("release", repository, next.own);
    if (held) return skipped(next, held.reason, held.hold, "relaunch waits: ");
  }
  if (label && "error" in label)
    return skipped(next, label.error, holdKeys.model);
  let choice: Choice | { error: string };
  if (modelSource.kind === "recorded") {
    const { run } = modelSource;
    const resolved = models.resolveModel(
      `${run.provider}/${run.model}@${run.effort}`,
    );
    choice =
      "error" in resolved
        ? resolved
        : {
            model: modelSource.retain
              ? { provider: run.provider, model: run.model, effort: run.effort }
              : resolved,
            selection: "recorded",
          };
  } else
    choice = stageModel(
      modelSource.stage,
      label,
      policy,
      snapshot.settings,
      models,
    );
  if ("error" in choice) return skipped(next, choice.error, holdKeys.model);
  if (next.afterModel !== null) return next.afterModel;
  const available = (model: Model) =>
    gate(model.provider, running.providers, snapshot, rules.threshold) ??
    implementGate(
      next.launch,
      repository.name,
      running,
      snapshot.settings.implement,
    );
  if (next.diversity !== null)
    choice = diverse(
      choice,
      next.diversity,
      policy,
      snapshot.settings,
      models,
      available,
    );
  let reason =
    repositoryHeld?.reason ??
    (next.pause && limited(choice.model.provider, next.pause, snapshot)) ??
    available(choice.model);
  if (
    reason &&
    !repositoryHeld &&
    modelSource.kind === "stage" &&
    policy?.fallback === "host-default" &&
    choice.selection !== "host-default"
  ) {
    const fallback = hostDefault(modelSource.stage, snapshot.settings, models);
    if (!("error" in fallback) && available(fallback.model) === null) {
      choice = { ...fallback, selection: "fallback" };
      reason = null;
    }
  }
  if (reason) return skipped(next, reason, repositoryHeld?.hold);
  const { model, selection, diversity } = choice;
  running.providers.set(
    model.provider,
    (running.providers.get(model.provider) ?? 0) + 1,
  );
  const kind = next.launch.runKind ?? "implement";
  running.host[kind]++;
  const kinds =
    running.repositories.get(repository.name) ?? emptyRunKindCounts();
  kinds[kind]++;
  running.repositories.set(repository.name, kinds);
  return [
    ...(next.claim ? [{ kind: "claim" as const, ...at }] : []),
    ...(next.unpause ? [{ kind: "unpause" as const, ...at }] : []),
    {
      kind: "launch",
      ...at,
      ...model,
      selection,
      ...(diversity && { diversity }),
      continuation: next.launch,
    },
  ];
}

// Every implement continuation acquires both budgets at the same gate,
// including retries, recovery, resumption and review hand-backs.
function implementGate(
  continuation: Continuation,
  repository: string,
  running: RunningCounts,
  limits: ImplementLimits | undefined,
): string | null {
  if (continuation.runKind !== undefined) return null;
  if (limits?.total !== undefined && running.host.implement >= limits.total)
    return `the host already runs its implement cap of ${limits.total}`;
  if (
    limits?.perRepository !== undefined &&
    (running.repositories.get(repository)?.implement ?? 0) >=
      limits.perRepository
  )
    return `the repository already runs its implement cap of ${limits.perRepository}`;
  return null;
}

// A stage's model: an implement attempt's issue label first, then the
// repository's policy preference for the stage, then the host's default for
// it. A preference may reuse the issue's label, which it then needs. Every
// choice stays inside the host's capabilities.
function stageModel(
  stage: Stage,
  label: Model | null,
  policy: ModelPolicy | null,
  settings: Settings,
  models: Models,
): Choice | { error: string } {
  if (stage === "initial" && label)
    return { model: label, selection: "issue-label" };
  const [path, preference] =
    stage === "initial" || stage === "retry"
      ? [`runKinds.implement.${stage}`, policy?.runKinds.implement?.[stage]]
      : [`runKinds.${stage}`, policy?.runKinds[stage]];
  if (!preference) return hostDefault(stage, settings, models);
  if ("source" in preference)
    return label
      ? { model: label, selection: "issue-label" }
      : {
          error: `the model policy's ${path} selects the issue's model label, and the issue has none`,
        };
  const model = models.resolveModel(
    `${preference.provider}/${preference.model}${preference.effort === undefined ? "" : `@${preference.effort}`}`,
  );
  return "error" in model
    ? {
        error: `the model policy's ${path} is outside this host's capabilities: ${model.error}`,
      }
    : { model, selection: "policy" };
}

function hostDefault(
  stage: Stage,
  settings: Settings,
  models: Models,
): Choice | { error: string } {
  const model = models.resolveModel(
    {
      initial: settings.defaultModel,
      retry: settings.retryModel,
      triage: settings.triageModel ?? settings.defaultModel,
      review: settings.reviewModel ?? settings.defaultModel,
    }[stage],
  );
  return "error" in model ? model : { model, selection: "host-default" };
}

// A review asking for a provider other than its implement attempt's may
// switch only to the host's explicitly configured review default, when the
// repository has no model policy or its fallback is host-default, and only
// when that default is available on another provider. Otherwise it stays on
// its choice and says diversity was unavailable: it never searches the host's
// models and never waits for diversity alone.
function diverse(
  choice: Choice,
  implementedBy: string,
  policy: ModelPolicy | null,
  settings: Settings,
  models: Models,
  available: (model: Model) => string | null,
): Choice {
  if (choice.model.provider !== implementedBy) return choice;
  const alternative =
    settings.reviewModel !== undefined &&
    (policy === null || policy.fallback === "host-default")
      ? models.resolveModel(settings.reviewModel)
      : null;
  return alternative &&
    !("error" in alternative) &&
    alternative.provider !== implementedBy &&
    available(alternative) === null
    ? { model: alternative, selection: "diversity" }
    : { ...choice, diversity: "unavailable" };
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

// The PR a continuing issue's next launch would deliver: an ended run's or
// orphaned claim's merge candidate, or an interrupted or paused merge
// relaunch's target.
function mergeTarget(
  previous: Run | undefined,
  claim: Claim | undefined,
): MergeRelaunch | undefined {
  if (previous?.ended && "mergeCandidate" in previous.ended)
    return previous.ended.mergeCandidate;
  if (
    previous?.ended &&
    ("interrupted" in previous.ended || "paused" in previous.ended)
  )
    return previous.continuation.mergeRelaunch;
  return claim?.inputResume ? undefined : claim?.mergeCandidate;
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

// The issue's model label as the host resolves it, null without one. Several
// labels, or one the host can't resolve or doesn't allow, are an error that
// holds every continuation.
function labelModel(
  issue: Pick<Issue, "labels">,
  modelLabelPrefix: string,
  models: Models,
): Model | { error: string } | null {
  const named = issue.labels.filter((label) =>
    label.startsWith(modelLabelPrefix),
  );
  if (named.length > 1)
    return { error: `several model labels: ${named.join(", ")}` };
  if (named.length === 1)
    return models.resolveModelLabel(modelLabelPrefix, named[0]);
  return null;
}

// One queue across every repository: priority first, then oldest issue,
// repository and number. Admission still enforces every gate.
function priorityFirst<T extends { repository: Repository; issue: Issue }>(
  continuations: T[],
): T[] {
  return [...continuations].sort(
    (left, right) =>
      priority(left.issue.labels, left.repository.configuration.labels) -
        priority(right.issue.labels, right.repository.configuration.labels) ||
      Date.parse(left.issue.createdAt) - Date.parse(right.issue.createdAt) ||
      (left.repository.name < right.repository.name
        ? -1
        : left.repository.name > right.repository.name
          ? 1
          : 0) ||
      left.issue.number - right.issue.number,
  );
}

// A ready-labelled issue's exclusion from pickup or its retry, given its
// repository, whose open issues may hold it: its labels, then its readiness,
// then its blockers.
function exclusion(
  issue: Issue,
  repository: Repository,
  continuing: Continuing,
): { reason: string; key?: HoldKey } | null {
  const labelled = exclusionReason(
    issue.labels,
    repository.configuration.labels,
    continuing,
  );
  if (labelled) return { reason: labelled };
  const held = readinessExclusion(issue, repository.issues, policy(repository));
  if (held) return held;
  const blockers = issue.blockedBy.filter(
    (blocker) => blocker.state === "open",
  );
  if (blockers.length > 0)
    return { reason: `blocked by ${references(blockers)}` };
  return null;
}
