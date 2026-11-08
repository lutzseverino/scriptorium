// Every ending of an ended run or an orphaned claim, from observation to
// outcome: the host observes both here, once per ending, and the decision
// core settles both through one ordered table, which owns retry choice too.
// Interrupted and paused runs relaunch as the same attempt and never reach
// this module.
import { unpushedChanges, type Git } from "./clone.ts";
import { runKind, type FactoryConfiguration } from "./factory-configuration.ts";
import type {
  Claim,
  Decision,
  Issue,
  Models,
  Repository,
  Run,
  Snapshot,
} from "./factory.ts";
import { heldPullRequests } from "./repository-holds.ts";
import { isStopped } from "./label-roles.ts";
import {
  runBranch,
  type InputResume,
  type MergeRelaunch,
  type RepositoryPlatform,
} from "./platform.ts";

export type PullRequestState = "open" | "merged" | "closed" | "none";

// What the platform and the run's branch showed when an ending was observed.
export type EndingFacts = {
  pullRequest: PullRequestState;
  closesIssue?: true;
  // The one open PR the run owns, when it is behind its default branch and
  // may get a merge relaunch.
  mergeCandidate?: MergeRelaunch;
  // The one open PR the run owns, and for a review run whether it is still a
  // draft, whatever its base.
  openPullRequest?: MergeRelaunch & { draft?: true };
  // Paths under the host's unpushable paths in commits the remote lacks.
  unpushedChanges?: string[];
};

// How an ended run ended: the facts, whether it ran out of time, and whether
// the host found it orphaned by a restart.
export type RunEnding = EndingFacts & { timedOut: boolean; orphaned?: true };

// What an ending's reads need: the repository's platform and clone as this
// pass found them, whether the pass paused it, and the host's unpushable
// paths.
export type EndingReads = {
  platform: Pick<RepositoryPlatform, "pullRequestObservation">;
  git: Git;
  clone: string;
  configuration: FactoryConfiguration;
  paused: boolean;
  unpushablePaths: string[];
};

// Observes one ending of an ended run or an orphaned claim on the open
// `issue`, undefined once it closed: PRs opened since `since` count, and a
// review reads its PR's draft state. Owned PRs accumulate, and a hold-stopped
// merge attempt does not spend its head's recovery. Earlier outcome rows
// settle without consulting the branch, which both runs and claims assess
// against the same refreshed remote default branch.
export async function observeEnding(
  reads: EndingReads,
  issue: Issue | undefined,
  ended: Partial<
    Pick<Run, "mergeRelaunch" | "holdObserved" | "ownedPullRequests">
  > & {
    issue: number;
    since?: string;
    review?: boolean;
    // The PR a review works on, which its run owns whatever its branch.
    target?: Pick<MergeRelaunch, "number">;
    mergeRelaunchHeads?: string[];
  },
): Promise<{
  facts: EndingFacts;
  pullRequests: InputResume["pullRequests"];
  ownedPullRequests: number[];
  mergeRelaunchHeads?: string[];
}> {
  const observation = await reads.platform.pullRequestObservation(
    ended.issue,
    ended.since,
    ended.review,
    ended.target?.number,
  );
  const owned = [
    ...new Set([
      ...(ended.ownedPullRequests ?? []),
      ...observation.ownedPullRequests,
    ]),
  ];
  const { mergeRelaunch } = ended;
  const held = heldPullRequests(ended.holdObserved, owned);
  const mergeRelaunchHeads =
    mergeRelaunch && held.includes(mergeRelaunch.number)
      ? ended.mergeRelaunchHeads?.filter(
          (head) => head !== mergeHead(mergeRelaunch),
        )
      : ended.mergeRelaunchHeads;
  const mergeCandidate = await readMergeCandidate(
    reads,
    issue,
    observation.mergeCandidate,
    mergeRelaunchHeads ?? [],
    held,
  );
  const paths =
    issue &&
    ["none", "closed"].includes(observation.state) &&
    !isStopped(issue.labels, reads.configuration.labels)
      ? await unpushedChanges(
          reads.git,
          reads.clone,
          runBranch(issue.number),
          reads.unpushablePaths,
        )
      : [];
  return {
    facts: {
      pullRequest: observation.state,
      ...(observation.closesIssue && { closesIssue: true }),
      ...(mergeCandidate && { mergeCandidate }),
      ...(observation.state === "open" &&
        observation.mergeCandidate && {
          openPullRequest: observation.mergeCandidate,
        }),
      ...(paths.length && { unpushedChanges: paths }),
    },
    pullRequests: observation.pullRequests,
    ownedPullRequests: owned,
    ...(mergeRelaunchHeads && { mergeRelaunchHeads }),
  };
}

// A merge relaunch's PR and head, which one recovery consumes.
export function mergeHead(target: MergeRelaunch): string {
  return `${target.number}:${target.headCommit}`;
}

// This is observation only. Delivery Git operations stay with the agent.
// rev-list is empty exactly when origin/HEAD is an ancestor of the head,
// including diverged histories without relying on a platform freshness fact.
async function readMergeCandidate(
  { git, clone, configuration, paused }: EndingReads,
  issue: Issue | undefined,
  candidate: MergeRelaunch | undefined,
  consumed: string[],
  held: number[],
): Promise<MergeRelaunch | undefined> {
  if (
    !candidate ||
    !issue ||
    paused ||
    isStopped(issue.labels, configuration.labels) ||
    issue.labels.includes(configuration.labels.failed) ||
    consumed.includes(mergeHead(candidate))
  )
    return undefined;
  const defaultRef = (
    await git(clone, ["symbolic-ref", "refs/remotes/origin/HEAD"])
  ).trim();
  if (candidate.baseBranch !== defaultRef.slice("refs/remotes/origin/".length))
    return undefined;
  if (held.includes(candidate.number)) return candidate;
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

// A failed first implement run that may retry on the retry stage's model.
export type SettlingRun = Pick<
  Run,
  | "repository"
  | "issue"
  | "attempt"
  | "inputResume"
  | "runKind"
  | "target"
  | "handBacks"
> & {
  log: string | null;
};
export type Retry = { run: SettlingRun; failure: string };

// The hand-backs an issue's reviews may make before its rounds fail.
export const handBackLimit = 2;

// Ended runs and orphaned claims settle through one table, in order. A closed
// issue is done. A merged PR completes the issue only with a closing
// reference. A stop releases the claim, keeping its work and PR. An open PR
// awaits merge, unless review is on: then an implement run's open PR, and a
// review's PR left a draft for a hand-back, pass to the next run kind. Triage
// changes no code, so it ends once its issue leaves the triage label. A
// failed first implement run may retry once; any other failure fails the
// issue.
export function settleEnding(
  ended: { run: Run; ending: RunEnding } | { claim: Claim },
  repository: Repository,
  snapshot: Snapshot,
  models: Models,
): Decision[] | Retry {
  const { configuration } = repository;
  const { labels } = configuration;
  const run: SettlingRun =
    "run" in ended
      ? ended.run
      : {
          repository: repository.name,
          issue: ended.claim.issue,
          attempt: 1,
          log: null,
        };
  const facts: EndingFacts & { timedOut?: boolean; orphaned?: true } =
    "run" in ended ? ended.ending : { ...ended.claim, orphaned: true };
  const at = { repository: repository.name, issue: run.issue };
  const issue = repository.issues.find((issue) => issue.number === run.issue);
  const fail = (
    failure: string,
    final = false,
    unpushed?: string[],
  ): Decision[] | Retry => {
    const decision: Decision = {
      kind: "fail",
      ...at,
      failure,
      log: run.log,
      ...(unpushed && { unpushedChanges: unpushed }),
    };
    // Without a policy preference, a retry needs the host's retry model.
    return final ||
      run.attempt === 2 ||
      run.runKind !== undefined ||
      (!repository.modelPolicy?.runKinds.implement?.retry &&
        "error" in models.resolveModel(snapshot.settings.retryModel))
      ? [decision]
      : { run, failure };
  };
  if (run.runKind === "triage")
    return issue && labels.triage && issue.labels.includes(labels.triage)
      ? fail(
          `the triage run ended with the issue still labelled ${labels.triage}`,
        )
      : [{ kind: "release", ...at }];
  if (!issue) return [{ kind: "release", ...at }];
  if (facts.pullRequest === "merged")
    return facts.closesIssue
      ? [{ kind: "complete", ...at }]
      : fail(
          "its pull request merged without closing the issue; close the issue if that finished it",
          true,
        );
  if (isStopped(issue.labels, labels)) return [{ kind: "release", ...at }];
  if (facts.pullRequest === "open") {
    // A claim records no run kind, so it hands nothing off.
    const open = "run" in ended ? facts.openPullRequest : undefined;
    if (open && runKind(configuration, "review")) {
      if (run.runKind !== "review")
        return [{ kind: "keep", ...at, quiet: true }];
      if (open.draft)
        return (run.handBacks ?? 0) < handBackLimit
          ? [{ kind: "keep", ...at, quiet: true }]
          : fail(
              `its review rounds did not converge after ${handBackLimit} hand-backs`,
            );
    }
    return [{ kind: "keep", ...at }];
  }
  if (facts.unpushedChanges?.length)
    return fail(
      "the run's branch changes paths the factory's GitHub App can't push",
      true,
      facts.unpushedChanges,
    );
  return fail(
    facts.orphaned
      ? facts.pullRequest === "closed"
        ? "its pull request closed without merging"
        : "no factory run or open pull request holds its claim"
      : facts.timedOut
        ? `the run exceeded the time limit of ${snapshot.settings.timeLimitMinutes} minutes`
        : "the run ended without an open pull request",
  );
}
