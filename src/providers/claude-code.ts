// Claude Code: its credential is the token file `claude setup-token` writes.
import { readFile } from "node:fs/promises";
import { claudeCode } from "@ai-hero/sandcastle";
import type {
  LaunchRequest,
  ProviderAdapter,
  ProviderPorts,
} from "../providers.ts";
import { launchAgent } from "./launch.ts";
import { fullest } from "./usage.ts";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const efforts: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export const usageEndpoint = "https://api.anthropic.com/api/oauth/usage";

export function claudeCodeAdapter(
  credential: string,
  ports: ProviderPorts,
): ProviderAdapter {
  return {
    name: "claude-code",
    credential,
    efforts,
    defaultEffort: "high",
    vendorPrefixes: ["claude-"],
    skillPrefix: "/",
    async launch(request: LaunchRequest) {
      const token = await readToken(credential);
      request.delivered?.(token);
      await launchAgent(
        ports.sandcastle,
        request,
        claudeCode(request.model, {
          effort: request.effort as Effort,
          env: { CLAUDE_CODE_OAUTH_TOKEN: token },
        }),
      );
    },
    // Claude Code publishes no usage read; this one is best-effort.
    async readUsage() {
      const response = await ports.fetch(usageEndpoint, {
        headers: {
          authorization: `Bearer ${await readToken(credential)}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: AbortSignal.timeout(30_000),
      });
      return response.ok ? claudeUsage(await response.json()) : null;
    },
  };
}

// The token as the file holds it now, so a replaced token takes effect at the
// next launch or read.
async function readToken(path: string): Promise<string> {
  const token = (await readFile(path, "utf8")).trim();
  if (token === "")
    throw new Error(`the Claude Code token file ${path} is empty`);
  return token;
}

// The usage endpoint's result.
export function claudeUsage(result: any): number | null {
  return fullest([
    result?.five_hour?.utilization,
    result?.seven_day?.utilization,
  ]);
}
