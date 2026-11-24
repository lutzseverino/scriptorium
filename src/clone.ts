// The shared clone follows the remote default branch. Each claim gets its
// own run clone, including its Git directory and objects.
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import {
  appendFile,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// Runs Git in `cwd` and resolves its standard output. Host Git reaches remotes
// over HTTPS alone; a `local` call reads a local repository the host owns,
// never a run clone.
export type Git = (
  cwd: string,
  args: string[],
  options?: { local?: boolean },
) => Promise<string>;

export type Recovery = { branch: string; head: string; worktree?: string };

// Read local identities without checking out, cleaning, pushing or changing
// the branch. This also works when a killed launcher returned no metadata.
export async function readRecovery(
  git: Git,
  clone: string,
  branch: string,
): Promise<Recovery | undefined> {
  const head = (
    await git(clone, [
      "for-each-ref",
      "--format=%(objectname)",
      `refs/heads/${branch}`,
    ])
  ).trim();
  if (!head) return undefined;
  const listed = await git(clone, ["worktree", "list", "--porcelain", "-z"]);
  const entry = listed
    .split("\0\0")
    .find((entry) => entry.split("\0").includes(`branch refs/heads/${branch}`));
  const worktree = entry
    ?.split("\0")
    .find((field) => field.startsWith("worktree "))
    ?.slice("worktree ".length);
  return { branch, head, ...(worktree && { worktree }) };
}

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
    // Fetch alone leaves origin/HEAD pointing at the old default branch.
    await git(clone, ["remote", "set-head", "origin", "--auto"]);
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

// Seam (deferred): host-owned run-clone storage; consumers: host (1); extract at 3.
// Prepare once, then reuse without checkout/reset so every dirty layer and
// agent-created branch survives a retry, pause or interruption. Publish the
// directory only after initialization succeeds.
export async function prepareRunClone(
  git: Git,
  shared: string,
  clone: string,
  url: string,
  identity: { name: string; email: string },
  branch: string,
  recoverLegacy: boolean,
): Promise<void> {
  await mkdir(dirname(clone), { recursive: true });
  // Only this claim can prepare its clone. A crash before publication can
  // leave temporary copies, including beside an already initialized clone.
  const prefix = `${basename(clone)}-`;
  for (const entry of await readdir(dirname(clone)))
    if (entry.startsWith(prefix))
      await rm(join(dirname(clone), entry), { recursive: true, force: true });
  if (existsSync(join(clone, ".git"))) return;
  // A crash during removal can leave a directory with no Git state.
  await rm(clone, { recursive: true, force: true });
  const legacy = recoverLegacy
    ? await readRecovery(git, shared, branch)
    : undefined;
  const temporary = await mkdtemp(`${clone}-`);
  try {
    // The shared clone is the host's own, so this one call may read it.
    await git(
      dirname(clone),
      ["clone", "--quiet", "--no-hardlinks", shared, temporary],
      { local: true },
    );
    // Fetches and delivery must reach the upstream, never the shared clone.
    await git(temporary, ["remote", "set-url", "origin", url]);
    await git(temporary, ["fetch", "--quiet", "--prune", "origin"]);
    await git(temporary, ["remote", "set-head", "origin", "--auto"]);
    await git(temporary, ["config", "user.name", identity.name]);
    await git(temporary, ["config", "user.email", identity.email]);
    const published = (
      await git(temporary, [
        "for-each-ref",
        "--format=%(objectname)",
        `refs/remotes/origin/${branch}`,
      ])
    ).trim();
    const start = legacy?.head ?? published;
    await git(temporary, [
      "switch",
      "--quiet",
      "-c",
      branch,
      ...(start ? [start] : []),
    ]);
    const worktree = legacy?.worktree;
    if (worktree) {
      // Keep the old checkout untouched. Copy every working-tree layer,
      // including deletions and ignored files, then its exact staging index.
      for (const entry of await readdir(temporary))
        if (entry !== ".git")
          await rm(join(temporary, entry), { recursive: true, force: true });
      await cp(worktree, temporary, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (source) => source !== join(worktree, ".git"),
      });
      const index = (
        await git(worktree, [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "index",
        ])
      ).trim();
      await copyFile(index, join(temporary, ".git", "index"));
    }
    await rename(temporary, clone);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

// Move the clone aside before deleting it, so an interrupted removal leaves
// only a temporary sibling, never a partial clone a later launch would reuse.
// Synchronous, so no preparation of the same clone can interleave.
export function removeRunClone(clone: string): void {
  if (!existsSync(dirname(clone))) return;
  if (existsSync(clone))
    renameSync(clone, join(mkdtempSync(`${clone}-`), "clone"));
  const prefix = `${basename(clone)}-`;
  for (const entry of readdirSync(dirname(clone)))
    if (entry.startsWith(prefix))
      rmSync(join(dirname(clone), entry), { recursive: true, force: true });
}

// The paths under `prefixes` changed by commits on this branch that neither
// the remote default branch nor its published run branch contains. The caller
// refreshes origin and resolves its default branch before assessment.
export async function unpushedChanges(
  git: Git,
  clone: string,
  branch: string,
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
      "refs/remotes/origin/HEAD",
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
