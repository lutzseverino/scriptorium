// The host runner: each pass reads every repository the host configuration
// lists, asks the decision core what to do across all of them, and carries
// the decisions out through GitHub, the repositories' clones and the
// providers' sandboxes.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { updateClone, unpushedChanges, type Git } from "./clone.ts";
import { invocation, labels } from "./conventions.ts";
import {
  decideFactory,
  type Claim,
  type Decision,
  type Issue,
  type Repository,
  type Run,
  type Settings,
  type Snapshot,
} from "./factory.ts";
import {
  repositoryGitHub,
  runBranch,
  type RepositoryGitHub,
} from "./github.ts";
import {
  removeSandboxToken,
  sandboxEnvironment,
  writeSandboxToken,
} from "./github-token.ts";
import type { HostConfiguration } from "./host-configuration.ts";
import type { LaunchRequest, Registry } from "./providers.ts";
import { hostStatus, writeStatus } from "./status.ts";

export type HostPorts = {
  // Runs the GitHub CLI as the token's holder.
  gh(token: string, args: string[]): Promise<string>;
  // Runs Git in `cwd`, authenticating to GitHub as the token's holder.
  git(token: string, cwd: string, args: string[]): Promise<string>;
  // The repository's GitHub token, from the host's token command.
  token(repository: string): Promise<string>;
  // The URL the repository is cloned from.
  remoteUrl(repository: string): string;
  // Builds the sandbox image over the repository's toolchain Dockerfile and
  // resolves its tag.
  buildImage(dockerfile: string): Promise<string>;
  readUsage(provider: string): Promise<number | null>;
  // Resolves or rejects when the run's agent exits.
  launch(provider: string, request: LaunchRequest): Promise<void>;
  now(): Date;
  report(line: string): void;
};

// The repository's sandbox Dockerfile, fixed by the factory.
export const dockerfilePath = ".factory/Dockerfile";

type HostRun = Run & {
  base: string;
  // The first attempt's start; a retry continues its pull request.
  pullRequestSince: string;
  controller: AbortController;
  exited: boolean;
  exitedAt: Date | null;
  stopped: boolean;
};

// One repository as this pass found it. An unreadable repository has no
// GitHub reads this pass, so only its running sandboxes reach the snapshot.
type Pass = {
  name: string;
  paused: string | null;
  token: string | null;
  github: RepositoryGitHub | null;
  image: string | null;
  read: Repository | null;
};

export function createHost(
  configuration: HostConfiguration,
  registry: Registry,
  ports: HostPorts,
) {
  const runs: HostRun[] = [];
  const settings: Settings = {
    defaultModel: configuration.models.default,
    retryModel: configuration.models.retry,
    caps: Object.fromEntries(
      Object.entries(configuration.providers).map(([name, { cap }]) => [
        name,
        cap,
      ]),
    ),
    usageThreshold: configuration.usageThreshold,
    timeLimitMinutes: configuration.timeLimitMinutes,
  };

  // Everything the process owns for a repository lives under its directory.
  function directory(repository: string) {
    const root = join(
      configuration.stateDirectory,
      "repositories",
      ...repository.split("/"),
    );
    return {
      clone: join(root, "clone"),
      logs: join(root, "logs"),
      runs: join(root, "runs"),
      // Each launch's GitHub CLI configuration, holding its token.
      github: join(root, "github"),
    };
  }

  async function read(name: string): Promise<Pass> {
    const pass: Pass = {
      name,
      paused: null,
      token: null,
      github: null,
      image: null,
      read: null,
    };
    try {
      pass.token = await ports.token(name);
    } catch (error) {
      pass.paused = `${error instanceof Error ? error.message : error}`;
      return pass;
    }
    const token = pass.token;
    const git: Git = (cwd, args) => ports.git(token, cwd, args);
    const github = repositoryGitHub(name, (args) => ports.gh(token, args));
    pass.github = github;
    const { clone } = directory(name);
    try {
      await updateClone(
        git,
        clone,
        ports.remoteUrl(name),
        configuration.gitIdentity,
      );
      const dockerfile = join(clone, dockerfilePath);
      if (!existsSync(dockerfile)) pass.paused = `it has no ${dockerfilePath}`;
      else
        try {
          pass.image = await ports.buildImage(
            await readFile(dockerfile, "utf8"),
          );
        } catch (error) {
          pass.paused = `its sandbox image did not build: ${error}`;
        }
    } catch (error) {
      pass.paused = `its clone did not update: ${error}`;
    }
    try {
      for (const run of runs.filter(
        (run) => run.repository === name && run.exited,
      )) {
        run.ended = {
          // Sandcastle's idle timeout can end a run at its limit before the
          // factory stops it, so the time it ran decides, not who ended it.
          timedOut:
            run.stopped ||
            run.exitedAt!.getTime() - Date.parse(run.startedAt) >=
              settings.timeLimitMinutes * 60_000,
          pullRequest: await github.pullRequestState(
            run.issue,
            run.pullRequestSince,
          ),
        };
        if (
          !run.ended.timedOut &&
          ["none", "closed"].includes(run.ended.pullRequest)
        ) {
          const paths = await unpushedChanges(
            git,
            clone,
            runBranch(run.issue),
            run.base,
            configuration.unpushablePaths,
          );
          if (paths.length) run.ended.unpushedChanges = paths;
        }
      }
      const issues = await github.readIssues();
      pass.read = {
        name,
        paused: pass.paused,
        issues,
        claims: await readClaims(name, github, issues),
      };
    } catch (error) {
      pass.paused = `its GitHub reads failed: ${error}`;
    }
    return pass;
  }

  // Every running-labelled issue, open or closed, that no run on the host
  // holds. A closed issue's work counts as merged.
  async function readClaims(
    name: string,
    github: RepositoryGitHub,
    issues: Issue[],
  ): Promise<Claim[]> {
    const held = (number: number) =>
      runs.some((run) => run.repository === name && run.issue === number);
    const claims: Claim[] = (await github.readClosedClaims())
      .filter((number) => !held(number))
      .map((number) => ({ issue: number, pullRequest: "merged" }));
    for (const issue of issues)
      if (issue.labels.includes(labels.running) && !held(issue.number))
        claims.push({
          issue: issue.number,
          pullRequest: await github.pullRequestState(issue.number),
        });
    return claims;
  }

  async function readUsage() {
    const usage: Record<string, number | null> = {};
    for (const provider of Object.keys(configuration.providers)) {
      try {
        usage[provider] = await ports.readUsage(provider);
      } catch (error) {
        ports.report(`usage for ${provider} is unreadable: ${error}`);
        usage[provider] = null;
      }
    }
    return usage;
  }

  function find(decision: { repository: string; issue: number }) {
    return runs.find(
      (run) =>
        run.repository === decision.repository && run.issue === decision.issue,
    );
  }

  function forget(decision: { repository: string; issue: number }) {
    const run = find(decision);
    if (run) runs.splice(runs.indexOf(run), 1);
  }

  async function record(run: HostRun) {
    const { controller: _c, ...recorded } = run;
    const runsDirectory = directory(run.repository).runs;
    await mkdir(runsDirectory, { recursive: true });
    await writeFile(
      join(runsDirectory, `issue-${run.issue}-attempt-${run.attempt}.json`),
      `${JSON.stringify(recorded, null, 2)}\n`,
    );
  }

  async function launch(decision: Decision & { kind: "launch" }, pass: Pass) {
    const { repository, issue } = decision;
    const paths = directory(repository);
    const base = (
      await ports.git(pass.token!, paths.clone, ["rev-parse", "HEAD"])
    ).trim();
    const previous = find(decision);
    forget(decision);
    const controller = new AbortController();
    const startedAt = ports.now().toISOString();
    const run: HostRun = {
      repository,
      base,
      issue,
      provider: decision.provider,
      model: decision.model,
      effort: decision.effort,
      attempt: decision.attempt,
      startedAt,
      pullRequestSince: previous?.pullRequestSince ?? startedAt,
      log: join(paths.logs, `issue-${issue}-attempt-${decision.attempt}.log`),
      ended: null,
      controller,
      exited: false,
      exitedAt: null,
      stopped: false,
    };
    await mkdir(paths.logs, { recursive: true });
    await mkdir(paths.github, { recursive: true, mode: 0o700 });
    const tokens = await mkdtemp(join(paths.github, `issue-${issue}-`));
    const github = await writeSandboxToken(tokens, pass.token!);
    runs.push(run);
    await record(run);
    ports
      .launch(run.provider, {
        model: run.model,
        effort: run.effort,
        name: `${repository}#${issue}`,
        cwd: paths.clone,
        image: pass.image!,
        prompt: prompt(
          registry.providers.get(run.provider)!.skillPrefix,
          issue,
          decision.retry,
        ),
        branch: runBranch(issue),
        log: run.log,
        idleTimeoutSeconds: settings.timeLimitMinutes * 60,
        mounts: [github],
        env: sandboxEnvironment,
        signal: controller.signal,
      })
      .catch((error) =>
        ports.report(
          `run for ${repository}#${issue} ended with an error: ${error}`,
        ),
      )
      .finally(async () => {
        run.exited = true;
        run.exitedAt = ports.now();
        try {
          // A token outlives no run.
          await removeSandboxToken(tokens);
          await record(run);
        } catch (error) {
          ports.report(
            `run for ${repository}#${issue} did not finish its records: ${error}`,
          );
        }
      });
  }

  async function apply(decision: Decision, pass: Pass) {
    const github = pass.github!;
    switch (decision.kind) {
      case "close": {
        await github.close(decision.issue, decision.tickets);
        const run = find(decision);
        if (run && !run.exited)
          run.controller.abort(new Error("its parent issue is closed"));
        forget(decision);
        return;
      }
      case "claim":
        await github.claim(decision.issue);
        return;
      case "launch":
        await launch(decision, pass);
        return;
      case "stop": {
        const run = find(decision);
        if (!run) return;
        run.stopped = true;
        run.controller.abort(new Error(decision.reason));
        return;
      }
      case "fail":
        await github.fail(
          decision.issue,
          failureComment(
            decision.failure,
            decision.log,
            find(decision),
            decision.unpushedChanges,
          ),
        );
        forget(decision);
        return;
      case "keep":
        forget(decision);
        return;
      case "release":
        await github.release(decision.issue);
        forget(decision);
        return;
      case "skip":
        ports.report(
          `${decision.repository}#${decision.issue} skipped: ${decision.reason}`,
        );
        return;
    }
  }

  async function tick(): Promise<Decision[]> {
    const passes: Pass[] = [];
    for (const name of configuration.repositories)
      passes.push(await read(name));
    const readable = new Set(
      passes.filter((pass) => pass.read).map((pass) => pass.name),
    );
    const snapshot: Snapshot = {
      now: ports.now().toISOString(),
      repositories: passes.flatMap((pass) => (pass.read ? [pass.read] : [])),
      runs: runs
        .filter((run) => readable.has(run.repository) || !run.exited)
        .map(
          ({
            controller: _c,
            exited,
            exitedAt: _x,
            stopped: _s,
            base: _b,
            pullRequestSince: _p,
            ...run
          }) => ({ ...run, ended: exited ? run.ended : null }),
        ),
      usage: await readUsage(),
      settings,
    };
    for (const pass of passes)
      if (pass.paused !== null)
        ports.report(`${pass.name} is paused: ${pass.paused}`);
    const decisions = decideFactory(snapshot, registry);
    // A failed write stops that repository's decisions for this pass, such as
    // a launch after a claim that did not apply; other repositories continue.
    const stopped = new Set<string>();
    for (const decision of decisions) {
      if (stopped.has(decision.repository)) continue;
      try {
        await apply(
          decision,
          passes.find((pass) => pass.name === decision.repository)!,
        );
      } catch (error) {
        stopped.add(decision.repository);
        ports.report(
          `${decision.repository}#${decision.issue} ${decision.kind} failed, so ${decision.repository} waits for the next pass: ${error}`,
        );
      }
    }
    try {
      await writeStatus(
        join(configuration.stateDirectory, "status.json"),
        hostStatus(snapshot.now, passes, decisions),
      );
    } catch (error) {
      ports.report(`the status file was not written: ${error}`);
    }
    return decisions;
  }

  return { tick };
}

export function prompt(
  skillPrefix: string,
  issue: number,
  retry?: { failure: string; log: string },
): string {
  const start = invocation(skillPrefix, issue);
  if (!retry) return start;
  let tail = "";
  try {
    const log = readFileSync(retry.log, "utf8");
    const lines = log.split("\n");
    const terminated = lines.at(-1) === "";
    if (terminated) lines.pop();
    tail = lines.slice(-200).join("\n") + (log && terminated ? "\n" : "");
    const bytes = Buffer.from(tail);
    let begin = Math.max(0, bytes.length - 16 * 1024);
    // Keep valid UTF-8 when the byte cap lands inside a character.
    while (begin < bytes.length && (bytes[begin] & 0xc0) === 0x80) begin++;
    tail = bytes.subarray(begin).toString("utf8");
  } catch {
    // A missing or unreadable first-attempt log does not prevent a retry.
  }
  return [
    start,
    `First attempt failure: ${retry.failure}`,
    ...(tail ? [`First attempt log tail:\n${tail}`] : []),
  ].join("\n\n");
}

// A claim no run holds has no model or log to name.
function failureComment(
  failure: string,
  log: string | null,
  run?: HostRun,
  unpushed?: string[],
): string {
  const details = [
    ...(run
      ? [
          `- Model: \`${run.provider}/${run.model}@${run.effort}\`, attempt ${run.attempt}`,
        ]
      : []),
    ...(log ? [`- Log: \`${log}\` on the factory host`] : []),
  ];
  return [
    `The factory run failed: ${failure}.`,
    "",
    ...(details.length > 0 ? [...details, ""] : []),
    ...(unpushed?.length
      ? [
          ...unpushed.map((path) => `- Unpushable: \`${path}\``),
          "",
          "A person with permission to push these paths must deliver the change.",
          "",
        ]
      : []),
    `Remove \`${labels.failed}\` to let the factory pick this issue up again.`,
  ].join("\n");
}
