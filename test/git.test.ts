import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { readRecovery, unpushedChanges, type Git } from "../src/clone.ts";
import { hostGitEnvironment } from "../src/git.ts";
import { directory } from "./fakes.ts";

const base = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.test",
};

// Runs Git with `environment`, resolving its output, or its error output
// when it fails: a refused or failing call must still run nothing planted.
function gitWith(environment: NodeJS.ProcessEnv, prefix: string[] = []): Git {
  return (cwd, args) =>
    new Promise((resolve) => {
      const child = execFile(
        "git",
        [...prefix, ...args],
        { cwd, env: environment },
        (error, stdout, stderr) => resolve(error ? stderr : stdout),
      );
      // `credential fill` reads its request; every other call reads nothing,
      // and may exit before its input closes.
      child.stdin?.on("error", () => {});
      child.stdin?.end(
        args[0] === "credential" ? "protocol=https\nhost=example.test\n\n" : "",
      );
    });
}

const hooks = ["post-checkout", "pre-commit", "reference-transaction"];

// A run clone whose sandbox planted hooks, in the default directory and in a
// configured `core.hooksPath`, and command-valued configuration. Each writes
// its name to the marker file when it runs.
async function plantedClone(t: TestContext) {
  const root = directory(t);
  const upstream = join(root, "upstream.git");
  const clone = join(root, "run-clone");
  const marker = join(root, "marker");
  const git = gitWith(base);
  await git(root, ["init", "--quiet", "--bare", "-b", "main", upstream]);
  await git(root, ["clone", "--quiet", upstream, clone]);
  writeFileSync(join(clone, "a.txt"), "a\n");
  await git(clone, ["add", "a.txt"]);
  await git(clone, ["commit", "--quiet", "-m", "base"]);
  await git(clone, ["push", "--quiet", "origin", "main"]);
  await git(clone, ["remote", "set-head", "origin", "--auto"]);
  await git(clone, ["switch", "--quiet", "-c", "factory/issue-4"]);
  writeFileSync(join(clone, "b.txt"), "b\n");
  await git(clone, ["add", "b.txt"]);
  await git(clone, ["commit", "--quiet", "-m", "work"]);
  const script = (name: string) => `#!/bin/sh\necho ${name} >> "${marker}"\n`;
  const planted = join(clone, ".git", "planted-hooks");
  for (const directory of [join(clone, ".git", "hooks"), planted]) {
    mkdirSync(directory, { recursive: true });
    for (const hook of hooks) {
      writeFileSync(join(directory, hook), script(hook));
      chmodSync(join(directory, hook), 0o755);
    }
  }
  const executable = (name: string) => {
    const path = join(clone, ".git", name);
    writeFileSync(path, script(name));
    chmodSync(path, 0o755);
    return path;
  };
  // The upstream's objects stand in for an alternate the sandbox added.
  mkdirSync(join(clone, ".git", "objects", "info"), { recursive: true });
  writeFileSync(
    join(clone, ".git", "objects", "info", "alternates"),
    `${join(upstream, "objects")}\n`,
  );
  const command = (name: string) => `echo ${name} >> "${marker}"; false`;
  for (const [key, value] of [
    ["core.hooksPath", planted],
    ["core.fsmonitor", command("core.fsmonitor")],
    ["core.sshCommand", command("core.sshCommand")],
    ["core.askPass", executable("core.askPass")],
    ["credential.helper", `!${command("credential.helper")}`],
    ["core.alternateRefsCommand", command("core.alternateRefsCommand")],
    // A local remote whose upload-pack command runs on the host.
    ["protocol.file.allow", "always"],
    ["remote.planted.url", upstream],
    ["remote.planted.uploadpack", command("uploadpack")],
    ["protocol.ext.allow", "always"],
    ["remote.extended.url", `ext::${executable("ext")}`],
  ])
    await git(clone, ["config", key, value]);
  writeFileSync(join(clone, "c.txt"), "c\n");
  return { clone, upstream, marker };
}

// What the host runs in a run clone: its recovery reads and delivery checks,
// Sandcastle's own host calls around a head-strategy run, and calls that
// reach each planted hook and command-valued setting.
async function hostCalls(git: Git, upstreamGit: Git, clone: string) {
  const recovery = await readRecovery(git, clone, "factory/issue-4");
  // The fixture's local upstream stands in for GitHub's HTTPS remote.
  await upstreamGit(clone, ["fetch", "--quiet", "--prune", "origin"]);
  await upstreamGit(clone, ["remote", "set-head", "origin", "--auto"]);
  const unpushed = await unpushedChanges(
    upstreamGit,
    clone,
    "factory/issue-4",
    ["b.txt"],
  );
  await git(clone, ["rev-parse", "--abbrev-ref", "HEAD"]);
  await git(clone, ["config", "user.name"]);
  const head = (await git(clone, ["rev-parse", "HEAD"])).trim();
  await git(clone, ["rev-list", `${head}~1..HEAD`, "--count"]);
  await git(clone, ["merge", "factory/issue-4"]);
  await git(clone, ["status", "--porcelain"]);
  await git(clone, ["add", "c.txt"]);
  await git(clone, ["commit", "--quiet", "-m", "more"]);
  await git(clone, ["update-ref", "refs/heads/probe", "HEAD"]);
  await git(clone, ["switch", "--quiet", "main"]);
  await git(clone, ["fetch", "--quiet", "planted"]);
  await git(clone, ["ls-remote", "extended"]);
  await git(clone, ["ls-remote", "ssh://planted.invalid/repository.git"]);
  await git(clone, ["credential", "fill"]);
  return {
    recovery,
    unpushed,
    committed: (await git(clone, ["log", "-1", "--format=%s", "probe"])).trim(),
  };
}

const planted = [
  ...hooks,
  "core.fsmonitor",
  "core.sshCommand",
  "core.askPass",
  "credential.helper",
  "core.alternateRefsCommand",
  "uploadpack",
  "ext",
];

function ran(marker: string): Set<string> {
  return new Set(
    existsSync(marker)
      ? readFileSync(marker, "utf8").split("\n").filter(Boolean)
      : [],
  );
}

test("the fixture's planted hooks and command-valued configuration run in Git without the host's settings", async (t) => {
  const { clone, marker } = await plantedClone(t);
  await hostCalls(gitWith(base), gitWith(base), clone);
  const observed = ran(marker);
  for (const name of planted) assert.ok(observed.has(name), name);
});

test("a run clone's planted hooks and command-valued configuration never run in host Git", async (t) => {
  const { clone, marker } = await plantedClone(t);
  const environment = hostGitEnvironment(base);
  const calls = await hostCalls(
    gitWith(environment),
    gitWith(environment, ["-c", "protocol.file.allow=always"]),
    clone,
  );
  // The calls themselves succeed; only what the sandbox planted is ignored.
  assert.equal(calls.recovery?.branch, "factory/issue-4");
  assert.deepEqual(calls.unpushed, ["b.txt"]);
  assert.equal(calls.committed, "more");
  const observed = ran(marker);
  for (const name of planted) assert.ok(!observed.has(name), name);
});

test("host Git refuses a run clone's local, SSH, Git and command transports", async (t) => {
  const { clone, upstream } = await plantedClone(t);
  const git = gitWith(hostGitEnvironment(base));
  for (const remote of [
    upstream,
    "ssh://planted.invalid/repository.git",
    "git://planted.invalid/repository.git",
    "ext::true",
  ])
    assert.match(
      await git(clone, ["ls-remote", remote]),
      /transport '\w+' not allowed/,
      remote,
    );
});

test("host Git keeps the environment's own command-line configuration and never prompts", async (t) => {
  const environment = hostGitEnvironment({
    ...base,
    GIT_TERMINAL_PROMPT: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "fixture.kept",
    GIT_CONFIG_VALUE_0: "yes",
  });
  assert.equal(environment.GIT_TERMINAL_PROMPT, "0");
  const git = gitWith(environment);
  const root = directory(t);
  assert.equal((await git(root, ["config", "fixture.kept"])).trim(), "yes");
  assert.equal(
    (await git(root, ["config", "core.hooksPath"])).trim(),
    "/dev/null",
  );
  assert.throws(
    () => hostGitEnvironment({ GIT_CONFIG_COUNT: "many" }),
    /GIT_CONFIG_COUNT/,
  );
});

test("every Git the host starts, its own and Sandcastle's, inherits the host's settings", () => {
  const source = resolve(import.meta.dirname, "../src");
  for (const file of readdirSync(source, {
    recursive: true,
    encoding: "utf8",
  }).filter((file) => file.endsWith(".ts") && file !== "main.ts"))
    assert.doesNotMatch(
      readFileSync(join(source, file), "utf8"),
      /\bexec\w*\(\s*"git"|\bspawn\w*\(\s*"git"/,
      file,
    );
  const main = readFileSync(join(source, "main.ts"), "utf8");
  // Applied before the host starts, with every Git started through `run`.
  const applied = main.indexOf(
    "Object.assign(process.env, hostGitEnvironment(process.env));",
  );
  assert.ok(applied > 0);
  assert.ok(applied < main.indexOf("createHost("));
  assert.match(main, /env: \{ \.\.\.process\.env, FACTORY_GITHUB_TOKEN/);
});
