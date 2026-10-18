import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCode, codex, createWorktree } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { directory } from "./fakes.ts";

test("the pinned Sandcastle dependency constructs agents and a sandbox without launching them", () => {
  assert.equal(claudeCode("claude-sonnet-4-6").name, "claude-code");
  assert.equal(codex("gpt-6.1-sol").name, "codex");
  assert.equal(docker({ imageName: "factory-smoke-test" }).name, "docker");
});

test("pinned Sandcastle preserves and reuses committed, staged, unstaged and untracked recovery work", async (t) => {
  const root = directory(t);
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
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
