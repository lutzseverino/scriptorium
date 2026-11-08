// GitHub tokens: the host's token command prints one for a repository, the
// factory caches it until it is due for refresh, and a sandbox reads its
// token from a file the factory writes into the run's directory, mounts
// read-only and rewrites on every refresh. The host's own reads and writes use
// the repository's token; a sandbox's is narrowed to its run kind.
import { execFile } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunKindName } from "./factory-configuration.ts";
import type { Mount } from "./providers.ts";
import type { Redactor } from "./redaction.ts";

const reads = Object.freeze({
  contents: "read",
  issues: "read",
  metadata: "read",
  pull_requests: "read",
} as const);
// Implement and review push and open or review pull requests, and read the
// checks they wait on. GitHub grants merging with the contents write a push
// needs, so a token cannot withhold one from the other.
const pullRequestWork = Object.freeze({
  ...reads,
  actions: "read",
  checks: "read",
  contents: "write",
  pull_requests: "write",
  statuses: "read",
} as const);

// GitHub App permissions, as an installation token request names them.
export type GitHubPermissions = Readonly<
  Partial<Record<keyof typeof pullRequestWork, "read" | "write">>
>;

// The permissions each run kind's sandbox token is narrowed to. They are the
// factory's, not configuration: triage only reads, and no kind writes the
// issue itself.
export const runKindPermissions: Readonly<
  Record<RunKindName, GitHubPermissions>
> = Object.freeze({
  triage: reads,
  implement: pullRequestWork,
  review: pullRequestWork,
});

// A token is reused until it is this old, then the command runs again. The
// command must print tokens that stay valid for at least
// `tokenLifetimeMinutes`, so a refresh that fails is retried while the
// running sandboxes' token is still valid.
export const tokenRefreshMinutes = 30;
export const tokenLifetimeMinutes = 45;

// Prints a token for the repository, narrowed to `permissions` when given.
export type TokenCommand = (
  repository: string,
  permissions?: GitHubPermissions,
) => Promise<string>;

export type GitHubTokens = {
  // The repository's token, or with `permissions` a sandbox's token narrowed
  // to them: the cached one, or a new one from the command once the cached
  // one is due for refresh.
  get: TokenCommand;
};

// Caches each repository's token and each permission set's token apart from
// `command`, adding every token it prints to `redactor`. Concurrent requests
// share one run of the command, and a failed run caches nothing.
export function githubTokens(
  command: TokenCommand,
  now: () => Date,
  redactor: Redactor,
): GitHubTokens {
  const cached = new Map<string, { token: string; printedAt: number }>();
  const pending = new Map<string, Promise<string>>();
  return {
    get(repository, permissions) {
      const key = JSON.stringify([repository, permissions ?? null]);
      const entry = cached.get(key);
      if (
        entry &&
        now().getTime() - entry.printedAt < tokenRefreshMinutes * 60_000
      )
        return Promise.resolve(entry.token);
      let request = pending.get(key);
      if (!request) {
        request = command(repository, permissions)
          .then((token) => {
            redactor.add(token);
            cached.set(key, { token, printedAt: now().getTime() });
            return token;
          })
          .finally(() => pending.delete(key));
        pending.set(key, request);
      }
      return request;
    },
  };
}

// Runs the token command with `<owner>/<name>` appended, then the permission
// set as JSON for a sandbox's token, and resolves the token it prints.
export function tokenCommand(command: string[]): TokenCommand {
  return (repository, permissions) =>
    new Promise((resolve, reject) => {
      execFile(
        command[0],
        [
          ...command.slice(1),
          repository,
          ...(permissions ? [JSON.stringify(permissions)] : []),
        ],
        { timeout: 60_000, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          const token = stdout.trim();
          if (error)
            reject(
              new Error(
                `the token command for ${repository} failed${error.code === undefined ? "" : ` with ${error.code}`}`,
              ),
            );
          else if (token === "" || /\s/.test(token))
            reject(
              new Error(
                `the token command for ${repository} printed no single token`,
              ),
            );
          else resolve(token);
        },
      );
    });
}

// Where the sandbox finds its GitHub CLI configuration.
export const sandboxGitHubDirectory = "/run/factory/github";

// The GitHub CLI reads the token from this configuration directory, and Git
// asks the GitHub CLI for its GitHub credentials.
export const sandboxEnvironment: Record<string, string> = {
  GH_CONFIG_DIR: sandboxGitHubDirectory,
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
  GIT_CONFIG_VALUE_0: "",
  GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
  GIT_CONFIG_VALUE_1: "!gh auth git-credential",
};

// Writes the token into the existing `directory` as GitHub CLI
// configuration, readable only by the host's user, and returns the sandbox's
// mount of it. The configuration's version keeps the GitHub CLI from
// migrating it in place. Each file is replaced whole, so a sandbox reading
// it during a refresh sees the old token or the new one.
export async function writeSandboxToken(
  directory: string,
  token: string,
): Promise<Mount> {
  await replace(join(directory, "config.yml"), 'version: "1"\n');
  await replace(
    join(directory, "hosts.yml"),
    [
      "github.com:",
      "    users:",
      "        x-access-token:",
      `            oauth_token: ${JSON.stringify(token)}`,
      `    oauth_token: ${JSON.stringify(token)}`,
      "    user: x-access-token",
      "    git_protocol: https",
      "",
    ].join("\n"),
  );
  return {
    hostPath: directory,
    sandboxPath: sandboxGitHubDirectory,
    readonly: true,
  };
}

async function replace(path: string, content: string) {
  const partial = `${path}.partial`;
  await writeFile(partial, content, { mode: 0o600 });
  await rename(partial, path);
}
