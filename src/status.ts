// The status file: a machine-readable account of the latest pass, for the
// operator's monitoring. The factory posts no status to GitHub.
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ImageStorageStatus } from "./image-storage.ts";
import {
  runningCounts,
  emptyRunKindCounts,
  type Decision,
  type Run,
  type RunKindCounts,
} from "./factory.ts";
import type { ImplementLimits } from "./host-configuration.ts";
import {
  runKindNames,
  type FactoryConfigurationError,
  type RunKindName,
} from "./factory-configuration.ts";
import type { ProviderStatus } from "./events.ts";
import type { Credentials } from "./credentials.ts";

// What the pass read from the repository's `.scriptorium/config.json`. The
// last valid configuration that settles existing runs is never reported here.
export type ConfigurationCoverage =
  | { state: "valid"; version: 2 | 3; runKinds: RunKindName[] }
  | { state: ConfigurationProblemState; problem: string };

// Why a pass has no valid configuration: the reader's refusal, or the pass
// never reaching the file.
export const configurationProblemStates = [
  "missing",
  "unreadable",
  "invalid",
  "not-read",
] as const satisfies readonly (
  FactoryConfigurationError["state"] | "not-read"
)[];
export type ConfigurationProblemState =
  (typeof configurationProblemStates)[number];

// Who acts on a repository's pause: a person's factory hold, the
// repository's own inputs, or the host.
export const pauseCauses = [
  "factory-hold",
  "repository-input",
  "host",
] as const;
export type PauseCause = (typeof pauseCauses)[number];

export type RepositoryPause = { cause: PauseCause; reason: string };

// A run the host published a result for or settled, and when.
export type RunMark = { at: string; issue: number; runKind: RunKindName };

// The repository's passes as the host's records show them. A pass fails when
// it pauses the repository for a reason of its own, which a factory hold is
// not, or when a decision it applies there fails.
export type PassHealth = {
  // When the current unbroken run of failing passes began; null when the
  // latest pass did not fail.
  failingSince: string | null;
  // The latest failing pass's reason, only while failing.
  failure?: string;
  lastPublication: RunMark | null;
  lastSettlement: RunMark | null;
};

export const unknownPassHealth: PassHealth = {
  failingSince: null,
  lastPublication: null,
  lastSettlement: null,
};

// The open issues waiting on the owner, as the pass read them.
export type OwnerWaits = {
  label: string;
  issues: { number: number; title: string; url: string }[];
};

export const runPhases = ["running", "stopping", "exited"] as const;
export type RunPhase = (typeof runPhases)[number];

// A run the host still holds whose ending is not resolved.
export type UnresolvedRun = {
  repository: string;
  issue: number;
  runKind: RunKindName;
  startedAt: string;
  // Its start plus the time limit the host enforces.
  limitAt: string;
  phase: RunPhase;
  // Whether its result comment and labels have landed.
  resultPosted: boolean;
};

export type RepositoryStatus = {
  repository: string;
  state: "running" | "paused";
  // Who acts on the pause, and why the repository is paused; both absent
  // while it runs.
  cause?: PauseCause;
  reason?: string;
  configuration: ConfigurationCoverage;
  // The issues the factory saw ready but did not launch, and why.
  held: { issue: number; reason: string }[];
  // Active merge-delivery runs, distinct from pickup, retries and resumption.
  mergeRelaunches?: {
    issue: number;
    pullRequest: number;
    headCommit: string;
  }[];
  pass: PassHealth;
  // Null without an owner label role or when the pass read no open issues.
  ownerWaits: OwnerWaits | null;
};

export type CapacityCounts = {
  runKinds: RunKindCounts;
  implement: { limit: number | null; running: number; free: number | null };
};

export type Capacity = {
  observedAt: string;
  counting: "non-ended-runs";
  host: CapacityCounts;
  repositories: (CapacityCounts & { repository: string })[];
};

export function capacityCounts(
  runKinds: RunKindCounts,
  limit: number | undefined,
): CapacityCounts {
  return {
    runKinds,
    implement: {
      limit: limit ?? null,
      running: runKinds.implement,
      free:
        limit === undefined ? null : Math.max(0, limit - runKinds.implement),
    },
  };
}

export type Status = {
  updatedAt: string;
  repositories: RepositoryStatus[];
  providers: ProviderStatus[];
  capacity: Capacity;
  unresolvedRuns: UnresolvedRun[];
  imageStorage?: ImageStorageStatus;
  credentials?: Credentials;
};

// Each repository in the order given, with its configuration, its pause or
// null, and the issues this pass skipped there.
export function hostStatus(
  updatedAt: string,
  repositories: {
    name: string;
    paused: RepositoryPause | null;
    configuration: ConfigurationCoverage;
    pass?: PassHealth;
    ownerWaits?: OwnerWaits | null;
  }[],
  decisions: Decision[],
  providers: ProviderStatus[] = [],
  imageStorage?: ImageStorageStatus,
  runs: Run[] = [],
  limits?: ImplementLimits,
  unresolvedRuns: UnresolvedRun[] = [],
  credentials?: Credentials,
): Status {
  const counts = runningCounts(runs);
  const names = new Set([
    ...repositories.map(({ name }) => name),
    ...counts.repositories.keys(),
  ]);
  return {
    updatedAt,
    providers,
    capacity: {
      observedAt: updatedAt,
      counting: "non-ended-runs",
      host: capacityCounts(counts.host, limits?.total),
      repositories: [...names].map((repository) => ({
        repository,
        ...capacityCounts(
          counts.repositories.get(repository) ?? emptyRunKindCounts(),
          limits?.perRepository,
        ),
      })),
    },
    unresolvedRuns,
    ...(imageStorage && { imageStorage }),
    ...(credentials && { credentials }),
    repositories: repositories.map(
      ({ name, paused, configuration, pass, ownerWaits }) => ({
        repository: name,
        ...(paused === null
          ? { state: "running" as const }
          : { state: "paused" as const, ...paused }),
        configuration,
        ...(runs.some(
          (run) =>
            run.repository === name &&
            !run.exited &&
            run.continuation.mergeRelaunch,
        ) && {
          mergeRelaunches: runs.flatMap((run) =>
            run.repository === name &&
            !run.exited &&
            run.continuation.mergeRelaunch
              ? [
                  {
                    issue: run.issue,
                    pullRequest: run.continuation.mergeRelaunch.number,
                    headCommit: run.continuation.mergeRelaunch.headCommit,
                  },
                ]
              : [],
          ),
        }),
        held: decisions.flatMap((decision) =>
          decision.kind === "skip" && decision.repository === name
            ? [{ issue: decision.issue, reason: decision.reason }]
            : [],
        ),
        pass: pass ?? unknownPassHealth,
        ownerWaits: ownerWaits ?? null,
      }),
    ),
  };
}

// Checks for values read back from the factory's JSON records.
export type ObjectValue = Record<string, unknown>;
export const object = (value: unknown): ObjectValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : null;
export const time = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const fields = (record: ObjectValue) => Object.keys(record).sort().join();

function runMark(value: unknown): RunMark | null | undefined {
  if (value === null) return null;
  const record = object(value);
  return record &&
    fields(record) === "at,issue,runKind" &&
    time(record.at) &&
    Number.isSafeInteger(record.issue) &&
    (record.issue as number) > 0 &&
    runKindNames.includes(record.runKind as RunKindName)
    ? {
        at: record.at,
        issue: record.issue as number,
        runKind: record.runKind as RunKindName,
      }
    : undefined;
}

// A status file entry's pass health, or null when it is not one a pass
// writes.
export function passHealth(value: unknown): PassHealth | null {
  const record = object(value);
  if (!record) return null;
  const failing = record.failingSince !== null;
  const lastPublication = runMark(record.lastPublication);
  const lastSettlement = runMark(record.lastSettlement);
  return fields(record) ===
    (failing
      ? "failingSince,failure,lastPublication,lastSettlement"
      : "failingSince,lastPublication,lastSettlement") &&
    (!failing ||
      (time(record.failingSince) && typeof record.failure === "string")) &&
    lastPublication !== undefined &&
    lastSettlement !== undefined
    ? {
        failingSince: record.failingSince as string | null,
        ...(failing && { failure: record.failure as string }),
        lastPublication,
        lastSettlement,
      }
    : null;
}

// Each repository's pass health in the status file a previous process
// wrote; a repository without a readable entry establishes nothing.
export function readPassHealth(path: string): Map<string, PassHealth> {
  const health = new Map<string, PassHealth>();
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(path, "utf8"))?.repositories;
  } catch {
    return health;
  }
  if (Array.isArray(recorded))
    for (const value of recorded) {
      const entry = object(value);
      const pass = passHealth(entry?.pass);
      if (pass && typeof entry?.repository === "string")
        health.set(entry.repository, pass);
    }
  return health;
}

// Replaces the file whole, so a reader never sees a partial status.
export async function writeStatus(path: string, status: Status): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  await writeFile(partial, `${JSON.stringify(status, null, 2)}\n`);
  await rename(partial, path);
}
