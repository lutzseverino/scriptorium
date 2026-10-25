import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCode, codex, createWorktree } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { directory } from "./fakes.ts";

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// A run starts before the remote default branch gains a workflow change.
// These local commands exercise the documented delivery procedure; they do
// not simulate an agent's judgement or reproduce a GitHub permission refusal.
async function delivery(t: TestContext) {
  const root = directory(t);
  const upstream = join(root, "upstream");
  const clone = join(root, "clone");
  git(root, ["init", "--quiet", "--initial-branch=trunk", upstream]);
  git(upstream, ["config", "user.name", "Fixture"]);
  git(upstream, ["config", "user.email", "fixture@example.test"]);
  mkdirSync(join(upstream, ".github/workflows"), { recursive: true });
  writeFileSync(join(upstream, ".github/workflows/release.yml"), "original\n");
  git(upstream, ["add", "."]);
  git(upstream, ["commit", "--quiet", "-m", "base"]);
  git(root, ["clone", "--quiet", upstream, clone]);
  git(clone, ["config", "user.name", "Fixture"]);
  git(clone, ["config", "user.email", "fixture@example.test"]);
  const options = {
    cwd: clone,
    branchStrategy: { type: "branch" as const, branch: "factory/issue-49" },
  };
  const run = await createWorktree(options);
  const work = run.worktreePath;
  writeFileSync(join(work, "issue.md"), "committed issue work\n");
  git(work, ["add", "issue.md"]);
  git(work, ["commit", "--quiet", "-m", "issue work"]);
  const issue = git(work, ["rev-parse", "HEAD"]);
  writeFileSync(join(upstream, ".github/workflows/release.yml"), "upstream\n");
  git(upstream, ["commit", "--quiet", "-am", "upstream workflow"]);
  const base = git(upstream, ["rev-parse", "HEAD"]);
  git(work, ["fetch", "--prune", "origin"]);
  git(work, ["remote", "set-head", "origin", "--auto"]);
  assert.equal(
    git(work, ["symbolic-ref", "refs/remotes/origin/HEAD"]),
    "refs/remotes/origin/trunk",
  );
  return { options, run, work, issue, base };
}

test("the pinned Sandcastle dependency constructs agents and a sandbox without launching them", () => {
  assert.equal(claudeCode("claude-sonnet-4-6").name, "claude-code");
  assert.equal(codex("gpt-6.1-sol").name, "codex");
  assert.equal(docker({ imageName: "factory-smoke-test" }).name, "docker");
});

test("pinned Sandcastle preserves and reuses committed, staged, unstaged and untracked recovery work", async (t) => {
  const root = directory(t);
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "user.email", "fixture@example.test"]);
  writeFileSync(join(root, "base"), "base");
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  const options = {
    cwd: root,
    branchStrategy: { type: "branch" as const, branch: "factory/issue-34" },
  };
  const first = await createWorktree(options);
  const work = first.worktreePath;
  writeFileSync(join(work, "implementation"), "committed");
  git(work, ["add", "implementation"]);
  git(work, ["commit", "--quiet", "-m", "implementation"]);
  const head = git(work, ["rev-parse", "HEAD"]);
  writeFileSync(join(work, "implementation"), "staged");
  git(work, ["add", "implementation"]);
  writeFileSync(join(work, "implementation"), "unstaged");
  writeFileSync(join(work, "untracked"), "untracked");
  const status = git(work, ["status", "--porcelain"]);
  await first.close();
  const recovered = await createWorktree(options);
  assert.equal(recovered.worktreePath, work);
  assert.equal(git(work, ["rev-parse", "HEAD"]), head);
  assert.equal(git(work, ["status", "--porcelain"]), status);
  assert.equal(git(work, ["show", ":implementation"]), "staged");
  assert.equal(readFileSync(join(work, "implementation"), "utf8"), "unstaged");
  assert.equal(readFileSync(join(work, "untracked"), "utf8"), "untracked");
  await recovered.close();
  // When everything is committed, cleanup removes only the worktree. Its
  // explicit branch still holds the implementation for a later retry.
  git(work, ["add", "."]);
  git(work, ["commit", "--quiet", "-m", "finish recovery"]);
  const cleanHead = git(work, ["rev-parse", "HEAD"]);
  const clean = await createWorktree(options);
  await clean.close();
  const later = await createWorktree(options);
  assert.equal(git(later.worktreePath, ["rev-parse", "HEAD"]), cleanHead);
  await later.close();
});

for (const intentionalWorkflow of [false, true])
  test(`rebasing issue work onto an advanced default branch retains intentional workflow edits: ${intentionalWorkflow}`, async (t) => {
    const { run, work, base } = await delivery(t);
    if (intentionalWorkflow) {
      writeFileSync(join(work, ".github/workflows/issue.yml"), "intentional\n");
      git(work, ["add", "."]);
      git(work, ["commit", "--quiet", "-m", "issue workflow"]);
    }
    git(work, ["branch", "recovery/before-delivery", "HEAD"]);
    git(work, ["rebase", "origin/HEAD"]);
    assert.equal(git(work, ["merge-base", "origin/HEAD", "HEAD"]), base);
    assert.equal(
      git(work, ["log", "--format=%s", "origin/HEAD..HEAD"]),
      intentionalWorkflow ? "issue workflow\nissue work" : "issue work",
    );
    assert.equal(
      git(work, [
        "log",
        "--format=",
        "--name-only",
        "-m",
        "origin/HEAD..HEAD",
        "--",
        ".github/workflows",
      ]),
      intentionalWorkflow ? ".github/workflows/issue.yml" : "",
    );
    assert.equal(
      readFileSync(join(work, ".github/workflows/release.yml"), "utf8"),
      "upstream\n",
    );
    assert.equal(
      readFileSync(join(work, "issue.md"), "utf8"),
      "committed issue work\n",
    );
    await run.close();
  });

for (const contamination of ["rewritten base workflow", "reverted workflow"])
  test(`selective replay preserves dirty recovery work and removes unrelated ${contamination} history`, async (t) => {
    const { options, run, work, issue, base } = await delivery(t);
    if (contamination === "rewritten base workflow") {
      git(work, ["cherry-pick", base]);
      assert.notEqual(git(work, ["rev-parse", "HEAD"]), base);
      // Even the final tree comparison against the current base is clean.
      assert.equal(
        git(work, ["diff", "origin/HEAD", "HEAD", "--", ".github/workflows"]),
        "",
      );
    } else {
      writeFileSync(
        join(work, ".github/workflows/temporary.yml"),
        "unrelated\n",
      );
      git(work, ["add", "."]);
      git(work, ["commit", "--quiet", "-m", "unrelated workflow"]);
      git(work, ["revert", "--no-edit", "HEAD"]);
      // A three-dot diff also conceals the add-and-revert history.
      assert.equal(
        git(work, ["diff", "origin/HEAD...HEAD", "--", ".github/workflows"]),
        "",
      );
    }
    assert.match(
      git(work, ["log", "--stat", "--patch", "-m", "origin/HEAD..HEAD"]),
      /\.github\/workflows\//,
    );
    writeFileSync(join(work, "issue.md"), "staged issue work\n");
    git(work, ["add", "issue.md"]);
    writeFileSync(join(work, "issue.md"), "unstaged issue work\n");
    writeFileSync(join(work, "untracked.md"), "untracked issue work\n");
    const status = git(work, ["status", "--porcelain"]);
    const head = git(work, ["rev-parse", "HEAD"]);
    await run.close();
    const recovered = await createWorktree(options);
    assert.equal(recovered.worktreePath, work);
    assert.equal(git(work, ["rev-parse", "HEAD"]), head);
    assert.equal(git(work, ["status", "--porcelain"]), status);

    // An owner has identified the issue commit and requested reconstruction.
    // Retain both the original history and all dirty layers before replay.
    git(work, ["branch", "recovery/before-delivery", "HEAD"]);
    git(work, [
      "stash",
      "push",
      "--include-untracked",
      "-m",
      "before delivery",
    ]);
    const saved = git(work, ["rev-parse", "stash@{0}"]);
    git(work, ["switch", "-c", "delivery/issue-49", "origin/HEAD"]);
    git(work, ["cherry-pick", issue]);
    git(work, ["stash", "apply", "--index", saved]);
    assert.equal(git(work, ["merge-base", "origin/HEAD", "HEAD"]), base);
    assert.equal(
      git(work, ["log", "--format=%s", "origin/HEAD..HEAD"]),
      "issue work",
    );
    assert.equal(
      git(work, ["diff", "--name-only", "origin/HEAD...HEAD"]),
      "issue.md",
    );
    assert.doesNotMatch(
      git(work, ["log", "--stat", "--patch", "-m", "origin/HEAD..HEAD"]),
      /\.github\/workflows\//,
    );
    assert.equal(git(work, ["status", "--porcelain"]), status);
    assert.equal(git(work, ["show", ":issue.md"]), "staged issue work");
    assert.equal(
      readFileSync(join(work, "issue.md"), "utf8"),
      "unstaged issue work\n",
    );
    assert.equal(
      readFileSync(join(work, "untracked.md"), "utf8"),
      "untracked issue work\n",
    );
    assert.equal(git(work, ["rev-parse", "recovery/before-delivery"]), head);
    assert.equal(git(work, ["rev-parse", "stash@{0}"]), saved);
    assert.equal(
      git(work, [
        "ls-remote",
        "--heads",
        "origin",
        "factory/issue-49",
        "delivery/issue-49",
      ]),
      "",
    );
    await recovered.close();
  });
