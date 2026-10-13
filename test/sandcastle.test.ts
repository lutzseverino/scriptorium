import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeCode, codex } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

test("the pinned Sandcastle dependency constructs agents and a sandbox without launching them", () => {
  assert.equal(claudeCode("claude-sonnet-4-6").name, "claude-code");
  assert.equal(codex("gpt-6.1-sol").name, "codex");
  assert.equal(docker({ imageName: "factory-smoke-test" }).name, "docker");
});
