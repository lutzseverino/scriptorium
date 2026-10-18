// The host configuration: the operator's one JSON file for this host. Every
// field is required unless it is the optional Claude usage credential or has a
// default; unknown fields are refused, and nothing comes from the environment.
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  adapterNames,
  createRegistry,
  type ProviderSettings,
} from "./providers.ts";
import { imageBuilders, type ImageBuilder } from "./sandbox-image.ts";

export type HostConfiguration = {
  // Each repository the factory serves, as `<owner>/<name>`.
  repositories: string[];
  providers: Record<string, ProviderSettings & { cap: number }>;
  models: { default: string; retry: string };
  timeLimitMinutes: number;
  usage: UsagePolicy;
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
  // Where sandbox images build: the daemon's own builder unless the host opts
  // into the factory builder and the pruning of its cache.
  imageBuilder: ImageBuilder;
  imageRetention: ImageRetention;
};

// How many obsolete sandbox image pairs the host keeps beyond every
// repository's current pair and the pairs containers use, and how old the
// factory builder's cache must be before it is pruned, on a host that builds
// there.
export type ImageRetention = {
  obsoletePairs: number;
  cacheMinimumAgeHours: number;
};

// What each provider's usage does to its work: at or above `drainThreshold`
// it claims no new issue, and at or above `pauseThreshold` its running runs
// stop too; either is null when off. `afterDrain` says what reopens claims:
// a reading below the drain threshold, or only the owner's resume request.
export type UsagePolicy = {
  drainThreshold: number | null;
  pauseThreshold: number | null;
  afterDrain: AfterDrain;
};

export const afterDrains = ["auto-resume", "owner-resume"] as const;
export type AfterDrain = (typeof afterDrains)[number];

export const roles = ["admin", "maintain", "write", "triage", "read"] as const;
export type Role = (typeof roles)[number];

// Reads and validates the host configuration, or throws naming every problem.
// A valid configuration that still uses a deprecated form tells `warn`, or
// writes to stderr when no callback is supplied.
export function readHostConfiguration(
  path: string,
  warn: (warning: string) => void = console.warn,
): HostConfiguration {
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
  const problems: string[] = [];
  const warnings: string[] = [];
  const configuration = migrated(value, problems, warnings);
  problems.push(...hostConfigurationProblems(configuration));
  if (problems.length > 0)
    throw new Error(
      [
        `The host configuration ${path} is invalid:`,
        ...problems.map((problem) => `- ${problem}`),
      ].join("\n"),
    );
  for (const warning of warnings)
    warn(`The host configuration ${path}: ${warning}`);
  return withDefaults(configuration as HostConfiguration);
}

type Check = (value: unknown, path: string, problems: string[]) => void;

// For one factory release, the legacy `usageThreshold` is read as
// `usage.drainThreshold`, with a warning; setting both is a problem rather
// than a choice between them.
function migrated(
  value: unknown,
  problems: string[],
  warnings: string[],
): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.hasOwn(value, "usageThreshold")
  )
    return value;
  const { usageThreshold, ...rest } = value as Record<string, unknown>;
  if (Object.hasOwn(rest, "usage")) {
    problems.push(
      "usageThreshold: is the deprecated form of usage.drainThreshold and can't be set with usage; remove it",
    );
    return rest;
  }
  const found = problems.length;
  percentage(usageThreshold, "usageThreshold", problems);
  warnings.push(
    `usageThreshold is deprecated and read as usage.drainThreshold for this factory release; replace it with "usage": { "drainThreshold": ${usageThreshold} }`,
  );
  // An invalid legacy value is named once, as itself.
  return {
    ...rest,
    usage: {
      drainThreshold: problems.length === found ? usageThreshold : null,
    },
  };
}

function withDefaults(configuration: HostConfiguration): HostConfiguration {
  const usage: Partial<UsagePolicy> = configuration.usage;
  const retention: Partial<ImageRetention> = configuration.imageRetention ?? {};
  return {
    ...configuration,
    usage: {
      drainThreshold: usage.drainThreshold!,
      pauseThreshold: usage.pauseThreshold ?? null,
      afterDrain: usage.afterDrain ?? "auto-resume",
    },
    imageBuilder: configuration.imageBuilder ?? "daemon",
    imageRetention: {
      obsoletePairs: retention.obsoletePairs ?? 3,
      cacheMinimumAgeHours: retention.cacheMinimumAgeHours ?? 24,
    },
  };
}

function hostConfigurationProblems(value: unknown): string[] {
  const problems: string[] = [];
  object(
    {
      repositories: list(
        text(
          (name) => /^[\w.-]+\/[\w.-]+$/.test(name),
          "is not <owner>/<name>",
        ),
        { unique: (name) => name.toLowerCase(), nonEmpty: true },
      ),
      providers: record(
        (entry, path, problems, name) =>
          object(
            {
              cap: number(
                (cap) => Number.isSafeInteger(cap) && cap >= 0,
                "is not a whole number of agents",
              ),
              credential: text(isAbsolute, "is not an absolute path"),
              ...(name === "claude-code" && {
                usageCredential: text(isAbsolute, "is not an absolute path"),
              }),
            },
            ["usageCredential"],
          )(entry, path, problems),
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
      usage: object(
        {
          drainThreshold: nullable(percentage),
          pauseThreshold: nullable(percentage),
          afterDrain: text(
            (choice) => (afterDrains as readonly string[]).includes(choice),
            `is not one of ${afterDrains.join(", ")}`,
          ),
        },
        ["pauseThreshold", "afterDrain"],
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
      imageBuilder: text(
        (builder) => (imageBuilders as readonly string[]).includes(builder),
        `is not one of ${imageBuilders.join(", ")}`,
      ),
      imageRetention: object(
        {
          obsoletePairs: number(
            (pairs) => Number.isSafeInteger(pairs) && pairs >= 0,
            "is not a whole number of image pairs",
          ),
          cacheMinimumAgeHours: number(
            (hours) => Number.isSafeInteger(hours) && hours > 0,
            "is not a positive whole number of hours",
          ),
        },
        ["obsoletePairs", "cacheMinimumAgeHours"],
      ),
    },
    ["imageBuilder", "imageRetention"],
  )(value, "", problems);
  const usage = (value as { usage?: Partial<UsagePolicy> } | null)?.usage;
  const { drainThreshold: drain, pauseThreshold: pause } = usage ?? {};
  if (
    [drain, pause].every((percent) => valid(percentage, percent)) &&
    pause! < drain!
  )
    problems.push(
      `usage.pauseThreshold: ${pause} is below usage.drainThreshold, ${drain}`,
    );
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

const percentage = number(
  (percent) => percent >= 0 && percent <= 100,
  "is not a percentage from 0 to 100",
);

function valid(check: Check, value: unknown): boolean {
  const problems: string[] = [];
  check(value, "", problems);
  return problems.length === 0;
}

function timer(milliseconds: number): boolean {
  return milliseconds > 0 && milliseconds <= 2 ** 31 - 1;
}

function field(path: string, name: string): string {
  return path === "" ? name : `${path}.${name}`;
}

function object(fields: Record<string, Check>, optional: string[] = []): Check {
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
      if (!Object.hasOwn(value, name)) {
        if (!optional.includes(name))
          problems.push(`${field(path, name)}: is missing`);
      } else
        check(
          (value as Record<string, unknown>)[name],
          field(path, name),
          problems,
        );
  };
}

function record(
  check: (
    value: unknown,
    path: string,
    problems: string[],
    name: string,
  ) => void,
  key: (name: string) => string | null,
): Check {
  return (value, path, problems) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      problems.push(`${path}: is not an object`);
      return;
    }
    for (const [name, entry] of Object.entries(value)) {
      const problem = key(name);
      if (problem) problems.push(`${field(path, name)}: ${problem}`);
      else check(entry, field(path, name), problems, name);
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

function nullable(check: Check): Check {
  return (value, path, problems) => {
    if (value !== null) check(value, path, problems);
  };
}

function number(valid: (value: number) => boolean, invalid: string): Check {
  return (value, path, problems) => {
    if (typeof value !== "number" || !Number.isFinite(value))
      problems.push(`${path}: is not a number`);
    else if (!valid(value)) problems.push(`${path}: ${value} ${invalid}`);
  };
}
