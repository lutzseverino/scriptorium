// Repository conventions, read from the default branch on every pass.
import { readFileSync } from "node:fs";

export type FactoryConfiguration = {
  version: 1;
  labels: {
    ready: string;
    running: string;
    failed: string;
    needsInput: string;
  };
  modelLabelPrefix: string;
  prompt: string;
};

export const factoryConfigurationPath = ".factory/config.json";

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
  const object = (value: unknown, fields: string[], path: string) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      problems.push(`${path || "the configuration"}: is not an object`);
      return null;
    }
    const record = value as Record<string, unknown>;
    for (const name of Object.keys(record))
      if (!fields.includes(name))
        problems.push(`${path}${name}: is not a factory configuration field`);
    for (const name of fields)
      if (!Object.hasOwn(record, name))
        problems.push(`${path}${name}: is missing`);
    return record;
  };
  const root = object(
    value,
    ["version", "labels", "modelLabelPrefix", "prompt"],
    "",
  );
  const text = (value: unknown, path: string) => {
    if (
      typeof value !== "string" ||
      value.trim() === "" ||
      value.trim() !== value
    )
      problems.push(`${path}: is not a non-empty trimmed string`);
  };
  if (root) {
    if (Object.hasOwn(root, "version") && root.version !== 1)
      problems.push("version: must be 1");
    if (Object.hasOwn(root, "labels")) {
      const fields = ["ready", "running", "failed", "needsInput"];
      const labels = object(root.labels, fields, "labels.");
      if (labels)
        for (const name of fields)
          if (Object.hasOwn(labels, name)) text(labels[name], `labels.${name}`);
      if (
        labels &&
        fields.every((name) => typeof labels[name] === "string") &&
        new Set(fields.map((name) => (labels[name] as string).toLowerCase()))
          .size !== fields.length
      )
        problems.push("labels: must name four distinct labels");
    }
    if (Object.hasOwn(root, "modelLabelPrefix"))
      text(root.modelLabelPrefix, "modelLabelPrefix");
    if (
      Object.hasOwn(root, "prompt") &&
      (typeof root.prompt !== "string" ||
        !root.prompt.includes("{skillPrefix}") ||
        !root.prompt.includes("{issue}"))
    )
      problems.push("prompt: must contain {skillPrefix} and {issue}");
  }
  if (problems.length > 0)
    throw new Error(
      `The factory configuration ${path} is invalid:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
  return value;
}
