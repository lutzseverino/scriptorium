// The host configuration: the operator's one JSON file for this host. Every
// field is required, an unknown field is refused, and nothing comes from the
// environment.
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { adapterNames, createRegistry } from "./providers.ts";

export type HostConfiguration = {
  // Each repository the factory serves, as `<owner>/<name>`.
  repositories: string[];
  providers: Record<string, { cap: number; credential: string }>;
  models: { default: string; retry: string };
  timeLimitMinutes: number;
  usageThreshold: number;
  pollSeconds: number;
  readiness: { authorizedRoles: Role[] };
  // Path prefixes the factory's GitHub App can't push, such as
  // `.github/workflows/`.
  unpushablePaths: string[];
  stateDirectory: string;
  gitIdentity: { name: string; email: string };
  // The executable and arguments that print a token for the repository named
  // by the `<owner>/<name>` argument appended to them.
  github: { tokenCommand: string[] };
};

export const roles = ["admin", "maintain", "write", "triage", "read"] as const;
export type Role = (typeof roles)[number];

// Reads and validates the host configuration, or throws naming every problem.
export function readHostConfiguration(path: string): HostConfiguration {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`The host configuration ${path} is unreadable: ${error}`, {
      cause: error,
    });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`The host configuration ${path} is not JSON: ${error}`, {
      cause: error,
    });
  }
  const problems = hostConfigurationProblems(value);
  if (problems.length > 0)
    throw new Error(
      [
        `The host configuration ${path} is invalid:`,
        ...problems.map((problem) => `- ${problem}`),
      ].join("\n"),
    );
  return value;
}

type Check = (value: unknown, path: string, problems: string[]) => void;

function hostConfigurationProblems(value: unknown): string[] {
  const problems: string[] = [];
  object({
    repositories: list(
      text((name) => /^[\w.-]+\/[\w.-]+$/.test(name), "is not <owner>/<name>"),
      { unique: (name) => name.toLowerCase(), nonEmpty: true },
    ),
    providers: record(
      object({
        cap: number(
          (cap) => Number.isSafeInteger(cap) && cap >= 0,
          "is not a whole number of agents",
        ),
        credential: text(isAbsolute, "is not an absolute path"),
      }),
      (name) =>
        adapterNames.includes(name)
          ? null
          : `has no adapter; choose ${adapterNames.join(" or ")}`,
    ),
    models: object({ default: text(), retry: text() }),
    // Both durations become timers, which wait at most 2^31 - 1 milliseconds.
    timeLimitMinutes: number(
      (minutes) => timer(minutes * 60_000),
      "is not a positive number of minutes a timer can wait",
    ),
    usageThreshold: number(
      (percent) => percent >= 0 && percent <= 100,
      "is not a percentage from 0 to 100",
    ),
    pollSeconds: number(
      (seconds) => timer(seconds * 1000),
      "is not a positive number of seconds a timer can wait",
    ),
    readiness: object({
      authorizedRoles: list(
        text(
          (role) => (roles as readonly string[]).includes(role),
          `is not one of ${roles.join(", ")}`,
        ),
        { unique: (role) => role, nonEmpty: true },
      ),
    }),
    unpushablePaths: list(
      text(
        (prefix) => !isAbsolute(prefix) && !prefix.split("/").includes(".."),
        "is not a path inside the repository",
      ),
      { unique: (prefix) => prefix },
    ),
    stateDirectory: text(isAbsolute, "is not an absolute path"),
    gitIdentity: object({ name: text(), email: text() }),
    github: object({ tokenCommand: list(text(), { nonEmpty: true }) }),
  })(value, "", problems);
  if (problems.length === 0) {
    const configuration = value as HostConfiguration;
    const registry = createRegistry(configuration.providers);
    for (const [field, model] of Object.entries(configuration.models)) {
      const resolved = registry.resolveModel(model);
      if ("error" in resolved)
        problems.push(`models.${field}: ${resolved.error}`);
    }
  }
  return problems;
}

function timer(milliseconds: number): boolean {
  return milliseconds > 0 && milliseconds <= 2 ** 31 - 1;
}

function field(path: string, name: string): string {
  return path === "" ? name : `${path}.${name}`;
}

function object(fields: Record<string, Check>): Check {
  return (value, path, problems) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      problems.push(`${path || "the configuration"}: is not an object`);
      return;
    }
    for (const name of Object.keys(value))
      if (!Object.hasOwn(fields, name))
        problems.push(
          `${field(path, name)}: is not a host configuration field`,
        );
    for (const [name, check] of Object.entries(fields))
      if (!Object.hasOwn(value, name))
        problems.push(`${field(path, name)}: is missing`);
      else
        check(
          (value as Record<string, unknown>)[name],
          field(path, name),
          problems,
        );
  };
}

function record(check: Check, key: (name: string) => string | null): Check {
  return (value, path, problems) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      problems.push(`${path}: is not an object`);
      return;
    }
    for (const [name, entry] of Object.entries(value)) {
      const problem = key(name);
      if (problem) problems.push(`${field(path, name)}: ${problem}`);
      else check(entry, field(path, name), problems);
    }
  };
}

function list(
  check: Check,
  {
    unique,
    nonEmpty = false,
  }: { unique?: (item: string) => string; nonEmpty?: boolean },
): Check {
  return (value, path, problems) => {
    if (!Array.isArray(value)) {
      problems.push(`${path}: is not a list`);
      return;
    }
    if (nonEmpty && value.length === 0) problems.push(`${path}: is empty`);
    const seen = new Set<string>();
    value.forEach((item, index) => {
      check(item, `${path}[${index}]`, problems);
      if (unique && typeof item === "string") {
        if (seen.has(unique(item)))
          problems.push(`${path}[${index}]: repeats ${JSON.stringify(item)}`);
        seen.add(unique(item));
      }
    });
  };
}

function text(
  valid: (value: string) => boolean = () => true,
  invalid = "",
): Check {
  return (value, path, problems) => {
    if (typeof value !== "string" || value.trim() === "")
      problems.push(`${path}: is not a non-empty string`);
    else if (!valid(value))
      problems.push(`${path}: ${JSON.stringify(value)} ${invalid}`);
  };
}

function number(valid: (value: number) => boolean, invalid: string): Check {
  return (value, path, problems) => {
    if (typeof value !== "number" || !Number.isFinite(value))
      problems.push(`${path}: is not a number`);
    else if (!valid(value)) problems.push(`${path}: ${value} ${invalid}`);
  };
}
