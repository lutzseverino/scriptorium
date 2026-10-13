import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { buildSandboxImage, stopSandboxes } from "../src/sandbox-image.ts";

let dockerAvailable = false;
try {
  execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
  dockerAvailable = true;
} catch {
  // Local package development can run without a Docker daemon; CI cannot.
}

test(
  "CI has Docker for the sandbox image contract tests",
  {
    skip: !process.env.CI,
  },
  () => {
    assert.ok(dockerAvailable, "CI must build and run the sandbox images");
  },
);

test(
  "the factory layer runs its pinned tools as agent on a minimal Debian image without Node",
  {
    skip: !dockerAvailable,
    timeout: 900_000,
  },
  async (t) => {
    const image = await buildSandboxImage({
      dockerfile: "FROM debian:bookworm-slim\n",
      uid: 2345,
      gid: 3456,
    });
    t.after(() =>
      execFileSync("docker", ["image", "rm", image, `${image}-toolchain`]),
    );
    const output = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        image,
        "-ec",
        'test "$(id -un)" = agent; test "$(id -u)" = 2345; test "$(id -g)" = 3456; ' +
          'test "$HOME" = /home/agent; test -w "$HOME"; ! command -v node; ' +
          "git --version; gh --version; claude --version; codex --version",
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    assert.match(output, /git version 2\.53\.0/);
    assert.match(output, /gh version 2\.102\.0/);
    assert.match(output, /2\.1\.287 \(Claude Code\)/);
    assert.match(output, /codex-cli 0\.162\.1/);
    // The relocatable Git release must find its HTTPS helper, not just print a version.
    assert.match(
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--entrypoint",
          "git",
          image,
          "ls-remote",
          "https://github.com/desktop/dugite-native.git",
          "HEAD",
        ],
        { encoding: "utf8", timeout: 60_000 },
      ),
      /^[a-f0-9]{40}\s+HEAD/m,
    );
    const config = JSON.parse(
      execFileSync("docker", ["image", "inspect", image], {
        encoding: "utf8",
      }),
    )[0].Config;
    assert.equal(config.User, "agent");
    assert.equal(config.WorkingDir, "/home/agent");
    assert.deepEqual(config.Entrypoint, ["sleep", "infinity"]);
    assert.equal(
      await buildSandboxImage({
        dockerfile: "FROM debian:bookworm-slim\n",
        uid: 2345,
        gid: 3456,
      }),
      image,
    );
  },
);

test(
  "the factory layer replaces node's UID 1000 and reuses its GID on node:24-bookworm",
  {
    skip: !dockerAvailable,
    timeout: 900_000,
  },
  async (t) => {
    const image = await buildSandboxImage({
      dockerfile: "FROM node:24-bookworm\nUSER node\n",
      uid: 1000,
      gid: 1000,
    });
    t.after(() =>
      execFileSync("docker", ["image", "rm", image, `${image}-toolchain`]),
    );
    const output = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        image,
        "-ec",
        'test "$(id -un)" = agent; test "$(id -u)" = 1000; test "$(id -g)" = 1000; ' +
          'test "$HOME" = /home/agent; test -w "$HOME"; ' +
          "git --version; gh --version; claude --version; codex --version; node --version",
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    assert.match(output, /git version 2\.53\.0/);
    assert.match(output, /gh version 2\.102\.0/);
    assert.match(output, /2\.1\.287 \(Claude Code\)/);
    assert.match(output, /codex-cli 0\.162\.1/);
    assert.match(output, /v24\./);
  },
);

test(
  "stopping the sandboxes removes every container of a sandbox image and no other",
  {
    skip: !dockerAvailable,
    timeout: 900_000,
  },
  async (t) => {
    const image = await buildSandboxImage({
      dockerfile: "FROM debian:bookworm-slim\n",
      uid: 2345,
      gid: 3456,
    });
    t.after(() =>
      execFileSync("docker", ["image", "rm", image, `${image}-toolchain`]),
    );
    const start = (args: string[]) =>
      execFileSync("docker", ["run", "--detach", ...args], {
        encoding: "utf8",
      }).trim();
    const sandbox = start([image]);
    const stopped = start([image]);
    execFileSync("docker", ["stop", "--time", "0", stopped]);
    const other = start([`${image}-toolchain`, "sleep", "infinity"]);
    try {
      stopSandboxes();
      const remaining = execFileSync(
        "docker",
        ["ps", "--all", "--quiet", "--no-trunc"],
        { encoding: "utf8" },
      ).split("\n");
      assert.equal(remaining.includes(sandbox), false);
      assert.equal(remaining.includes(stopped), false);
      assert.equal(remaining.includes(other), true);
    } finally {
      execFileSync("docker", ["rm", "--force", other]);
    }
  },
);
