import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  githubTokens,
  sandboxEnvironment,
  tokenCommand,
  writeSandboxToken,
} from "../src/github-token.ts";
import { createRedactor } from "../src/redaction.ts";
import { directory } from "./fakes.ts";

// A token command that prints what its script says for the repository.
function command(t: Parameters<typeof directory>[0], script: string) {
  const path = join(directory(t), "token");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("the token command runs with <owner>/<name> appended and prints the token", async (t) => {
  const path = command(t, 'echo "ghs_$2_$(echo "$1" | tr / _)"');
  assert.equal(
    await tokenCommand([path, "app"])("acme/widgets"),
    "ghs_acme/widgets_app",
  );
});

test("a failing or empty token command is refused without its output", async (t) => {
  await assert.rejects(
    tokenCommand([command(t, "echo ghs_secret; exit 3")])("acme/widgets"),
    { message: "the token command for acme/widgets failed with 3" },
  );
  await assert.rejects(tokenCommand([command(t, "echo")])("acme/widgets"), {
    message: "the token command for acme/widgets printed no single token",
  });
  await assert.rejects(
    tokenCommand([command(t, "echo one two")])("acme/widgets"),
    { message: "the token command for acme/widgets printed no single token" },
  );
});

// The token cache over a command that prints the next of `printed`, or
// fails once it has none left.
function cache(printed: string[]) {
  const runs: string[] = [];
  const clock = { now: new Date("2026-10-09T12:00:00Z") };
  const redactor = createRedactor();
  const tokens = githubTokens(
    async (repository) => {
      runs.push(repository);
      const token = printed.shift();
      if (!token) throw new Error(`the token command for ${repository} failed`);
      return token;
    },
    () => clock.now,
    redactor,
  );
  return { tokens, runs, clock, redactor };
}

test("a repository's token is reused for 30 minutes, then the command runs again", async () => {
  const { tokens, runs, clock } = cache(["ghs_one", "ghs_two", "ghs_three"]);
  assert.equal(await tokens.get("acme/widgets"), "ghs_one");
  clock.now = new Date("2026-10-09T12:29:59.999Z");
  assert.equal(await tokens.get("acme/widgets"), "ghs_one");
  assert.equal(await tokens.get("acme/gadgets"), "ghs_two");
  clock.now = new Date("2026-10-09T12:30:00Z");
  assert.equal(await tokens.get("acme/widgets"), "ghs_three");
  assert.deepEqual(runs, ["acme/widgets", "acme/gadgets", "acme/widgets"]);
});

test("concurrent requests share one run of the command", async () => {
  const { tokens, runs } = cache(["ghs_one", "ghs_two"]);
  assert.deepEqual(
    await Promise.all([tokens.get("acme/widgets"), tokens.get("acme/widgets")]),
    ["ghs_one", "ghs_one"],
  );
  assert.deepEqual(runs, ["acme/widgets"]);
});

test("a failed refresh caches nothing, so the next request runs the command again", async () => {
  const { tokens, runs, clock } = cache(["ghs_one"]);
  await tokens.get("acme/widgets");
  clock.now = new Date("2026-10-09T12:30:00Z");
  await assert.rejects(tokens.get("acme/widgets"), {
    message: "the token command for acme/widgets failed",
  });
  await assert.rejects(tokens.get("acme/widgets"));
  assert.deepEqual(runs, ["acme/widgets", "acme/widgets", "acme/widgets"]);
});

test("every token the command prints stays redacted after it is replaced", async () => {
  const { tokens, clock, redactor } = cache(["ghs_one", "ghs_two"]);
  await tokens.get("acme/widgets");
  clock.now = new Date("2026-10-09T12:30:00Z");
  await tokens.get("acme/widgets");
  assert.equal(
    redactor.redact("ghs_one then ghs_two"),
    "<REDACTED> then <REDACTED>",
  );
});

test("the sandbox's token file is private to the host's user, mounted read-only, and replaced whole", async (t) => {
  const tokens = join(directory(t), "issue-4");
  mkdirSync(tokens, { mode: 0o700 });
  assert.deepEqual(await writeSandboxToken(tokens, "ghs_token"), {
    hostPath: tokens,
    sandboxPath: "/run/factory/github",
    readonly: true,
  });
  for (const file of ["config.yml", "hosts.yml"])
    assert.equal(statSync(join(tokens, file)).mode & 0o777, 0o600);
  const before = statSync(join(tokens, "hosts.yml")).ino;
  await writeSandboxToken(tokens, "ghs_refreshed");
  const hosts = readFileSync(join(tokens, "hosts.yml"), "utf8");
  assert.match(hosts, /oauth_token: "ghs_refreshed"/);
  assert.doesNotMatch(hosts, /ghs_token/);
  assert.notEqual(statSync(join(tokens, "hosts.yml")).ino, before);
  assert.deepEqual(readdirSync(tokens).sort(), ["config.yml", "hosts.yml"]);
});

const gh = spawnSync("gh", ["--version"]).status === 0;

test(
  "the sandbox's GitHub CLI and Git read the token from the file",
  { skip: !gh && "the GitHub CLI is not installed" },
  async (t) => {
    const home = directory(t);
    const tokens = join(home, "github");
    mkdirSync(tokens, { mode: 0o700 });
    await writeSandboxToken(tokens, "ghs_from_file");
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...sandboxEnvironment,
      GH_CONFIG_DIR: tokens,
    };
    // The mount is read-only, so the GitHub CLI must not write to it.
    chmodSync(tokens, 0o500);
    try {
      assert.equal(
        execFileSync("gh", ["auth", "token"], { env, encoding: "utf8" }).trim(),
        "ghs_from_file",
      );
      assert.match(
        execFileSync("git", ["credential", "fill"], {
          env,
          encoding: "utf8",
          input: "protocol=https\nhost=github.com\npath=acme/widgets.git\n\n",
        }),
        /^password=ghs_from_file$/m,
      );
    } finally {
      chmodSync(tokens, 0o700);
    }
  },
);
