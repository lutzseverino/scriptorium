// The provider registry: each provider is one adapter behind the seam below,
// and only the providers the host configuration names are in the registry.
import { run, type RunOptions, type RunResult } from "@ai-hero/sandcastle";
import {
  docker,
  type DockerOptions,
} from "@ai-hero/sandcastle/sandboxes/docker";
import { claudeCodeAdapter } from "./providers/claude-code.ts";
import { codexAdapter } from "./providers/codex.ts";
import type { UsageWindow } from "./providers/usage.ts";

export type Mount = NonNullable<DockerOptions["mounts"]>[number];

// The part of Sandcastle an adapter launches its agent through.
export type Sandcastle = {
  run(options: RunOptions): Promise<RunResult>;
  docker(options: DockerOptions): RunOptions["sandbox"];
};

// One agent run in a sandbox built from `image`. The host adds its own
// `mounts` and `env`; the adapter adds its credential, and tells `delivered`
// each secret value of it before the agent starts.
export type LaunchRequest = {
  model: string;
  effort: string;
  name: string;
  cwd: string;
  image: string;
  prompt: string;
  branch: string;
  log: string;
  idleTimeoutSeconds: number;
  mounts?: Mount[];
  env?: Record<string, string>;
  signal?: AbortSignal;
  delivered?: (secret: string) => void;
};

// Only recovery identities cross into the host record; raw output and
// provider-owned resume closures stay in Sandcastle.
export type LaunchResult = Pick<
  RunResult,
  "completionSignal" | "branch" | "preservedWorktreePath"
> & { sessionId?: string; sessionFilePath?: string };

export const completionSignal = "<promise>COMPLETE</promise>";

export type ProviderAdapter = {
  readonly name: string;
  // The host file holding the provider's launch credential.
  readonly credential: string;
  // The reasoning efforts the agent CLI accepts. Values come from the host.
  readonly efforts: readonly string[];
  // A bare model slug with one of these prefixes runs on this provider.
  readonly vendorPrefixes: readonly string[];
  // Renders a skill invocation in this agent CLI's syntax.
  renderInvocation(skill: string, args: string): string;
  // Runs the agent through Sandcastle, delivering the credential as it stands
  // at this launch.
  launch(request: LaunchRequest): Promise<LaunchResult>;
  // The fullest usage window's percentage and reset, or null when the
  // provider's answer holds no usage window. A read that failed throws, a
  // provider's refusal as a `UsageReadError`.
  readUsage(): Promise<UsageWindow | null>;
  // Whether an ended run's raw log ends with the provider's own usage-limit
  // error, judged from that error's wording, never the model's prose.
  usageLimit(log: string): UsageLimit | null;
};

// A provider's usage limit as its error stated it: the reset as written, such
// as `12:50pm (UTC)`, or null when the error states none.
export type UsageLimit = { reset: string | null };

export type ProviderPorts = {
  sandcastle: Sandcastle;
  fetch: typeof fetch;
  // The host's Codex CLI, which the Codex usage reader starts.
  codexExecutable: string;
};

export const defaultPorts: ProviderPorts = {
  sandcastle: { run, docker },
  fetch: (...args) => globalThis.fetch(...args),
  codexExecutable: "codex",
};

const adapters: Record<
  string,
  (
    credential: string,
    ports: ProviderPorts,
    usageCredential?: string,
  ) => ProviderAdapter
> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
};

// The providers a host configuration can name.
export const adapterNames = Object.keys(adapters);

// The host configuration's `providers.<name>`, as far as the registry reads it.
export type ProviderSettings = { credential: string; usageCredential?: string };

export type Model = { provider: string; model: string; effort: string };

export type ModelMetadata = { guidance?: string; effort?: string };
export type ModelSettings = {
  effort: string;
  default?: string;
  retry?: string;
  triage?: string;
  review?: string;
  allowed?: readonly string[];
  metadata?: Record<string, ModelMetadata>;
};

// The finite configured catalog, not a provider's discoverable model inventory.
// Defaults include their selection's explicit effort, if any; catalog effort
// is what a selection omitting @effort would use.
export type ModelFacts = {
  effort: string;
  defaults: Partial<Record<"default" | "retry" | "triage" | "review", Model>>;
  catalog: (Omit<Model, "effort"> &
    ModelMetadata & {
      identity: string;
      effectiveEffort: string;
    })[];
};

export type Registry = {
  readonly providers: ReadonlyMap<string, ProviderAdapter>;
  readonly modelFacts: ModelFacts;
  // A host configuration model: `<slug>` or `<provider>/<slug>`, optionally
  // followed by `@<effort>`.
  resolveModel(value: string): Model | { error: string };
  // A model label: the same grammar under the repository's model label prefix.
  resolveModelLabel(prefix: string, label: string): Model | { error: string };
};

export function createRegistry(
  configured: Record<string, ProviderSettings>,
  settings: ModelSettings,
  ports: ProviderPorts = defaultPorts,
): Registry {
  const unknown = Object.keys(configured).filter(
    (name) => !Object.hasOwn(adapters, name),
  );
  if (unknown.length > 0)
    throw new Error(
      unknown
        .map(
          (name) =>
            `provider ${name} has no adapter; ${choose(Object.keys(adapters))}`,
        )
        .join("\n"),
    );
  const providers = new Map(
    Object.entries(configured).map(
      ([name, { credential, usageCredential }]) => [
        name,
        adapters[name](credential, ports, usageCredential),
      ],
    ),
  );
  const configuredNames = [...providers.keys()];

  function route(
    hint: string,
    value: string,
  ): Omit<Model, "effort"> | { error: string } {
    const at = value.lastIndexOf("@");
    const name = at === -1 ? value : value.slice(0, at);
    const slash = name.indexOf("/");
    let provider: string;
    let model: string;
    if (slash === -1) {
      model = name;
      const route = [...providers.values()].find((adapter) =>
        adapter.vendorPrefixes.some((prefix) => name.startsWith(prefix)),
      );
      if (!route)
        return {
          error: `model ${name} names no provider; name it ${hint}<provider>/${name}, ${choose(configuredNames)}`,
        };
      provider = route.name;
    } else {
      provider = name.slice(0, slash);
      model = name.slice(slash + 1);
    }
    const adapter = providers.get(provider);
    if (!adapter)
      return {
        error: `provider ${provider} is not configured on this host; ${choose(configuredNames)}`,
      };
    if (model === "") return { error: `model ${name} names no model` };
    return { provider, model };
  }

  const identityOf = (model: Omit<Model, "effort">) =>
    `${model.provider}/${model.model}`;
  const problems: string[] = [];
  const catalog = new Map<string, Omit<Model, "effort">>();
  const listed = settings.allowed && new Set<string>();
  settings.allowed?.forEach((value, index) => {
    const path = `models.allowed[${index}]`;
    const model = route("", value);
    if (value.includes("@"))
      problems.push(`${path}: must not specify an effort`);
    else if ("error" in model) problems.push(`${path}: ${model.error}`);
    else {
      const identity = identityOf(model);
      if (listed!.has(identity)) problems.push(`${path}: repeats ${identity}`);
      listed!.add(identity);
      catalog.set(identity, model);
    }
  });
  function permitted(
    hint: string,
    value: string,
  ): Omit<Model, "effort"> | { error: string } {
    const model = route(hint, value);
    if ("error" in model) return model;
    const identity = identityOf(model);
    return listed && !listed.has(identity)
      ? {
          error: `model ${identity} is not in models.allowed; ask the host operator to update the list or choose a listed model`,
        }
      : model;
  }

  const metadata = new Map<string, ModelMetadata>();
  for (const [value, entry] of Object.entries(settings.metadata ?? {})) {
    const path = `models.metadata.${value}`;
    const model = permitted("", value);
    if (value.includes("@"))
      problems.push(`${path}: must not specify an effort in the identity`);
    else if ("error" in model) problems.push(`${path}: ${model.error}`);
    else {
      const identity = identityOf(model);
      const previous = metadata.get(identity);
      if (
        previous &&
        (previous.effort !== entry.effort ||
          previous.guidance !== entry.guidance)
      )
        problems.push(`${path}: conflicts with metadata for ${identity}`);
      else {
        metadata.set(identity, entry);
        catalog.set(identity, model);
      }
      if (entry.effort !== undefined) {
        const error = effortProblem(model.provider, entry.effort);
        if (error) problems.push(`${path}.effort: ${error}`);
      }
    }
  }

  function effortProblem(provider: string, effort: string): string | null {
    const efforts = providers.get(provider)!.efforts;
    return efforts.includes(effort)
      ? null
      : `effort ${JSON.stringify(effort)} is not one ${provider} accepts: ${efforts.join(", ")}`;
  }

  function resolve(hint: string, value: string): Model | { error: string } {
    const model = permitted(hint, value);
    if ("error" in model) return model;
    const at = value.lastIndexOf("@");
    const effort =
      at === -1
        ? (metadata.get(identityOf(model))?.effort ?? settings.effort)
        : value.slice(at + 1);
    const error = effortProblem(model.provider, effort);
    return error ? { error } : { ...model, effort };
  }

  const defaults: ModelFacts["defaults"] = {};
  for (const field of ["default", "retry", "triage", "review"] as const) {
    const value = settings[field];
    if (value === undefined) continue;
    const model = permitted("", value);
    if (!("error" in model)) catalog.set(identityOf(model), model);
    const resolved = resolve("", value);
    if ("error" in resolved)
      problems.push(`models.${field}: ${resolved.error}`);
    else defaults[field] = resolved;
  }
  if (defaults.default) {
    if (settings.triage === undefined) defaults.triage = defaults.default;
    if (settings.review === undefined) defaults.review = defaults.default;
  }
  const entries = [...catalog]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([identity, model]) => {
      const entry = metadata.get(identity);
      const effectiveEffort = entry?.effort ?? settings.effort;
      const error = effortProblem(model.provider, effectiveEffort);
      if (error && entry?.effort === undefined)
        problems.push(`models.effort (effective for ${identity}): ${error}`);
      return { identity, ...model, ...entry, effectiveEffort };
    });
  // Even a provider with no named catalog models needs an effective host
  // effort. Future selections are validated again at resolution time.
  for (const provider of configuredNames) {
    if (entries.some((entry) => entry.provider === provider)) continue;
    const error = effortProblem(provider, settings.effort);
    if (error) problems.push(`models.effort (provider ${provider}): ${error}`);
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));

  return {
    providers,
    modelFacts: { effort: settings.effort, defaults, catalog: entries },
    resolveModel: (value) => resolve("", value),
    resolveModelLabel(prefix, label) {
      if (!label.startsWith(prefix))
        return { error: `label ${label} is not under the prefix ${prefix}` };
      return resolve(prefix, label.slice(prefix.length));
    },
  };
}

function choose(names: string[]): string {
  return names.length === 0
    ? "this host configures no provider"
    : `choose ${names.join(" or ")}`;
}
