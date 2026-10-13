// The status file: a machine-readable account of the latest pass, for the
// operator's monitoring. The factory posts no status to GitHub.
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Decision } from "./factory.ts";

export type RepositoryStatus = {
  repository: string;
  state: "running" | "paused";
  // Why the repository is paused; absent while it runs.
  reason?: string;
  // The issues the factory saw ready but did not launch, and why.
  held: { issue: number; reason: string }[];
};

export type Status = { updatedAt: string; repositories: RepositoryStatus[] };

// Each repository in the order given, with its pause reason or null, and
// the issues this pass skipped there.
export function hostStatus(
  updatedAt: string,
  repositories: { name: string; paused: string | null }[],
  decisions: Decision[],
): Status {
  return {
    updatedAt,
    repositories: repositories.map(({ name, paused }) => ({
      repository: name,
      ...(paused === null
        ? { state: "running" as const }
        : { state: "paused" as const, reason: paused }),
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
