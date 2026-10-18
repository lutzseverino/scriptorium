// The `resume` command: `node src/main.ts resume <host configuration>
// <provider> [--drain-threshold N]` queues a request to lift the provider's
// owner hold, and to raise its drain threshold once, in the host
// configuration's state directory. The running factory applies it on its next
// pass; this command never runs or edits the factory itself.
import { readHostConfiguration } from "./host-configuration.ts";
import { queueResume, resumeProblem } from "./owner.ts";

export const resumeUsage =
  "node src/main.ts resume <host configuration> <provider> [--drain-threshold N]";

export type ResumePorts = {
  now(): Date;
  // Writes a line to standard output, or to standard error.
  print(line: string): void;
  error(line: string): void;
};

// Queues the request and resolves the command's exit status: 0 once queued,
// 1 for a request the configuration refuses, and 2 for a malformed command.
export function resume(args: string[], ports: ResumePorts): number {
  const parsed = parse(args);
  if (typeof parsed === "string") {
    ports.error(`${parsed}\nUsage: ${resumeUsage}`);
    return 2;
  }
  let configuration;
  try {
    configuration = readHostConfiguration(parsed.path, ports.error);
  } catch (error) {
    ports.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const problem = resumeProblem(
    Object.keys(configuration.providers),
    configuration.usage,
    parsed,
  );
  if (problem) {
    ports.error(`The resume request was not queued: ${problem}`);
    return 1;
  }
  const request = {
    provider: parsed.provider,
    ...(parsed.drainThreshold !== undefined && {
      drainThreshold: parsed.drainThreshold,
    }),
    requestedAt: ports.now().toISOString(),
  };
  let id;
  try {
    id = queueResume(configuration.stateDirectory, request);
  } catch (error) {
    ports.error(`The resume request was not queued: ${error}`);
    return 1;
  }
  const raise =
    request.drainThreshold === undefined
      ? ""
      : ` and raise its drain threshold once to ${request.drainThreshold}%`;
  ports.print(
    `Queued resume request ${id} to lift ${request.provider}'s owner hold${raise}. The running factory applies it on its next pass, within ${configuration.pollSeconds} seconds of its current one, and logs "resume request ${id} applied".`,
  );
  return 0;
}

function parse(
  args: string[],
): { path: string; provider: string; drainThreshold?: number } | string {
  const positional: string[] = [];
  let drainThreshold: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const option = /^--drain-threshold(?:=(?<value>.*))?$/.exec(arg);
    if (option) {
      if (drainThreshold !== undefined)
        return "--drain-threshold is given twice";
      const value = option.groups?.value ?? args[++index];
      if (value === undefined || !/^\d+(?:\.\d+)?$/.test(value))
        return "--drain-threshold needs a percentage";
      drainThreshold = Number(value);
    } else if (arg.startsWith("--")) return `${arg} is not an option`;
    else positional.push(arg);
  }
  if (positional.length !== 2)
    return "resume needs the host configuration and a provider";
  const [path, provider] = positional;
  return {
    path,
    provider,
    ...(drainThreshold !== undefined && { drainThreshold }),
  };
}
