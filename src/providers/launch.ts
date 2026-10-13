import type { AgentProvider } from "@ai-hero/sandcastle";
import type { LaunchRequest, Mount, Sandcastle } from "../providers.ts";

// Runs one agent through Sandcastle in a Docker sandbox with the host's mounts
// and the adapter's credential mounts.
export async function launchAgent(
  sandcastle: Sandcastle,
  request: LaunchRequest,
  agent: AgentProvider,
  credentialMounts: Mount[] = [],
): Promise<void> {
  await sandcastle.run({
    name: request.name,
    cwd: request.cwd,
    agent,
    sandbox: sandcastle.docker({
      imageName: request.image,
      mounts: [...(request.mounts ?? []), ...credentialMounts],
    }),
    prompt: request.prompt,
    branchStrategy: { type: "branch", branch: request.branch },
    logging: { type: "file", path: request.log },
    idleTimeoutSeconds: request.idleTimeoutSeconds,
    signal: request.signal,
  });
}
