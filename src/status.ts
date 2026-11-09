// The status file: a machine-readable account of the latest pass, for the
// operator's monitoring. The factory posts no status to GitHub.
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
import type { ProviderStatus } from "./events.ts";

export type RepositoryStatus = {
  repository: string;
  state: "running" | "paused";
  // Why the repository is paused; absent while it runs.
  reason?: string;
  // The issues the factory saw ready but did not launch, and why.
  held: { issue: number; reason: string }[];
  // Active merge-delivery runs, distinct from pickup, retries and resumption.
  mergeRelaunches?: {
    issue: number;
    pullRequest: number;
    headCommit: string;
  }[];
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
  imageStorage?: ImageStorageStatus;
};

// Each repository in the order given, with its pause reason or null, and
// the issues this pass skipped there.
export function hostStatus(
  updatedAt: string,
  repositories: { name: string; paused: string | null }[],
  decisions: Decision[],
  providers: ProviderStatus[] = [],
  imageStorage?: ImageStorageStatus,
  runs: Run[] = [],
  limits?: ImplementLimits,
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
    ...(imageStorage && { imageStorage }),
    repositories: repositories.map(({ name, paused }) => ({
      repository: name,
      ...(paused === null
        ? { state: "running" as const }
        : { state: "paused" as const, reason: paused }),
      ...(runs.some(
        (run) =>
          run.repository === name &&
          run.ended === null &&
          run.continuation.mergeRelaunch,
      ) && {
        mergeRelaunches: runs.flatMap((run) =>
          run.repository === name &&
          run.ended === null &&
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
    })),
  };
}

// Replaces the file whole, so a reader never sees a partial status.
export async function writeStatus(path: string, status: Status): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  await writeFile(partial, `${JSON.stringify(status, null, 2)}\n`);
  await rename(partial, path);
}
