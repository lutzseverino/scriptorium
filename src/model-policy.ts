// The optional repository-owned model policy: per-kind model preferences and
// what happens when a preferred model is unavailable. It names preferences
// only; the host's capabilities and defaults bound every choice, and the
// decision core resolves them.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const modelPolicyPath = ".scriptorium/model-policy.json";
// The policy's previous path, read for one configuration version when the
// new path is absent.
export const legacyModelPolicyPath = ".github/factory-model-policy.json";
export type ModelPolicyPath =
  typeof modelPolicyPath | typeof legacyModelPolicyPath;
export const modelPolicyPaths: readonly ModelPolicyPath[] = [
  modelPolicyPath,
  legacyModelPolicyPath,
];

// A named model, or the issue's own model label.
export type Selection =
  | { provider: string; model: string; effort?: string }
  | { source: "issue-label" };

export type ModelPolicy = {
  version: 1;
  fallback: "wait" | "host-default";
  runKinds: {
    triage?: Selection;
    implement?: { initial?: Selection; retry?: Selection };
    review?: Selection;
  };
};

// The policy in the repository checkout at `root` and the path it came
// from, or null when the repository has none. A present file that is
// unreadable or invalid throws, naming every problem: it never reads as
// absence. Both paths present throws too, rather than choosing one.
export function readModelPolicy(
  root: string,
): { path: ModelPolicyPath; policy: ModelPolicy } | null {
  const [current, legacy] = modelPolicyPaths.map((path) => {
    try {
      return { path, source: readFileSync(join(root, path), "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return { path, error };
    }
  });
  if (current && legacy)
    throw new Error(
      `The model policy is at both ${modelPolicyPath} and ${legacyModelPolicyPath}, and the factory does not choose between them: keep one policy, at ${modelPolicyPath}`,
    );
  const read = current ?? legacy;
  if (!read) return null;
  if ("error" in read)
    throw new Error(
      `The model policy ${read.path} is unreadable: ${read.error}`,
      { cause: read.error },
    );
  return { path: read.path, policy: parseModelPolicy(read.path, read.source) };
}

function parseModelPolicy(file: ModelPolicyPath, source: string): ModelPolicy {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`The model policy ${file} is not JSON: ${error}`, {
      cause: error,
    });
  }
  const problems: string[] = [];
  const object = (
    value: unknown,
    path: string,
    fields: string[],
    optional: string[] = [],
  ) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      problems.push(`${path || "the policy"}: is not an object`);
      return null;
    }
    const record = value as Record<string, unknown>;
    for (const name of Object.keys(record))
      if (!fields.includes(name) && !optional.includes(name))
        problems.push(`${path}${name}: is not a model policy field`);
    for (const name of fields)
      if (!Object.hasOwn(record, name))
        problems.push(`${path}${name}: is missing`);
    return record;
  };
  const selection = (value: unknown, path: string) => {
    if (
      typeof value === "object" &&
      value !== null &&
      Object.hasOwn(value, "source")
    ) {
      const record = object(value, `${path}.`, ["source"]);
      if (record && record.source !== "issue-label")
        problems.push(`${path}.source: must be "issue-label"`);
      return;
    }
    const record = object(value, `${path}.`, ["provider", "model"], ["effort"]);
    if (record)
      for (const name of ["provider", "model", "effort"])
        if (
          Object.hasOwn(record, name) &&
          (typeof record[name] !== "string" ||
            record[name] === "" ||
            record[name].trim() !== record[name])
        )
          problems.push(`${path}.${name}: is not a non-empty trimmed string`);
  };
  const root = object(value, "", ["version", "fallback", "runKinds"]);
  if (root) {
    if (Object.hasOwn(root, "version") && root.version !== 1)
      problems.push("version: must be 1");
    if (
      Object.hasOwn(root, "fallback") &&
      root.fallback !== "wait" &&
      root.fallback !== "host-default"
    )
      problems.push('fallback: must be "wait" or "host-default"');
    const kinds = Object.hasOwn(root, "runKinds")
      ? object(
          root.runKinds,
          "runKinds.",
          [],
          ["triage", "implement", "review"],
        )
      : null;
    if (kinds) {
      for (const name of ["triage", "review"])
        if (Object.hasOwn(kinds, name))
          selection(kinds[name], `runKinds.${name}`);
      if (Object.hasOwn(kinds, "implement")) {
        const implement = object(
          kinds.implement,
          "runKinds.implement.",
          [],
          ["initial", "retry"],
        );
        if (implement)
          for (const name of ["initial", "retry"])
            if (Object.hasOwn(implement, name))
              selection(implement[name], `runKinds.implement.${name}`);
      }
    }
  }
  if (problems.length > 0)
    throw new Error(
      `The model policy ${file} is invalid:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
  return value;
}
