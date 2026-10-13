import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  removeSandboxToken,
  sandboxEnvironment,
  tokenCommand,
  writeSandboxToken,
} from "../src/github-token.ts";
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

test("the sandbox's token file is private to the host's user and mounted read-only", async (t) => {
  const tokens = join(directory(t), "issue-4");
  mkdirSync(tokens, { mode: 0o700 });
  assert.deepEqual(await writeSandboxToken(tokens, "ghs_token"), {
    hostPath: tokens,
    sandboxPath: "/run/factory/github",
    readonly: true,
  });
  for (const file of ["config.yml", "hosts.yml"])
    assert.equal(statSync(join(tokens, file)).mode & 0o777, 0o600);
  await removeSandboxToken(tokens);
  assert.equal(existsSync(tokens), false);
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
