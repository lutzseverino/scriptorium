import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { RunOptions } from "@ai-hero/sandcastle";
import type { DockerOptions } from "@ai-hero/sandcastle/sandboxes/docker";
import type { LaunchRequest, ProviderPorts } from "../src/providers.ts";

// A temporary directory removed after the test.
export function directory(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "factory-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

// Ports whose Sandcastle records each launch instead of starting a container.
export function fakePorts(overrides: Partial<ProviderPorts> = {}) {
  const runs: { run: RunOptions; docker: DockerOptions }[] = [];
  let docker: DockerOptions | undefined;
  const ports: ProviderPorts = {
    sandcastle: {
      docker(options) {
        docker = options;
        return { name: "docker" } as unknown as RunOptions["sandbox"];
      },
      async run(options) {
        runs.push({ run: options, docker: docker! });
      },
    },
    fetch: () => {
      throw new Error("this test reads no usage over HTTP");
    },
    codexExecutable: "/nonexistent/codex",
    ...overrides,
  };
  return { ports, runs };
}

export const request: LaunchRequest = {
  model: "unused",
  effort: "high",
  name: "issue-7",
  cwd: "/srv/factory/clones/owner/name",
  image: "factory-owner-name:abc",
  prompt: "/implement #7",
  branch: "factory/issue-7",
  log: "/srv/factory/logs/issue-7.log",
  idleTimeoutSeconds: 3600,
};

// The command line Sandcastle would start the agent with.
export function command(options: RunOptions): string {
  return options.agent.buildPrintCommand({
    prompt: "",
    dangerouslySkipPermissions: true,
  }).command;
}

// A raw log as Sandcastle's file display writes it: the agent's text and tool
// calls, then the failure of an agent that exited with `detail` (which is its
// standard error, its error result, or its last output lines), if it failed.
export function rawRunLog(
  provider: string,
  agent: string[],
  detail?: string[],
): string {
  return [
    "",
    "--- Run started: 2026-10-13T10:40:12.000Z ---",
    "Sandcastle Run",
    "  Name: acme/widgets#371",
    `  Agent: ${provider}`,
    "  Branch: factory/issue-371",
    ...agent,
    ...(detail
      ? [`Agent invocation failed: ${provider} exited with code 1:`, ...detail]
      : ["Run complete: reached 1 iteration(s) without completion signal."]),
    "",
  ].join("\n");
}
