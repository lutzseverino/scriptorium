import type { UsageLimit } from "../providers.ts";

// How many of a raw log's last non-empty lines may hold the provider's limit
// error: Sandcastle's failure line, the error's detail, and its own wrap-up.
const endLines = 30;

// The provider's limit error at the end of an ended run's raw log: the last
// of its final lines that one of the provider's patterns matches. A pattern's
// `reset` group is the reset as the error states it.
export function limitError(
  log: string,
  patterns: readonly RegExp[],
): UsageLimit | null {
  const lines = log
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-endLines)
    .reverse();
  for (const line of lines)
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (match) return { reset: match.groups?.reset?.trim() || null };
    }
  return null;
}
