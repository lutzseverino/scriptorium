// Pure repository hold rules, shared by the decision core and host observation.
import type { Repository, Run } from "./factory.ts";
import { holdKeys, type HoldKey } from "./hold-comments.ts";

type Hold = { reason: string; hold: HoldKey; numbers: number[] | null };
type Holds = Pick<Repository, "releaseHold" | "factoryHold"> & {
  configuration?: Repository["configuration"] | null;
};

// Both scopes exclude every PR owned by the run. Release holds stop merges;
// factory holds stop every launch. Unreadable reads hold until a clear read.
export function repositoryHold(
  scope: "release" | "factory",
  repository: Holds,
  own: number[] = [],
): Hold | null {
  const factory = scope === "factory";
  const label = repository.configuration?.labels.hold;
  if (factory && label === undefined) return null;
  const numbers = factory ? repository.factoryHold : repository.releaseHold;
  const others = numbers?.filter((number) => !own.includes(number)) ?? [];
  if (numbers !== null && !others.length) return null;
  const numbered = others.map((number) => `#${number}`).join(", ");
  return {
    numbers: numbers === null ? null : others,
    hold: factory ? holdKeys.factory : holdKeys.release,
    reason: factory
      ? numbers === null
        ? `factory hold state is unreadable; pickup and merging resume after a successful read confirms no open issue or PR carries \`${label}\``
        : `factory hold (${numbered} ${others.length === 1 ? "carries" : "carry"} \`${label}\`); pickup and merging resume when the last labelled issue or PR closes or loses the label`
      : numbers === null
        ? "release hold state is unreadable; merging resumes after a successful read confirms no other labelled PR remains"
        : `release hold (${numbered}); merging resumes when the last labelled PR closes or loses the label`,
  };
}

export function repositoryGate(
  repository: Repository,
  own: number[] = [],
): Hold | null {
  return repository.paused !== null
    ? {
        numbers: null,
        reason: `${repository.name} is paused: ${repository.paused}`,
        hold: holdKeys.configuration,
      }
    : repositoryHold("factory", repository, own);
}

// Observations retain the complete owned set; a delivery target
// supplies ownership for orphaned, interrupted and paused merge launches.
export function ownedPullRequests(
  run?: Run,
  target = run?.continuation.mergeRelaunch,
): number[] {
  return run?.ownedPullRequests ?? (target ? [target.number] : []);
}

// Null records an unreadable read during the run. Historical evidence survives
// clearing the label and temporary merge ineligibility, without self-holds.
export function heldPullRequests(
  observed: Run["holdObserved"],
  own: number[],
): number[] {
  return observed === null || observed?.some((number) => !own.includes(number))
    ? own
    : [];
}

// Accumulate facts until settlement, retaining any failed read across clears.
export function observeHolds(
  observed: Run["holdObserved"],
  repository: Holds,
): Run["holdObserved"] {
  const { releaseHold, factoryHold } = repository;
  return observed === null || releaseHold === null || factoryHold === null
    ? null
    : [
        ...new Set([
          ...(observed ?? []),
          ...(releaseHold ?? []),
          ...(factoryHold ?? []),
        ]),
      ];
}
