// The repository conventions the factory follows. Every repository shares
// them for now; each repository's factory configuration will name its own.
export const labels = {
  ready: "ready-for-agent",
  running: "factory:running",
  failed: "factory:failed",
  needsInput: "factory:needs-input",
};

export const modelLabelPrefix = "model:";

// The prompt a run starts with, given its provider's skill prefix.
export function invocation(skillPrefix: string, issue: number): string {
  return `${skillPrefix}implement #${issue}`;
}
