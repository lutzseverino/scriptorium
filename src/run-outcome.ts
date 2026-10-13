// One ordered table for ended runs and orphaned claims. Interrupted runs
// relaunch as the same attempt and never reach this boundary.
export type PullRequestState = "open" | "merged" | "closed" | "none";

export type Observation = {
  ended: "exited" | "timed out" | "orphaned";
  pullRequest: PullRequestState;
  issueClosed: boolean;
  needsInput: boolean;
  unpushedChanges?: string[];
};

export type RunOutcome =
  | { kind: "awaiting merge" }
  | { kind: "done" }
  | { kind: "needs input" }
  | {
      kind: "failed";
      final: boolean;
      failure: string;
      unpushedChanges?: string[];
    };

export function runOutcome(
  observation: Observation,
  timeLimitMinutes: number,
): RunOutcome {
  if (observation.pullRequest === "open") return { kind: "awaiting merge" };
  if (observation.issueClosed) return { kind: "done" };
  if (observation.pullRequest === "merged")
    return {
      kind: "failed",
      final: true,
      failure:
        "its pull request merged without closing the issue; close the issue if that finished it",
    };
  if (observation.needsInput) return { kind: "needs input" };
  if (observation.unpushedChanges?.length)
    return {
      kind: "failed",
      final: true,
      failure:
        "the run's branch changes paths the factory's GitHub App can't push",
      unpushedChanges: observation.unpushedChanges,
    };
  return {
    kind: "failed",
    final: false,
    failure:
      observation.ended === "timed out"
        ? `the run exceeded the time limit of ${timeLimitMinutes} minutes`
        : observation.ended === "orphaned"
          ? observation.pullRequest === "closed"
            ? "its pull request closed without merging"
            : "no factory run or open pull request holds its claim"
          : "the run ended without an open pull request",
  };
}
