// Repository conventions, read from the default branch on every pass.
import { readFileSync } from "node:fs";
import { validateCommentTemplate } from "./comment-template.ts";
import { versionRoles, type Labels } from "./label-roles.ts";

export const runKindNames = ["triage", "implement", "review"] as const;
export type RunKindName = (typeof runKindNames)[number];

// A run kind's skill and arguments; review may ask for a different provider
// than the implement attempt that produced its pull request.
export type RunKind = {
  skill: string;
  arguments: string;
  differentProvider?: boolean;
};

type Common = {
  labels: Labels;
  // Where the repository's issue-contract validator posts its result: the
  // marker of its state line and the account it posts as.
  contractResult: { marker: string; author: string };
  modelLabelPrefix: string;
  comments?: {
    pause?: string;
    failure?: string;
    close?: string;
    awaitingMerge?: string;
  };
};

// Version 2 runs one implement skill; version 3 maps up to three run kinds
// to skills, and may name the factory triage run's result, whose readiness
// counts when it backs the brief the validator approved.
export type FactoryConfiguration =
  | (Common & { version: 2; skill: string; arguments: string })
  | (Common & {
      version: 3;
      runKinds: Partial<Record<RunKindName, RunKind>> & { implement: RunKind };
      triageResult?: { marker: string; author: string };
    });

// The conventions the platform module reads; only version 3 names a triage
// result.
export type PlatformConventions = Pick<
  FactoryConfiguration,
  "labels" | "contractResult" | "comments"
> & { triageResult?: { marker: string; author: string } };

export const factoryConfigurationPath = ".factory/config.json";

// The run kind's skill and arguments, or undefined when it is off.
export function runKind(
  configuration: FactoryConfiguration,
  kind: RunKindName,
): RunKind | undefined {
  if (configuration.version === 3) return configuration.runKinds[kind];
  return kind === "implement"
    ? { skill: configuration.skill, arguments: configuration.arguments }
    : undefined;
}

// The run kind's arguments for one launch. Every `{issue}` expands to the
// issue number and, in version 3, every `{pullRequest}` to its PR's number.
export function launchArguments(
  configuration: FactoryConfiguration,
  kind: RunKindName,
  issue: number,
  pullRequest?: number,
): string | { error: string } {
  const text = runKind(configuration, kind)!.arguments.replaceAll(
    "{issue}",
    String(issue),
  );
  if (configuration.version === 2) return text;
  if (pullRequest !== undefined)
    return text.replaceAll("{pullRequest}", String(pullRequest));
  return text.includes("{pullRequest}")
    ? {
        error: `runKinds.${kind}.arguments names {pullRequest}, and this launch has no pull request`,
      }
    : text;
}

export function readFactoryConfiguration(path: string): FactoryConfiguration {
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `The factory configuration ${path} is unreadable: ${error}`,
      { cause: error },
    );
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`The factory configuration ${path} is not JSON: ${error}`, {
      cause: error,
    });
  }
  const problems: string[] = [];
  const object = (
    value: unknown,
    fields: string[],
    path: string,
    optional: string[] = [],
  ) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      problems.push(`${path || "the configuration"}: is not an object`);
      return null;
    }
    const record = value as Record<string, unknown>;
    for (const name of Object.keys(record))
      if (!fields.includes(name) && !optional.includes(name))
        problems.push(`${path}${name}: is not a factory configuration field`);
    for (const name of fields)
      if (!Object.hasOwn(record, name))
        problems.push(`${path}${name}: is missing`);
    return record;
  };
  const text = (value: unknown, path: string) => {
    if (
      typeof value !== "string" ||
      value.trim() === "" ||
      value.trim() !== value
    )
      problems.push(`${path}: is not a non-empty trimmed string`);
  };
  const pair = (record: Record<string, unknown>, name: string) => {
    if (!Object.hasOwn(record, name)) return;
    const pair = object(record[name], ["marker", "author"], `${name}.`);
    if (pair)
      for (const field of ["marker", "author"])
        if (Object.hasOwn(pair, field)) text(pair[field], `${name}.${field}`);
  };
  // A version other than 3 is checked against version 2's contract.
  const version =
    typeof value === "object" && value?.version === 3 ? 3 : (2 as const);
  const root = object(
    value,
    [
      "version",
      "labels",
      "contractResult",
      "modelLabelPrefix",
      ...(version === 3 ? ["runKinds"] : ["skill", "arguments"]),
    ],
    "",
    ["comments", ...(version === 3 ? ["triageResult"] : [])],
  );
  if (root) {
    if (Object.hasOwn(root, "version") && root.version !== 2 && version !== 3)
      problems.push("version: must be 2 or 3");
    const roles = versionRoles(version);
    const labels = Object.hasOwn(root, "labels")
      ? object(
          root.labels,
          roles.flatMap(([name, need]) => (need === "required" ? [name] : [])),
          "labels.",
          roles.flatMap(([name, need]) => (need === "optional" ? [name] : [])),
        )
      : null;
    if (labels) {
      for (const [name] of roles)
        if (Object.hasOwn(labels, name)) text(labels[name], `labels.${name}`);
      // A label that repeats an earlier one, ignoring case, names both.
      const named = (name: string) =>
        typeof labels[name] === "string" ? labels[name].toLowerCase() : null;
      roles.forEach(([name], index) => {
        const same = roles
          .slice(0, index)
          .find(([earlier]) => named(name) && named(name) === named(earlier));
        if (same)
          problems.push(
            `labels.${name}: must differ from labels.${same[0]}, ignoring case`,
          );
      });
    }
    pair(root, "contractResult");
    if (Object.hasOwn(root, "modelLabelPrefix"))
      text(root.modelLabelPrefix, "modelLabelPrefix");
    if (version === 2) {
      if (Object.hasOwn(root, "skill")) text(root.skill, "skill");
      if (
        Object.hasOwn(root, "arguments") &&
        typeof root.arguments !== "string"
      )
        problems.push("arguments: is not a string");
    } else {
      pair(root, "triageResult");
      const kinds = Object.hasOwn(root, "runKinds")
        ? object(root.runKinds, ["implement"], "runKinds.", [
            "triage",
            "review",
          ])
        : null;
      for (const name of runKindNames) {
        if (!kinds || !Object.hasOwn(kinds, name)) continue;
        const path = `runKinds.${name}`;
        const kind = object(
          kinds[name],
          ["skill", "arguments"],
          `${path}.`,
          name === "review" ? ["differentProvider"] : [],
        );
        if (!kind) continue;
        if (Object.hasOwn(kind, "skill")) text(kind.skill, `${path}.skill`);
        if (Object.hasOwn(kind, "arguments"))
          if (typeof kind.arguments !== "string")
            problems.push(`${path}.arguments: is not a string`);
          else if (name === "triage" && kind.arguments.includes("{pullRequest}"))
            problems.push(
              `${path}.arguments: names {pullRequest}, and a triage run has no pull request`,
            );
        if (
          Object.hasOwn(kind, "differentProvider") &&
          typeof kind.differentProvider !== "boolean"
        )
          problems.push(`${path}.differentProvider: is not a boolean`);
      }
      if (
        kinds &&
        Object.hasOwn(kinds, "triage") &&
        labels &&
        !Object.hasOwn(labels, "triage")
      )
        problems.push("labels.triage: is required with runKinds.triage");
    }
    if (Object.hasOwn(root, "comments")) {
      const comments = object(root.comments, [], "comments.", [
        "pause",
        "failure",
        "close",
        "awaitingMerge",
      ]);
      if (comments)
        for (const name of [
          "pause",
          "failure",
          "close",
          "awaitingMerge",
        ] as const) {
          if (!Object.hasOwn(comments, name)) continue;
          const template = comments[name];
          if (typeof template !== "string" || template.length === 0)
            problems.push(`comments.${name}: is not a non-empty string`);
          else
            try {
              validateCommentTemplate(name, template);
            } catch (error) {
              problems.push(
                `comments.${name}: ${error instanceof Error ? error.message : error}`,
              );
            }
        }
    }
  }
  if (problems.length > 0)
    throw new Error(
      `The factory configuration ${path} is invalid:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
  return value;
}
