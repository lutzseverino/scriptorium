// The supported process interface keeps private publication formats with
// Scriptorium. Callers transport tracker facts and compare opaque identities.
import { resultCommentTerminal, type TerminalResult } from "./run-result.ts";
import { runCommentResults } from "./run-comment.ts";
import { object } from "./status.ts";

export const terminalResultsUsage =
  "node src/main.ts results --author <trusted publishing account>";

type Ports = {
  read(): Promise<string>;
  print(line: string): void;
  error(line: string): void;
};

const login = (value: string) =>
  value.toLowerCase().replace(/^app\/(.+)$/, "$1[bot]");

export async function terminalResults(
  args: string[],
  ports: Ports,
): Promise<number> {
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
      comments = JSON.parse(await ports.read());
    } catch {
      throw new Error(
        "Could not read a JSON comment array from standard input",
      );
    }
    if (!Array.isArray(comments))
      throw new Error("Input must be a JSON comment array");
    const entries: TerminalResult[] = [];
    const withdrawn = new Set<string>();
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
      const standalone = resultCommentTerminal(comment.body);
      const reported = runCommentResults(comment.body);
      entries.push(
        ...(standalone ? [standalone] : []),
        ...(reported?.results ?? []),
      );
      for (const run of reported?.withdrawn ?? []) withdrawn.add(run);
    }
    const results = new Map<string, TerminalResult>();
    for (const entry of entries) {
      if (withdrawn.has(entry.run)) continue;
      const previous = results.get(entry.run);
      if (previous && previous.outcome !== entry.outcome)
        throw new Error("Conflicting outcomes for a published run identity");
      results.set(entry.run, entry);
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
