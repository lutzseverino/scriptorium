// GitHub tokens: the host's token command prints one for a repository, and a
// sandbox reads its token from a file the factory writes into the run's
// directory and mounts read-only.
import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Mount } from "./providers.ts";

// Runs the token command with `<owner>/<name>` appended and resolves the
// token it prints.
export function tokenCommand(
  command: string[],
): (repository: string) => Promise<string> {
  return (repository) =>
    new Promise((resolve, reject) => {
      execFile(
        command[0],
        [...command.slice(1), repository],
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
// migrating it in place.
export async function writeSandboxToken(
  directory: string,
  token: string,
): Promise<Mount> {
  await writeFile(join(directory, "config.yml"), 'version: "1"\n', {
    mode: 0o600,
  });
  await writeFile(
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
    { mode: 0o600 },
  );
  return {
    hostPath: directory,
    sandboxPath: sandboxGitHubDirectory,
    readonly: true,
  };
}

export async function removeSandboxToken(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}
