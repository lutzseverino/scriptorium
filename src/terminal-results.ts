// The supported process interface keeps private publication formats with
// Scriptorium. Callers transport tracker facts and compare opaque identities.
import { resultMarker, type TerminalResult } from "./run-result.ts";
import { runCommentResults } from "./run-comment.ts";

export const terminalResultsUsage =
  "node src/main.ts results --author <trusted publishing account>";

type Ports = {
  read(): string;
  print(line: string): void;
  error(line: string): void;
};

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const login = (value: string) =>
  value.toLowerCase().replace(/^app\/(.+)$/, "$1[bot]");

function terminal(value: unknown): TerminalResult {
  const entry = object(value);
  if (
    !entry ||
    typeof entry.run !== "string" ||
    entry.run.trim() === "" ||
    typeof entry.outcome !== "string" ||
    !["done", "stop", "failed"].includes(entry.outcome)
  )
    throw new Error("Invalid published terminal result data");
  return {
    run: entry.run,
    outcome: entry.outcome as TerminalResult["outcome"],
  };
}

export function terminalResults(args: string[], ports: Ports): number {
  if (
    args.length !== 2 ||
    args[0] !== "--author" ||
    !args[1].trim() ||
    args[1].startsWith("--") ||
    args[1] !== args[1].trim()
  ) {
    ports.error(`Usage: ${terminalResultsUsage}`);
    return 2;
  }
  try {
    let comments: unknown;
    try {
      comments = JSON.parse(ports.read());
    } catch {
      throw new Error(
        "Could not read a JSON comment array from standard input",
      );
    }
    if (!Array.isArray(comments))
      throw new Error("Input must be a JSON comment array");
    const results = new Map<string, TerminalResult>();
    for (const value of comments) {
      const comment = object(value);
      const author = object(comment?.author);
      if (
        !comment ||
        typeof comment.body !== "string" ||
        (comment.author !== null && typeof author?.login !== "string")
      )
        throw new Error("Each comment must supply body and author facts");
      if (!author || login(author.login as string) !== login(args[1])) continue;
      const last = comment.body.split(/\r\n?|\n/).at(-1) ?? "";
      const match = new RegExp(`^<!-- ${resultMarker} (\\{.*\\}) -->$`).exec(
        last,
      );
      const reported = runCommentResults(comment.body);
      if (reported !== undefined && !Array.isArray(reported))
        throw new Error("Invalid published terminal result data");
      let entries: TerminalResult[];
      try {
        entries = [
          ...(match ? [JSON.parse(match[1])] : []),
          ...((reported as unknown[] | undefined) ?? []),
        ].map(terminal);
      } catch {
        throw new Error("Invalid published terminal result data");
      }
      for (const entry of entries) {
        const previous = results.get(entry.run);
        if (previous && previous.outcome !== entry.outcome)
          throw new Error("Conflicting outcomes for a published run identity");
        results.set(entry.run, entry);
      }
    }
    ports.print(
      JSON.stringify({
        version: 1,
        results: [...results.values()].sort((a, b) =>
          a.run < b.run ? -1 : a.run > b.run ? 1 : 0,
        ),
      }),
    );
    return 0;
  } catch (error) {
    ports.error((error as Error).message);
    return 1;
  }
}
