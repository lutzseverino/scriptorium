// Every label role a factory configuration can name, declared once: the
// configuration versions that name it and whether they must, the colour of a
// label only the factory writes, the continuations its label excludes and why,
// and how the factory's transitions write it. Names stay configuration.
// Validation, provisioning, claim reads, exclusions and the contract result's
// freshness derive their role sets from this table.

export type Need = "required" | "optional";

// The ways an issue's next launch continues, as exclusions name them.
export type Continuing = "triage" | "fresh" | "retry" | "merge" | "resume";

// The factory's label writes on an issue. `complete` runs before an issue
// closes and `closed` after, or for an issue found closed.
export type Transition =
  "claim" | "release" | "fail" | "pause" | "unpause" | "complete" | "closed";

type Role = {
  versions: { 2?: Need; 3?: Need };
  // Who applied it decides whether it counts: readiness, or a trigger.
  applied?: true;
  // The readiness label, whose changes the issue-contract validator decides.
  readiness?: true;
  // Only the factory writes it, and provisions it with this colour.
  color?: string;
  // A stop waits on an answer: a run ending in it keeps its work and PR for
  // resumption once the issue is ready again.
  stop?: true;
  // A gate stops review at ready-to-merge until the owner removes it.
  gate?: true;
  // Each exclusion of the listed continuations; across roles, the lowest
  // precedence gives the reason.
  excludes?: Exclusion[];
  // The transitions that add it and that remove it.
  adds?: Transition[];
  removes?: Transition[];
};

type Exclusion = {
  precedence: number;
  from: Continuing[];
  reason(label: string, ready: string): string;
};

const stopped: Exclusion = {
  precedence: 2,
  from: ["fresh", "retry", "merge", "resume"],
  reason: (label, ready) =>
    `labelled ${label}; answer it and return the issue to ${ready} to run it again`,
};

export const labelRoles = {
  triage: {
    versions: { 3: "optional" },
    applied: true,
    stop: true,
    excludes: [stopped],
  },
  reporter: { versions: { 3: "optional" }, stop: true, excludes: [stopped] },
  grill: { versions: { 3: "optional" }, stop: true, excludes: [stopped] },
  owner: { versions: { 3: "optional" }, stop: true, excludes: [stopped] },
  ready: {
    versions: { 2: "required", 3: "required" },
    applied: true,
    readiness: true,
  },
  ownerReview: { versions: { 3: "optional" }, gate: true },
  majorRelease: { versions: { 3: "optional" }, gate: true },
  running: {
    versions: { 2: "required", 3: "required" },
    color: "0052cc",
    excludes: [
      {
        precedence: 3,
        from: ["triage", "fresh"],
        reason: () => "claimed by a running factory run",
      },
    ],
    adds: ["claim", "unpause"],
    removes: ["release", "fail", "pause", "closed"],
  },
  failed: {
    versions: { 2: "required", 3: "required" },
    color: "b60205",
    excludes: [
      {
        precedence: 5,
        from: ["triage", "fresh", "retry"],
        reason: (label) =>
          `labelled ${label}; remove the label to run it again`,
      },
      {
        precedence: 6,
        from: ["merge"],
        reason: (label) => `labelled ${label}`,
      },
    ],
    adds: ["fail"],
    removes: ["complete"],
  },
  paused: {
    versions: { 2: "required", 3: "required" },
    color: "c5def5",
    excludes: [
      {
        precedence: 4,
        from: ["triage", "fresh"],
        reason: (label) =>
          `labelled ${label}; the factory resumes its run by itself`,
      },
    ],
    adds: ["pause"],
    removes: ["release", "fail", "unpause", "closed"],
  },
  needsInput: {
    versions: { 2: "required" },
    color: "fbca04",
    stop: true,
    excludes: [
      {
        ...stopped,
        reason: (label) =>
          `labelled ${label}; answer the question and remove the label to run it again`,
      },
    ],
    removes: ["closed"],
  },
  skip: {
    versions: { 2: "optional", 3: "optional" },
    excludes: [
      {
        precedence: 1,
        from: ["fresh"],
        reason: (label) =>
          `labelled \`${label}\`; delivered outside the factory`,
      },
      {
        precedence: 7,
        from: ["merge"],
        reason: (label) => `labelled ${label}; delivered outside the factory`,
      },
    ],
  },
  releaseHold: { versions: { 2: "optional", 3: "optional" } },
  hold: { versions: { 2: "optional", 3: "optional" } },
  priorityHigh: { versions: { 3: "optional" } },
  priorityNormal: { versions: { 3: "optional" } },
  priorityLow: { versions: { 3: "optional" } },
} satisfies Record<string, Role>;

export type RoleName = keyof typeof labelRoles;

// The roles every version requires, and the configured names of the rest.
export type Labels = Record<"ready" | "running" | "failed" | "paused", string> &
  Partial<Record<RoleName, string>>;

const roles = Object.entries(labelRoles) as [RoleName, Role][];

// The roles a configuration version names, in declaration order.
export function versionRoles(version: 2 | 3): [RoleName, Need][] {
  return roles.flatMap(([name, role]) => {
    const need = role.versions[version];
    return need ? [[name, need]] : [];
  });
}

// The configured names of the roles `select` picks, in declaration order.
export function configured(
  labels: Labels,
  select: (role: Role) => unknown,
): string[] {
  return roles.flatMap(([name, role]) => {
    const label = labels[name];
    return select(role) && label !== undefined ? [label] : [];
  });
}

// The labels only the factory writes, which it provisions with their colours.
export function provisioned(
  labels: Labels,
): { role: RoleName; name: string; color: string }[] {
  return roles.flatMap(([role, { color }]) => {
    const name = labels[role];
    return color && name !== undefined ? [{ role, name, color }] : [];
  });
}

// The label a transition adds, if any, and the labels it removes in order.
export function transition(
  labels: Labels,
  step: Transition,
): { add: string | null; remove: string[] } {
  return {
    add: configured(labels, (role) => role.adds?.includes(step))[0] ?? null,
    remove: configured(labels, (role) => role.removes?.includes(step)),
  };
}

// The labels a claim carries, which the factory clears once its issue closes.
export const claimLabels = (labels: Labels) =>
  transition(labels, "closed").remove;

export const stopLabels = (labels: Labels) =>
  configured(labels, (role) => role.stop);

export const gateLabels = (labels: Labels) =>
  configured(labels, (role) => role.gate);

// Why the issue's labels exclude a continuation, or null when none does.
export function exclusionReason(
  issueLabels: string[],
  labels: Labels,
  continuing: Continuing,
): string | null {
  const excluded = roles
    .flatMap(([name, { excludes = [] }]) => {
      const label = labels[name];
      return label !== undefined && issueLabels.includes(label)
        ? excludes
            .filter(({ from }) => from.includes(continuing))
            .map((exclusion) => ({ ...exclusion, label }))
        : [];
    })
    .sort((left, right) => left.precedence - right.precedence)[0];
  return excluded ? excluded.reason(excluded.label, labels.ready) : null;
}

// Whether the issue's labels hold it in a stop, waiting on an answer.
export const isStopped = (issueLabels: string[], labels: Labels) =>
  stopLabels(labels).some((label) => issueLabels.includes(label));
