import assert from "node:assert/strict";
import { test } from "node:test";
import { createRegistry } from "../src/providers.ts";
import { fakePorts } from "./fakes.ts";

const both = {
  "claude-code": { credential: "/etc/factory/claude-token" },
  codex: { credential: "/etc/factory/codex-auth.json" },
};

test("only the providers the host configuration names are in the registry", () => {
  const { ports } = fakePorts();
  const registry = createRegistry(
    { codex: { credential: "/etc/factory/codex-auth.json" } },
    ports,
  );
  assert.deepEqual([...registry.providers.keys()], ["codex"]);
  assert.equal(
    registry.providers.get("codex")?.credential,
    "/etc/factory/codex-auth.json",
  );
  assert.deepEqual(
    [...createRegistry(both, ports).providers.keys()],
    ["claude-code", "codex"],
  );
});

test("a host configuration naming a provider without an adapter is refused", () => {
  assert.throws(
    () =>
      createRegistry(
        { ...both, cursor: { credential: "/etc/factory/cursor" } },
        fakePorts().ports,
      ),
    { message: "provider cursor has no adapter; choose claude-code or codex" },
  );
});

test("each adapter lists its efforts, vendor prefixes and skill prefix", () => {
  const { providers } = createRegistry(both, fakePorts().ports);
  const traits = Object.fromEntries(
    [...providers].map(([name, adapter]) => [
      name,
      {
        efforts: adapter.efforts,
        defaultEffort: adapter.defaultEffort,
        vendorPrefixes: adapter.vendorPrefixes,
        skillPrefix: adapter.skillPrefix,
      },
    ]),
  );
  assert.deepEqual(traits, {
    "claude-code": {
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      vendorPrefixes: ["claude-"],
      skillPrefix: "/",
    },
    codex: {
      efforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "high",
      vendorPrefixes: ["gpt-"],
      skillPrefix: "$",
    },
  });
});

test("models route bare slugs by vendor prefix and take an optional effort", () => {
  const registry = createRegistry(both, fakePorts().ports);
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
  const registry = createRegistry(both, fakePorts().ports);
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
    fakePorts().ports,
  );
  const registry = createRegistry(both, fakePorts().ports);
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
      createRegistry({}, fakePorts().ports).resolveModel("claude-x"),
      "model claude-x names no provider; name it <provider>/claude-x, this host configures no provider",
    ],
  ] as const)
    assert.deepEqual(resolved, { error });
});
