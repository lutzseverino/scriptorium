// Claude Code: its credential is the token file `claude setup-token` writes.
import { readFile } from "node:fs/promises";
import { claudeCode } from "@ai-hero/sandcastle";
import type {
  LaunchRequest,
  ProviderAdapter,
  ProviderPorts,
} from "../providers.ts";
import { launchAgent } from "./launch.ts";
import { limitError } from "./limit.ts";
import { fullest, UsageReadError } from "./usage.ts";

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
    // Claude Code publishes no usage read; this one is best-effort. A refusal
    // names its status and passes on its `Retry-After`, never its body.
    async readUsage() {
      const response = await ports.fetch(usageEndpoint, {
        headers: {
          authorization: `Bearer ${await readToken(credential)}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new UsageReadError(
          `the usage endpoint answered HTTP ${response.status}`,
          {
            status: response.status,
            retryAfter: response.headers.get("retry-after") ?? undefined,
          },
        );
      }
      let result;
      try {
        result = await response.json();
      } catch {
        // A parse error quotes the answer, so its message stays out.
        throw new UsageReadError("the usage endpoint's answer is not JSON", {
          status: response.status,
        });
      }
      return claudeUsage(result);
    },
    usageLimit: (log) => limitError(log, claudeLimitErrors),
  };
}

// Claude Code's session, weekly and usage limit errors, each on a line of its
// own, such as `You've hit your session limit · resets 12:50pm (UTC)` or the
// older `Claude AI usage limit reached|1760000000`, whose reset is no wording.
const resets = String.raw`(?:\s*[·∙•]\s*resets\s+(?<reset>.+))?`;
const claudeLimitErrors = [
  /^Claude usage limit reached\. Your limit will reset at (?<reset>.+?)\.?$/i,
  new RegExp(
    String.raw`^You['’]ve (?:hit|reached) your (?:(?:(?:Opus|Sonnet) )?weekly |session |usage )?limit\b${resets}`,
    "i",
  ),
  new RegExp(
    String.raw`^(?:Claude (?:AI )?usage|(?:(?:Opus|Sonnet) )?weekly|session|usage|5-hour) limit reached\b${resets}`,
    "i",
  ),
];

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
