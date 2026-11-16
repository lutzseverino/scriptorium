// A second, read-only consumer of the host's operational projection.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  readHostConfiguration,
  type HostConfiguration,
} from "./host-configuration.ts";
import { providerStatus, type ProviderStatus } from "./events.ts";
import { fresh, usageReading, usageHold, usageHoldAfter } from "./usage.ts";
import { ownerHold, ownerReserve, reserveExpiry } from "./owner.ts";
import type { OwnerControl, RunKindCounts } from "./factory.ts";
import {
  capacityCounts,
  configurationProblemStates,
  object,
  passHealth,
  pauseCauses,
  runPhases,
  time,
  type ConfigurationCoverage,
  type ConfigurationProblemState,
  type ObjectValue,
  type OwnerWaits,
  type PassHealth,
  type RepositoryPause,
  type RunPhase,
  type UnresolvedRun,
} from "./status.ts";
import { runKindNames, type RunKindName } from "./factory-configuration.ts";
import { createRegistry, type ModelFacts } from "./providers.ts";
import { UsageReadError, type UsageWindow } from "./providers/usage.ts";

export const statusUsage =
  "node src/main.ts status <host configuration> [--json] [--live-usage]";

type Observation = {
  state: "current" | "last-observed" | "unavailable";
  source: string;
  at: string | null;
  problem?: string;
};

type BudgetProvider = Omit<
  ProviderStatus,
  | "running"
  | "paused"
  | "cap"
  | "free"
  | "retained"
  | "claimsHeld"
  | "pauseAtThreshold"
  | "drained"
  | "reason"
  | "nextAction"
> & {
  cap: number;
  running: number | null;
  free: number | null;
  paused: number | null;
  retained: number | null;
  claimsHeld: boolean | null;
  pausedRecoveryUsageHeld: boolean | null;
  launchPermission: "not-established";
  pauseAtThreshold: boolean | null;
  drained: boolean | null;
  draining: boolean | null;
  reason: ProviderStatus["reason"] | "unavailable";
  nextAction: ProviderStatus["nextAction"] | "inspect-observations";
  observations: { work: Observation; usage: Observation; owner: Observation };
};

type ObservedCapacityCounts = {
  runKinds: RunKindCounts | null;
  implement: {
    limit: number | null;
    running: number | null;
    free: number | null;
  };
};

type BudgetCapacity = {
  counting: "non-ended-runs";
  observation: Observation;
  host: ObservedCapacityCounts;
  repositories: (ObservedCapacityCounts & { repository: string })[];
};

// Null configuration and pause establish nothing while the observation is
// unavailable.
type Coverage = {
  observation: Observation;
  repositories: {
    repository: string;
    configuration: ConfigurationCoverage | null;
    paused: RepositoryPause | null;
  }[];
};

// Null pass, owner waits and overdue runs establish nothing while the
// observation is unavailable.
type Health = {
  observation: Observation;
  repositories: {
    repository: string;
    pass: PassHealth | null;
    ownerWaits: OwnerWaits | null;
  }[];
  overdueRuns: UnresolvedRun[] | null;
};

export type LaunchBudget = {
  version: 1;
  observedAt: string;
  models: ModelFacts;
  capacity: BudgetCapacity;
  coverage: Coverage;
  health: Health;
  providers: BudgetProvider[];
};

export type StatusPorts = {
  now(): Date;
  print(line: string): void;
  error(line: string): void;
  readUsage?(provider: string): Promise<UsageWindow | null>;
};

const unavailable = (source: string, problem: string): Observation => ({
  state: "unavailable",
  source,
  at: null,
  problem,
});

export async function status(
  args: string[],
  ports: StatusPorts,
): Promise<number> {
  const paths = args.filter((arg) => !arg.startsWith("--"));
  if (
    paths.length !== 1 ||
    args.some(
      (arg) =>
        arg.startsWith("--") && arg !== "--json" && arg !== "--live-usage",
    ) ||
    new Set(args).size !== args.length
  ) {
    ports.error(`Usage: ${statusUsage}`);
    return 2;
  }
  let configuration;
  try {
    configuration = readHostConfiguration(paths[0], ports.error);
  } catch (error) {
    ports.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const live = args.includes("--live-usage");
  const registry =
    live && !ports.readUsage
      ? createRegistry(configuration.providers, configuration.models)
      : null;
  const budget = await readBudget(configuration, {
    now: ports.now,
    ...(live && {
      readUsage:
        ports.readUsage ??
        ((provider: string) => registry!.providers.get(provider)!.readUsage()),
    }),
  });
  ports.print(
    args.includes("--json")
      ? JSON.stringify(budget, null, 2)
      : formatStatus(budget),
  );
  return 0;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readObservation(
  directory: string,
  file: string,
): { data: ObjectValue | null; observation: Observation } {
  try {
    const path = join(directory, file);
    const data = object(JSON.parse(readFileSync(path, "utf8")));
    if (!data)
      return {
        data: null,
        observation: unavailable(file, "inconsistent record"),
      };
    return {
      data,
      observation: {
        state: "last-observed",
        source: file,
        at: statSync(path).mtime.toISOString(),
      },
    };
  } catch (error) {
    return {
      data: null,
      observation: unavailable(
        file,
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "missing record"
          : "unreadable record",
      ),
    };
  }
}

// Only complete, timestamped observations can establish counts. Old status
// files remain readable, with unavailable capacity rather than invented slots.
function readCapacity(
  configuration: HostConfiguration,
  work: ReturnType<typeof readObservation>,
  pending: boolean,
  now: Date,
): BudgetCapacity {
  const capacity = object(work.data?.capacity);
  const kinds = (value: unknown): RunKindCounts | null => {
    const record = object(object(value)?.runKinds);
    return record &&
      count(record.implement) &&
      count(record.triage) &&
      count(record.review)
      ? {
          implement: record.implement,
          triage: record.triage,
          review: record.review,
        }
      : null;
  };
  const host = kinds(capacity?.host);
  const repositories = new Map<string, RunKindCounts>();
  const entries = capacity?.repositories;
  let valid = Array.isArray(entries);
  if (Array.isArray(entries))
    for (const value of entries) {
      const entry = object(value);
      const counts = kinds(entry);
      if (
        !entry ||
        typeof entry.repository !== "string" ||
        !counts ||
        repositories.has(entry.repository)
      )
        valid = false;
      else repositories.set(entry.repository, counts);
    }
  const known =
    !pending &&
    valid &&
    host !== null &&
    configuration.repositories.every((repository) =>
      repositories.has(repository),
    ) &&
    capacity?.counting === "non-ended-runs" &&
    time(capacity.observedAt) &&
    Date.parse(capacity.observedAt) <= now.getTime() &&
    Object.entries(host).every(
      ([kind, total]) =>
        total ===
        [...repositories.values()].reduce(
          (sum, entry) => sum + entry[kind as keyof RunKindCounts],
          0,
        ),
    );
  const project = (
    counts: RunKindCounts | null,
    limit: number | undefined,
  ): ObservedCapacityCounts =>
    counts
      ? capacityCounts(counts, limit)
      : {
          runKinds: null,
          implement: { limit: limit ?? null, running: null, free: null },
        };
  return {
    counting: "non-ended-runs",
    observation: known
      ? { ...work.observation, at: capacity.observedAt as string }
      : unavailable(
          "status.json",
          pending
            ? "pending operational transaction; host recovery required"
            : (work.observation.problem ??
                "missing, legacy or inconsistent capacity observation"),
        ),
    host: project(known ? host : null, configuration.implement?.total),
    repositories: configuration.repositories.map((repository) => ({
      repository,
      ...project(
        known ? (repositories.get(repository) ?? null) : null,
        configuration.implement?.perRepository,
      ),
    })),
  };
}

// The configuration a status file entry records, or null when it is not one
// a pass writes.
function configurationCoverage(value: unknown): ConfigurationCoverage | null {
  const record = object(value);
  if (!record) return null;
  const fields = Object.keys(record).sort().join();
  if (record.state === "valid") {
    const kinds = record.runKinds;
    // Known kinds, each once, in canonical order; implement is the minimum
    // and version 2's only kind.
    const ordered = Array.isArray(kinds)
      ? runKindNames.filter((kind) => kinds.includes(kind))
      : [];
    return fields === "runKinds,state,version" &&
      (record.version === 2 || record.version === 3) &&
      Array.isArray(kinds) &&
      ordered.join() === kinds.join() &&
      ordered.includes("implement") &&
      (record.version === 3 || ordered.length === 1)
      ? { state: "valid", version: record.version, runKinds: ordered }
      : null;
  }
  return fields === "problem,state" &&
    configurationProblemStates.includes(
      record.state as ConfigurationProblemState,
    ) &&
    typeof record.problem === "string"
    ? {
        state: record.state as ConfigurationProblemState,
        problem: record.problem,
      }
    : null;
}

type CoverageEntry = {
  configuration: ConfigurationCoverage;
  paused: RepositoryPause | null;
  // The entry as the status file holds it.
  recorded: ObjectValue;
};

// The status file's repository entries, or null when any doubt about the
// record makes them unknown rather than guessed: the file is missing,
// unreadable, future-dated, legacy or inconsistent, or lacks a listed
// repository. A pending transaction concerns provider work, not these.
function coverageEntries(
  configuration: HostConfiguration,
  work: ReturnType<typeof readObservation>,
  now: Date,
): Map<string, CoverageEntry> | null {
  const entries = new Map<string, CoverageEntry>();
  const recorded = work.data?.repositories;
  let valid = Array.isArray(recorded);
  if (Array.isArray(recorded))
    for (const value of recorded) {
      const entry = object(value);
      const read = configurationCoverage(entry?.configuration);
      const paused =
        entry?.state === "paused" &&
        pauseCauses.includes(entry.cause as RepositoryPause["cause"]) &&
        typeof entry.reason === "string"
          ? {
              cause: entry.cause as RepositoryPause["cause"],
              reason: entry.reason,
            }
          : null;
      if (
        !entry ||
        typeof entry.repository !== "string" ||
        entries.has(entry.repository) ||
        !read ||
        (entry.state === "running"
          ? "cause" in entry || "reason" in entry || read.state !== "valid"
          : paused === null)
      )
        valid = false;
      else
        entries.set(entry.repository, {
          configuration: read,
          paused,
          recorded: entry,
        });
    }
  const updatedAt = work.data?.updatedAt;
  return valid &&
    time(updatedAt) &&
    Date.parse(updatedAt) <= now.getTime() &&
    configuration.repositories.every((repository) => entries.has(repository))
    ? entries
    : null;
}

// Coverage is the last pass's account of each listed repository.
function readCoverage(
  configuration: HostConfiguration,
  work: ReturnType<typeof readObservation>,
  entries: Map<string, CoverageEntry> | null,
): Coverage {
  return {
    observation: entries
      ? { ...work.observation, at: work.data!.updatedAt as string }
      : unavailable(
          "status.json",
          work.observation.problem ??
            "missing, legacy or inconsistent coverage observation",
        ),
    repositories: configuration.repositories.map((repository) => ({
      repository,
      configuration: entries ? entries.get(repository)!.configuration : null,
      paused: entries ? entries.get(repository)!.paused : null,
    })),
  };
}

// The owner waits a status file entry records: null, or undefined when they
// are not what a pass writes.
function ownerWaits(value: unknown): OwnerWaits | null | undefined {
  if (value === null) return null;
  const record = object(value);
  const issues = record?.issues;
  if (
    !record ||
    Object.keys(record).sort().join() !== "issues,label" ||
    typeof record.label !== "string" ||
    !Array.isArray(issues)
  )
    return undefined;
  const read = issues.map(object);
  return read.every(
    (issue, index) =>
      issue &&
      Object.keys(issue).sort().join() === "number,title,url" &&
      count(issue.number) &&
      issue.number > 0 &&
      (index === 0 || issue.number > (read[index - 1]!.number as number)) &&
      typeof issue.title === "string" &&
      typeof issue.url === "string",
  )
    ? {
        label: record.label,
        issues: read.map((issue) => ({
          number: issue!.number as number,
          title: issue!.title as string,
          url: issue!.url as string,
        })),
      }
    : undefined;
}

function unresolvedRun(value: unknown): UnresolvedRun | null {
  const record = object(value);
  return record &&
    Object.keys(record).sort().join() ===
      "issue,limitAt,phase,repository,resultPosted,runKind,startedAt" &&
    typeof record.repository === "string" &&
    count(record.issue) &&
    record.issue > 0 &&
    runKindNames.includes(record.runKind as RunKindName) &&
    time(record.startedAt) &&
    time(record.limitAt) &&
    runPhases.includes(record.phase as RunPhase) &&
    typeof record.resultPosted === "boolean"
    ? {
        repository: record.repository,
        issue: record.issue,
        runKind: record.runKind as RunKindName,
        startedAt: record.startedAt,
        limitAt: record.limitAt,
        phase: record.phase as RunPhase,
        resultPosted: record.resultPosted,
      }
    : null;
}

// Health is the last pass's account too, unavailable whenever coverage is
// and whenever the file does not record it. A run is overdue once its limit
// is at or before the command's observation.
function readHealth(
  configuration: HostConfiguration,
  work: ReturnType<typeof readObservation>,
  entries: Map<string, CoverageEntry> | null,
  now: Date,
): Health {
  const health = new Map<
    string,
    { pass: PassHealth; ownerWaits: OwnerWaits | null }
  >();
  for (const [repository, { recorded }] of entries ?? []) {
    const pass = passHealth(recorded.pass);
    const waits = ownerWaits(recorded.ownerWaits);
    if (pass && waits !== undefined)
      health.set(repository, { pass, ownerWaits: waits });
  }
  const recordedRuns = work.data?.unresolvedRuns;
  const runs = Array.isArray(recordedRuns)
    ? recordedRuns.map(unresolvedRun)
    : [];
  const known =
    entries !== null &&
    health.size === entries.size &&
    Array.isArray(recordedRuns) &&
    runs.every((run) => run !== null);
  return {
    observation: known
      ? { ...work.observation, at: work.data!.updatedAt as string }
      : unavailable(
          "status.json",
          work.observation.problem ??
            "missing, legacy or inconsistent health observation",
        ),
    repositories: configuration.repositories.map((repository) => ({
      repository,
      pass: known ? health.get(repository)!.pass : null,
      ownerWaits: known ? health.get(repository)!.ownerWaits : null,
    })),
    overdueRuns: known
      ? (runs as UnresolvedRun[])
          .filter((run) => Date.parse(run.limitAt) <= now.getTime())
          .sort(
            (a, b) =>
              Date.parse(a.limitAt) - Date.parse(b.limitAt) ||
              a.repository.localeCompare(b.repository) ||
              a.issue - b.issue,
          )
      : null,
  };
}

export async function readBudget(
  configuration: HostConfiguration,
  ports: Pick<StatusPorts, "now" | "readUsage">,
): Promise<LaunchBudget> {
  const now = ports.now();
  const observedAt = now.toISOString();
  const workFile = readObservation(configuration.stateDirectory, "status.json");
  const usageFile = readObservation(configuration.stateDirectory, "usage.json");
  const ownerFile = readObservation(configuration.stateDirectory, "owner.json");
  const checkpoint = readObservation(
    configuration.stateDirectory,
    "events-state.json",
  );
  const entries = coverageEntries(configuration, workFile, now);
  return {
    version: 1,
    observedAt,
    capacity: readCapacity(
      configuration,
      workFile,
      checkpoint.data?.pending !== undefined,
      now,
    ),
    coverage: readCoverage(configuration, workFile, entries),
    health: readHealth(configuration, workFile, entries, now),
    models: createRegistry(configuration.providers, configuration.models)
      .modelFacts,
    providers: await Promise.all(
      Object.entries(configuration.providers).map(
        async ([provider, { cap }]): Promise<BudgetProvider> => {
          const candidates = [
            workFile,
            ...(checkpoint.data?.version === 1 ? [checkpoint] : []),
          ]
            .flatMap((file) => {
              const entries = file.data?.providers;
              const matches = Array.isArray(entries)
                ? entries.filter(
                    (entry) => object(entry)?.provider === provider,
                  )
                : [];
              const entry = matches.length === 1 ? object(matches[0]) : null;
              return entry &&
                time(entry.observedAt) &&
                Date.parse(entry.observedAt) <= now.getTime()
                ? [
                    {
                      entry,
                      observation: {
                        ...file.observation,
                        at: entry.observedAt,
                      },
                    },
                  ]
                : [];
            })
            .sort(
              (a, b) =>
                Date.parse(b.observation.at!) - Date.parse(a.observation.at!),
            );
          const selected = candidates[0];
          const work = selected?.entry ?? null;
          const pending = checkpoint.data?.pending !== undefined;
          const workKnown =
            !pending &&
            work !== null &&
            work.counting === "non-ended-runs" &&
            count(work.running) &&
            count(work.paused) &&
            count(work.retained) &&
            work.paused <= work.retained + work.running &&
            count(work.cap) &&
            work.free === Math.max(0, work.cap - work.running);
          const running = workKnown ? (work.running as number) : null;
          const paused = workKnown ? (work.paused as number) : null;
          const retained =
            workKnown && count(work.retained) ? work.retained : null;
          const workObservation = workKnown
            ? {
                ...selected!.observation,
                ...(workFile.observation.problem && {
                  problem: `status.json: ${workFile.observation.problem}`,
                }),
              }
            : unavailable(
                selected?.observation.source ?? "status.json",
                pending
                  ? "pending operational transaction; host recovery required"
                  : (workFile.observation.problem ??
                      "missing, legacy or inconsistent provider observation"),
              );

          const storedUsage = object(usageFile.data?.[provider]);
          const snapshotUsage = object(work?.usage);
          const usageEntry =
            storedUsage ??
            (snapshotUsage &&
            (snapshotUsage.state === "known" ||
              snapshotUsage.state === "unknown")
              ? {
                  reading:
                    snapshotUsage.state === "known"
                      ? snapshotUsage.reading
                      : null,
                  hold: work?.usageHold,
                }
              : null);
          const usageSource = storedUsage
            ? usageFile.observation
            : (selected?.observation ?? usageFile.observation);
          const cachedReading = usageReading(usageEntry?.reading);
          const cachedHold = usageHold(usageEntry?.hold);
          const usageKnown =
            !pending &&
            usageEntry !== null &&
            (usageEntry.reading === null || cachedReading !== null) &&
            (usageEntry.hold === null || cachedHold !== null) &&
            (!cachedReading || Date.parse(cachedReading.at) <= now.getTime());
          let reading = usageKnown ? fresh(cachedReading, now) : null;
          let usageObserved = usageKnown;
          let usageObservation = usageKnown
            ? {
                ...usageSource,
                at: cachedReading?.at ?? usageSource.at,
                ...((cachedReading && !reading) || !storedUsage
                  ? {
                      problem: [
                        !storedUsage &&
                          `usage.json: ${usageFile.observation.problem ?? "missing provider usage"}`,
                        cachedReading && !reading && "cached usage expired",
                      ]
                        .filter(Boolean)
                        .join("; "),
                    }
                  : {}),
              }
            : unavailable(
                "usage.json",
                usageFile.observation.problem ??
                  "missing or inconsistent provider usage",
              );
          if (ports.readUsage) {
            if (
              time(usageEntry?.nextRead) &&
              Date.parse(usageEntry.nextRead) > now.getTime()
            )
              usageObservation = {
                ...usageObservation,
                problem: `usage read deferred until ${usageEntry.nextRead}`,
              };
            else {
              try {
                const window = await ports.readUsage(provider);
                const liveReading =
                  window &&
                  usageReading({ ...window, at: ports.now().toISOString() });
                if (liveReading) {
                  reading = liveReading;
                  usageObserved = true;
                  usageObservation = {
                    state: "current",
                    source: "provider",
                    at: liveReading.at,
                  };
                } else
                  usageObservation = withProblem(usageObservation, "no-window");
              } catch (error) {
                usageObservation = withProblem(
                  usageObservation,
                  error instanceof UsageReadError && error.status
                    ? `http:${error.status}`
                    : "read-error",
                );
              }
            }
          } else if (usageEntry?.failure)
            usageObservation = withProblem(
              usageObservation,
              usageEntry.failure === "no-window"
                ? "no-window"
                : "previous usage read failed",
            );
          const projectionTime = ports.now();
          reading = fresh(reading, projectionTime);
          if (
            cachedReading &&
            !reading &&
            !usageObservation.problem?.includes("expired")
          )
            usageObservation = withProblem(
              usageObservation,
              "cached usage expired",
            );
          // The hold is independent evidence even if its cached reading is damaged.
          const hold = usageHoldAfter(
            pending ? null : cachedHold,
            reading,
            projectionTime,
            configuration.usage,
          );

          const storedOwner = object(
            object(ownerFile.data?.providers)?.[provider],
          );
          const ownerEntry =
            storedOwner ??
            (work && "ownerHold" in work && "reserve" in work
              ? { hold: work.ownerHold, reserve: work.reserve }
              : null);
          const ownerSource = storedOwner
            ? ownerFile.observation
            : (selected?.observation ?? ownerFile.observation);
          // A damaged record cannot erase positive hold evidence from the
          // last operational observation. An explicit recorded null can.
          const held =
            ownerHold(ownerEntry?.hold) ??
            (ownerEntry?.hold !== null ? ownerHold(work?.ownerHold) : null);
          const reserve = ownerReserve(ownerEntry?.reserve);
          const ownerKnown =
            !pending &&
            ownerEntry !== null &&
            (ownerEntry.hold === null || held !== null) &&
            (ownerEntry.reserve === null || reserve !== null);
          const control: OwnerControl | null = ownerEntry
            ? {
                hold: held,
                reserve:
                  reserve &&
                  reserveExpiry(
                    provider,
                    reserve,
                    configuration.usage,
                    reading,
                    projectionTime,
                  ) === null
                    ? reserve
                    : null,
              }
            : null;
          const projected = providerStatus(
            provider,
            projectionTime.toISOString(),
            reading,
            hold,
            control,
            configuration.usage,
            running ?? 0,
            paused ?? 0,
          );
          const claimsHeld =
            projected.ownerHold !== null ||
            projected.pauseAtThreshold ||
            (ownerKnown && projected.claimsHeld)
              ? true
              : ownerKnown && usageObserved
                ? false
                : null;
          const continuation = providerStatus(
            provider,
            projectionTime.toISOString(),
            reading,
            hold,
            null,
            configuration.usage,
            0,
            0,
          );
          return {
            ...projected,
            cap,
            counting: "non-ended-runs",
            running,
            free: running === null ? null : Math.max(0, cap - running),
            paused,
            retained,
            claimsHeld,
            pausedRecoveryUsageHeld:
              continuation.claimsHeld || usageObserved
                ? continuation.claimsHeld
                : null,
            launchPermission: "not-established",
            thresholds: {
              ...projected.thresholds,
              effectiveDrainThreshold: ownerKnown
                ? projected.thresholds.effectiveDrainThreshold
                : null,
            },
            pauseAtThreshold:
              projected.pauseAtThreshold || usageObserved
                ? projected.pauseAtThreshold
                : null,
            drained:
              claimsHeld === true && running !== null
                ? running === 0
                : claimsHeld === false
                  ? false
                  : null,
            draining:
              claimsHeld === true && running !== null
                ? running > 0
                : claimsHeld === false
                  ? false
                  : null,
            reason: claimsHeld === null ? "unavailable" : projected.reason,
            nextAction:
              claimsHeld === true
                ? projected.nextAction
                : claimsHeld === null || running === null
                  ? "inspect-observations"
                  : projected.nextAction,
            observations: {
              work: workObservation,
              usage: usageObservation,
              owner: ownerKnown
                ? {
                    ...ownerSource,
                    ...(!storedOwner && {
                      problem: `owner.json: ${ownerFile.observation.problem ?? "missing provider control"}`,
                    }),
                  }
                : unavailable(
                    "owner.json",
                    pending
                      ? "pending operational transaction; host recovery required"
                      : (ownerFile.observation.problem ??
                          "missing or inconsistent provider owner control"),
                  ),
            },
          };
        },
      ),
    ),
  };
}

function withProblem(observation: Observation, problem: string): Observation {
  return {
    ...observation,
    problem: [observation.problem, problem].filter(Boolean).join("; "),
  };
}

export function formatStatus(budget: LaunchBudget): string {
  const value = (entry: unknown) =>
    entry === null ? "unavailable" : JSON.stringify(entry);
  // An available observation's null is a fact of its own; overdue runs are
  // null only while it is unavailable.
  const health = (entry: unknown) =>
    budget.health.overdueRuns === null ? "unavailable" : JSON.stringify(entry);
  return [
    `Observed ${budget.observedAt}; not a launch grant or reservation.`,
    `models=${JSON.stringify(budget.models)}`,
    ...[
      { name: "host", ...budget.capacity.host },
      ...budget.capacity.repositories.map(({ repository, ...counts }) => ({
        name: repository,
        ...counts,
      })),
    ].map(
      ({ name, implement, runKinds }) =>
        `${name}: implement limit=${implement.limit === null ? "unset" : implement.limit} running=${value(implement.running)} free=${implement.limit === null && implement.running !== null ? "unlimited" : value(implement.free)} runKinds=${value(runKinds)}`,
    ),
    `capacity observation=${JSON.stringify(budget.capacity.observation)}`,
    ...budget.coverage.repositories.map(
      ({ repository, configuration, paused }) =>
        `${repository}: configuration=${value(configuration)} paused=${configuration === null ? "unavailable" : paused === null ? "none" : JSON.stringify(paused)}`,
    ),
    `coverage observation=${JSON.stringify(budget.coverage.observation)}`,
    ...budget.health.repositories.map(
      ({ repository, pass, ownerWaits }) =>
        `${repository}: pass=${health(pass)} ownerWaits=${health(ownerWaits)}`,
    ),
    `overdue runs=${budget.health.overdueRuns === null ? "unavailable" : budget.health.overdueRuns.length}`,
    ...(budget.health.overdueRuns ?? []).map(
      ({ repository, issue, ...run }) =>
        `  ${repository}#${issue}: runKind=${run.runKind} phase=${run.phase} startedAt=${run.startedAt} limitAt=${run.limitAt} resultPosted=${run.resultPosted}`,
    ),
    `health observation=${JSON.stringify(budget.health.observation)}`,
    ...budget.providers.flatMap((provider) => [
      `${provider.provider}: cap=${provider.cap} running=${value(provider.running)} free=${value(provider.free)} paused=${value(provider.paused)} retained=${value(provider.retained)}`,
      ...[
        "usage",
        "usageHold",
        "ownerHold",
        "reserve",
        "thresholds",
        "claimsHeld",
        "pausedRecoveryUsageHeld",
        "launchPermission",
        "pauseAtThreshold",
        "drained",
        "draining",
        "reason",
        "nextAction",
        "observations",
      ].map(
        (key) => `  ${key}=${value(provider[key as keyof BudgetProvider])}`,
      ),
    ]),
  ].join("\n");
}
