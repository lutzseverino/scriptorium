import type { AgentProvider } from "@ai-hero/sandcastle";
import {
  completionSignal,
  type LaunchRequest,
  type LaunchResult,
  type Mount,
  type Sandcastle,
} from "../providers.ts";

// Runs one agent through Sandcastle in a Docker sandbox with the host's mounts
// and environment, and the adapter's credential mounts.
export async function launchAgent(
  sandcastle: Sandcastle,
  request: LaunchRequest,
  agent: AgentProvider,
  credentialMounts: Mount[] = [],
): Promise<LaunchResult> {
  const result = await sandcastle.run({
    name: request.name,
    cwd: request.cwd,
    agent,
    sandbox: sandcastle.docker({
      imageName: request.image,
      mounts: [...(request.mounts ?? []), ...credentialMounts],
      ...(request.env && { env: request.env }),
    }),
    prompt: request.prompt,
    branchStrategy: { type: "branch", branch: request.branch },
    logging: { type: "file", path: request.log },
    idleTimeoutSeconds: request.idleTimeoutSeconds,
    signal: request.signal,
    maxIterations: 1,
    completionSignal,
  });
  const session = result.iterations.at(-1);
  return {
    completionSignal: result.completionSignal,
    branch: result.branch,
    preservedWorktreePath: result.preservedWorktreePath,
    sessionId: session?.sessionId,
    sessionFilePath: session?.sessionFilePath,
  };
}
