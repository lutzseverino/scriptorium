// Each repository's clone in the state directory. Runs branch from it, and
// Sandcastle keeps their worktrees in its `.sandcastle/` directory.
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Runs Git in `cwd` and resolves its standard output.
export type Git = (cwd: string, args: string[]) => Promise<string>;

// Clones the repository when the clone is missing, otherwise brings it to
// the remote's default branch, discarding anything else in its working tree.
// Sandcastle's directory is excluded locally, since the repository need not
// ignore it, and commits made from the clone carry the host's Git identity.
export async function updateClone(
  git: Git,
  clone: string,
  url: string,
  identity: { name: string; email: string },
): Promise<void> {
  if (!existsSync(join(clone, ".git"))) {
    await mkdir(dirname(clone), { recursive: true });
    await git(dirname(clone), ["clone", "--quiet", url, clone]);
  } else {
    await git(clone, ["fetch", "--quiet", "--prune", "origin"]);
    await git(clone, [
      "reset",
      "--quiet",
      "--hard",
      "refs/remotes/origin/HEAD",
    ]);
  }
  await git(clone, ["config", "user.name", identity.name]);
  await git(clone, ["config", "user.email", identity.email]);
  const exclude = join(clone, ".git", "info", "exclude");
  const excluded = await readFile(exclude, "utf8").catch(() => "");
  if (!excluded.split("\n").includes("/.sandcastle/")) {
    await mkdir(dirname(exclude), { recursive: true });
    await appendFile(
      exclude,
      `${excluded === "" || excluded.endsWith("\n") ? "" : "\n"}/.sandcastle/\n`,
    );
  }
}

// The paths under `prefixes` that the run branch's commits change and the
// remote branch lacks, from `base` on.
export async function unpushedChanges(
  git: Git,
  clone: string,
  branch: string,
  base: string,
  prefixes: string[],
): Promise<string[]> {
  if (prefixes.length === 0) return [];
  const head = (
    await git(clone, [
      "for-each-ref",
      "--format=%(objectname)",
      `refs/heads/${branch}`,
    ])
  ).trim();
  if (!head) return [];
  const remote = (
    await git(clone, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`])
  )
    .trim()
    .split(/\s+/)[0];
  if (remote)
    await git(clone, ["fetch", "--quiet", "--no-tags", "origin", remote]);
  const commits = (
    await git(clone, [
      "rev-list",
      head,
      "--not",
      base,
      ...(remote ? [remote] : []),
    ])
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const paths = new Set<string>();
  for (const commit of commits) {
    const changed = await git(clone, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-z",
      "-r",
      "-m",
      commit,
      "--",
      ...prefixes,
    ]);
    for (const path of changed.split("\0").filter(Boolean)) paths.add(path);
  }
  return [...paths].sort();
}
