import assert from "node:assert/strict";
import { test } from "node:test";
import { createRegistry } from "../src/providers.ts";
import { fakePorts } from "./fakes.ts";

const both = {
  "claude-code": { credential: "/etc/factory/claude-token" },
  codex: { credential: "/etc/factory/codex-auth.json" },
};

test("effort comes from the selection, model override, then host", () => {
  const registry = createRegistry(
    both,
    {
      effort: "medium",
      metadata: { "gpt-6.1": { effort: "low", guidance: "Routine work" } },
    },
    fakePorts().ports,
  );
  assert.deepEqual(registry.resolveModel("codex/gpt-6.1"), {
    provider: "codex",
    model: "gpt-6.1",
    effort: "low",
  });
  assert.deepEqual(registry.resolveModel("gpt-6.1@xhigh"), {
    provider: "codex",
    model: "gpt-6.1",
    effort: "xhigh",
  });
  assert.deepEqual(registry.resolveModel("claude-other"), {
    provider: "claude-code",
    model: "claude-other",
    effort: "medium",
  });
});

test("a shadowed host effort is not validated for an overridden model, and later selections still validate", () => {
  const registry = createRegistry(
    both,
    {
      effort: "max",
      metadata: { "gpt-work": { effort: "medium" } },
    },
    fakePorts().ports,
  );
  assert.deepEqual(registry.resolveModel("gpt-work"), {
    provider: "codex",
    model: "gpt-work",
    effort: "medium",
  });
  assert.match(
    (registry.resolveModel("gpt-later") as { error: string }).error,
    /effort "max".*codex/,
  );
  assert.deepEqual(registry.resolveModel("gpt-later@high"), {
    provider: "codex",
    model: "gpt-later",
    effort: "high",
  });
});

test("the catalog contains only configured identities and never restricts an unrestricted provider", () => {
  const registry = createRegistry(
    both,
    {
      effort: "medium",
      default: "claude-default",
      retry: "codex/gpt-retry@high",
      triage: "gpt-triage",
      metadata: { "gpt-metadata-only": { guidance: "Routine work" } },
    },
    fakePorts().ports,
  );
  assert.deepEqual(
    registry.modelFacts.catalog.map((entry) => entry.identity),
    [
      "claude-code/claude-default",
      "codex/gpt-metadata-only",
      "codex/gpt-retry",
      "codex/gpt-triage",
    ],
  );
  assert.deepEqual(registry.resolveModel("gpt-unlisted"), {
    provider: "codex",
    model: "gpt-unlisted",
    effort: "medium",
  });
  assert.equal(registry.modelFacts.catalog.length, 4);
});

test("only the providers the host configuration names are in the registry", () => {
  const { ports } = fakePorts();
  const registry = createRegistry(
    { codex: { credential: "/etc/factory/codex-auth.json" } },
    { effort: "high" },
    ports,
  );
  assert.deepEqual([...registry.providers.keys()], ["codex"]);
  assert.equal(
    registry.providers.get("codex")?.credential,
    "/etc/factory/codex-auth.json",
  );
  assert.deepEqual(
    [...createRegistry(both, { effort: "high" }, ports).providers.keys()],
    ["claude-code", "codex"],
  );
});

test("a host configuration naming a provider without an adapter is refused", () => {
  assert.throws(
    () =>
      createRegistry(
        { ...both, cursor: { credential: "/etc/factory/cursor" } },
        { effort: "high" },
        fakePorts().ports,
      ),
    { message: "provider cursor has no adapter; choose claude-code or codex" },
  );
});

test("each adapter lists its efforts and vendor prefixes", () => {
  const { providers } = createRegistry(
    both,
    { effort: "high" },
    fakePorts().ports,
  );
  const traits = Object.fromEntries(
    [...providers].map(([name, adapter]) => [
      name,
      {
        efforts: adapter.efforts,
        vendorPrefixes: adapter.vendorPrefixes,
      },
    ]),
  );
  assert.deepEqual(traits, {
    "claude-code": {
      efforts: ["low", "medium", "high", "xhigh", "max"],
      vendorPrefixes: ["claude-"],
    },
    codex: {
      efforts: ["low", "medium", "high", "xhigh"],
      vendorPrefixes: ["gpt-"],
    },
  });
});

test("each provider renders the same skill and arguments in its own syntax", () => {
  const { providers } = createRegistry(
    both,
    { effort: "high" },
    fakePorts().ports,
  );
  const configuration = { skill: "ship", arguments: "#96; issue=96" };
  for (const [name, expected] of [
    ["claude-code", "/ship #96; issue=96"],
    ["codex", "$ship #96; issue=96"],
  ])
    assert.equal(
      providers
        .get(name)!
        .renderInvocation(configuration.skill, configuration.arguments),
      expected,
    );
  for (const [name, expected] of [
    ["claude-code", "/ship"],
    ["codex", "$ship"],
  ])
    assert.equal(providers.get(name)!.renderInvocation("ship", ""), expected);
});

test("models route bare slugs by vendor prefix and take an optional effort", () => {
  const registry = createRegistry(both, { effort: "high" }, fakePorts().ports);
  for (const [value, model] of [
    [
      "claude-opus-5-5",
      { provider: "claude-code", model: "claude-opus-5-5", effort: "high" },
    ],
    [
      "claude-opus-5-5@max",
      { provider: "claude-code", model: "claude-opus-5-5", effort: "max" },
    ],
    ["gpt-6.1@low", { provider: "codex", model: "gpt-6.1", effort: "low" }],
    [
      "codex/o5-mini@xhigh",
      { provider: "codex", model: "o5-mini", effort: "xhigh" },
    ],
    // A named provider wins over the slug's vendor prefix.
    [
      "claude-code/gpt-lookalike",
      { provider: "claude-code", model: "gpt-lookalike", effort: "high" },
    ],
  ] as const)
    assert.deepEqual(registry.resolveModel(value), model, value);
});

test("model labels use the same grammar under the given prefix", () => {
  const registry = createRegistry(both, { effort: "high" }, fakePorts().ports);
  assert.deepEqual(registry.resolveModelLabel("model:", "model:gpt-6.1@low"), {
    provider: "codex",
    model: "gpt-6.1",
    effort: "low",
  });
  assert.deepEqual(
    registry.resolveModelLabel("agent/", "agent/claude-code/claude-x"),
    { provider: "claude-code", model: "claude-x", effort: "high" },
  );
  assert.deepEqual(registry.resolveModelLabel("model:", "agent:gpt-6.1"), {
    error: "label agent:gpt-6.1 is not under the prefix model:",
  });
});

test("an unconfigured provider, an unknown effort or an unroutable slug is a stated error", () => {
  const claudeOnly = createRegistry(
    { "claude-code": both["claude-code"] },
    { effort: "high" },
    fakePorts().ports,
  );
  const registry = createRegistry(both, { effort: "high" }, fakePorts().ports);
  for (const [resolved, error] of [
    [
      claudeOnly.resolveModelLabel("model:", "model:codex/gpt-6.1"),
      "provider codex is not configured on this host; choose claude-code",
    ],
    [
      claudeOnly.resolveModelLabel("model:", "model:gpt-6.1"),
      "model gpt-6.1 names no provider; name it model:<provider>/gpt-6.1, choose claude-code",
    ],
    [
      registry.resolveModelLabel("model:", "model:cursor/composer-2"),
      "provider cursor is not configured on this host; choose claude-code or codex",
    ],
    [
      registry.resolveModelLabel("model:", "model:gpt-6.1@max"),
      'effort "max" is not one codex accepts: low, medium, high, xhigh',
    ],
    [
      registry.resolveModel("claude-x@"),
      'effort "" is not one claude-code accepts: low, medium, high, xhigh, max',
    ],
    [
      registry.resolveModelLabel("model:", "model:gemini-3"),
      "model gemini-3 names no provider; name it model:<provider>/gemini-3, choose claude-code or codex",
    ],
    [
      registry.resolveModel("gemini-3@high"),
      "model gemini-3 names no provider; name it <provider>/gemini-3, choose claude-code or codex",
    ],
    [registry.resolveModel("codex/@low"), "model codex/ names no model"],
    [
      createRegistry({}, { effort: "high" }, fakePorts().ports).resolveModel(
        "claude-x",
      ),
      "model claude-x names no provider; name it <provider>/claude-x, this host configures no provider",
    ],
  ] as const)
    assert.deepEqual(resolved, { error });
});

test("an allowed list compares resolved provider and model, preserving effort validation", () => {
  const registry = createRegistry(
    both,
    { effort: "high", allowed: ["gpt-6.1", "claude-code/claude-x"] },
    fakePorts().ports,
  );
  assert.deepEqual(
    registry.resolveModelLabel("model:", "model:codex/gpt-6.1@low"),
    {
      provider: "codex",
      model: "gpt-6.1",
      effort: "low",
    },
  );
  assert.deepEqual(registry.resolveModel("claude-x@max"), {
    provider: "claude-code",
    model: "claude-x",
    effort: "max",
  });
  assert.match(
    (registry.resolveModel("gpt-other") as { error: string }).error,
    /not in models.allowed/,
  );
  assert.match(
    (registry.resolveModel("claude-code/gpt-6.1") as { error: string }).error,
    /not in models.allowed/,
  );
  assert.match(
    (registry.resolveModel("gpt-6.1@max") as { error: string }).error,
    /effort/,
  );
});
