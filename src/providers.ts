// The provider registry: each provider is one adapter behind the seam below,
// and only the providers the host configuration names are in the registry.
import { run, type RunOptions } from "@ai-hero/sandcastle";
import {
  docker,
  type DockerOptions,
} from "@ai-hero/sandcastle/sandboxes/docker";
import { claudeCodeAdapter } from "./providers/claude-code.ts";
import { codexAdapter } from "./providers/codex.ts";

export type Mount = NonNullable<DockerOptions["mounts"]>[number];

// The part of Sandcastle an adapter launches its agent through.
export type Sandcastle = {
  run(options: RunOptions): Promise<unknown>;
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

export type ProviderAdapter = {
  readonly name: string;
  // The host file holding the provider's one credential.
  readonly credential: string;
  // The reasoning efforts the agent CLI accepts, and the one a model without
  // `@<effort>` runs at.
  readonly efforts: readonly string[];
  readonly defaultEffort: string;
  // A bare model slug with one of these prefixes runs on this provider.
  readonly vendorPrefixes: readonly string[];
  // The prompt's `{skillPrefix}`: how the agent CLI invokes a skill.
  readonly skillPrefix: string;
  // Runs the agent through Sandcastle, delivering the credential as it stands
  // at this launch.
  launch(request: LaunchRequest): Promise<void>;
  // The fullest usage window's percentage, or null when the provider's answer
  // holds no usage window. A read that failed throws, a provider's refusal as
  // a `UsageReadError`.
  readUsage(): Promise<number | null>;
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
  (credential: string, ports: ProviderPorts) => ProviderAdapter
> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
};

// The providers a host configuration can name.
export const adapterNames = Object.keys(adapters);

// The host configuration's `providers.<name>`, as far as the registry reads it.
export type ProviderSettings = { credential: string };

export type Model = { provider: string; model: string; effort: string };

export type Registry = {
  readonly providers: ReadonlyMap<string, ProviderAdapter>;
  // A host configuration model: `<slug>` or `<provider>/<slug>`, optionally
  // followed by `@<effort>`.
  resolveModel(value: string): Model | { error: string };
  // A model label: the same grammar under the repository's model label prefix.
  resolveModelLabel(prefix: string, label: string): Model | { error: string };
};

export function createRegistry(
  configured: Record<string, ProviderSettings>,
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
    Object.entries(configured).map(([name, { credential }]) => [
      name,
      adapters[name](credential, ports),
    ]),
  );
  const configuredNames = [...providers.keys()];

  function resolve(hint: string, value: string): Model | { error: string } {
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
    const effort = at === -1 ? adapter.defaultEffort : value.slice(at + 1);
    if (!adapter.efforts.includes(effort))
      return {
        error: `effort ${JSON.stringify(effort)} is not one ${provider} accepts: ${adapter.efforts.join(", ")}`,
      };
    return { provider, model, effort };
  }

  return {
    providers,
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
