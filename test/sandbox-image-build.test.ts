import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  pruneSandboxCache,
  retainSandboxImages,
} from "../src/image-retention.ts";
import {
  AGENT_LAYER_VERSION,
  buildSandboxImage,
  docker,
  sandboxBuilder,
  sandboxImageTag,
  stopSandboxes,
} from "../src/sandbox-image.ts";

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
  "an altered amd64 digest fails at Git's checksum and tags no image",
  { skip: !dockerAvailable, timeout: 900_000 },
  (t) => {
    const image = `factory-digest-mismatch:${randomUUID()}`;
    t.after(() => spawnSync("docker", ["image", "rm", "--force", image]));
    const layer = readFileSync(
      new URL("../src/agent-layer.Dockerfile", import.meta.url),
      "utf8",
    );
    const altered = layer.replace(
      /git_sha256_amd64=[0-9a-f]{64};/,
      `git_sha256_amd64=${"0".repeat(64)};`,
    );
    assert.notEqual(altered, layer, "the test alters the Git amd64 pin");
    const build = spawnSync(
      "docker",
      [
        "build",
        "--platform",
        "linux/amd64",
        "--progress",
        "plain",
        "--tag",
        image,
        "--build-arg",
        "TOOLCHAIN_IMAGE=debian:bookworm-slim",
        "--build-arg",
        "AGENT_UID=2345",
        "--build-arg",
        "AGENT_GID=3456",
        "-",
      ],
      {
        input: altered,
        encoding: "utf8",
        timeout: 840_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    assert.ifError(build.error);
    assert.notEqual(build.status, 0, "the image build must fail");
    assert.match(
      build.stdout + build.stderr,
      /\/tmp\/factory-tools\/git.tar.gz: FAILED/,
    );
    assert.match(
      build.stdout + build.stderr,
      /computed checksum did NOT match/,
    );
    const inspect = spawnSync("docker", ["image", "inspect", image], {
      encoding: "utf8",
    });
    assert.ifError(inspect.error);
    assert.notEqual(
      inspect.status,
      0,
      "the failed build must not tag an image",
    );
  },
);

// Asserts the image's provider policy as agent: Codex's apps stay off whatever
// the agent configures or passes, and agent can read but not change or replace
// either policy file.
function assertProviderPolicy(image: string): void {
  const asAgent = (script: string) =>
    execFileSync(
      "docker",
      ["run", "--rm", "--entrypoint", "sh", image, "-ec", script],
      { encoding: "utf8", timeout: 60_000 },
    );
  const assertPinned = (list: string) => {
    // Each row is the feature, its stage and its effective value.
    const values = new Map(
      list
        .split("\n")
        .map((row) => row.trim().split(/\s+/))
        .filter((columns) => columns.length >= 3)
        .map((columns) => [columns[0], columns.at(-1)]),
    );
    // A Codex pin that renames apps fails here instead of passing silently.
    assert.equal(values.get("apps"), "false", "Codex lists apps as false");
    for (const feature of ["enable_mcp_apps", "codex_apps_mcp_2026_07_28"])
      if (values.has(feature)) assert.equal(values.get(feature), "false");
  };
  const [defaults, overridden] = asAgent(
    "codex features list; echo ---; mkdir -p ~/.codex; " +
      "printf '%s\\n' '[features]' 'apps = true' 'enable_mcp_apps = true' " +
      "'codex_apps_mcp_2026_07_28 = true' > ~/.codex/config.toml; " +
      "codex -c features.apps=true --enable apps features list",
  ).split("\n---\n");
  assertPinned(defaults!);
  assertPinned(overridden!);
  // Under `sh -e` a command negated with `!` never stops the script, so each
  // refused change exits explicitly when it succeeds.
  asAgent(
    'refused() { if "$@" 2>/dev/null; then echo "agent could: $*" >&2; exit 1; fi; }; ' +
      'test "$(id -un)" = agent; ' +
      'test "$(ls -A /etc/codex)" = requirements.toml; ' +
      'test "$(ls -A /etc/claude-code)" = managed-settings.json; ' +
      "for path in /etc/codex/requirements.toml /etc/claude-code/managed-settings.json; do " +
      'test -r "$path"; test "$(stat -c %U:%G:%a "$path")" = root:root:644; ' +
      'test "$(stat -c %U:%G:%a "${path%/*}")" = root:root:755; ' +
      'refused sh -c \'echo >> "$1"\' sh "$path"; refused rm -f "$path"; ' +
      'refused mv "$path" "$path.moved"; refused mv "${path%/*}" "${path%/*}.moved"; done',
  );
  const settings = JSON.parse(
    asAgent("cat /etc/claude-code/managed-settings.json"),
  );
  assert.equal(settings.disableClaudeAiConnectors, true);
}

// Asserts as agent that Codex finds its code-mode host, without which the
// factory's code-mode-only Codex models have no tools. Codex looks for the host
// beside its own resolved executable and reports code mode before the turn
// reaches the provider, so a provider on a dead loopback port needs no
// credentials; sed ends each run at `turn.started`.
function assertCodeModeHost(image: string): void {
  const asAgent = (script: string) =>
    execFileSync(
      "docker",
      ["run", "--rm", "--entrypoint", "sh", image, "-ec", script],
      { encoding: "utf8", timeout: 120_000 },
    );
  assert.match(
    asAgent(
      'codex=$(readlink -f "$(command -v codex)"); host="${codex%/*}/codex-code-mode-host"; ' +
        'test "$(stat -c "%F %U:%G:%a" "$host")" = "regular file root:root:755"; ' +
        '"$host" --help',
    ),
    /--listen/,
  );
  const startupMessages = (...flags: string[]) => {
    const events = asAgent(
      "timeout 60 codex exec --skip-git-repo-check --json -m gpt-6.1-sol " +
        "-c model_provider=probe -c 'model_providers.probe.name=\"probe\"' " +
        "-c 'model_providers.probe.base_url=\"http://127.0.0.1:9/v1\"' " +
        "-c 'model_providers.probe.wire_api=\"responses\"' " +
        "-c model_providers.probe.request_max_retries=0 " +
        `-c model_providers.probe.stream_max_retries=0 ${flags.join(" ")} ok ` +
        '</dev/null 2>/dev/null | sed \'/"type":"turn.started"/q\'',
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.at(-1)?.type, "turn.started");
    return events.map((event) => event.item?.message ?? event.message ?? "");
  };
  const unavailable = /Code Mode is unavailable/;
  const started = startupMessages();
  assert.equal(
    started.filter((message) => unavailable.test(message)).length,
    0,
    started.join("\n"),
  );
  // The control fails if Codex renames the message or the model stops being
  // code-mode-only, which would let the check above pass silently.
  assert.ok(
    startupMessages("-c features.code_mode_host=false").some((message) =>
      unavailable.test(message),
    ),
  );
}

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
    assertProviderPolicy(image);
    assertCodeModeHost(image);
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
  "a default build starts from a base image only the local daemon has",
  { skip: !dockerAvailable, timeout: 900_000 },
  async (t) => {
    const base = `factory-local-base:${randomUUID()}`;
    execFileSync("docker", ["pull", "--quiet", "debian:bookworm-slim"]);
    execFileSync("docker", ["tag", "debian:bookworm-slim", base]);
    const dockerfile = `FROM ${base}\n`;
    const image = sandboxImageTag(dockerfile, AGENT_LAYER_VERSION);
    t.after(() =>
      spawnSync("docker", ["image", "rm", image, `${image}-toolchain`, base]),
    );
    // The factory builder pulls base images itself, so it can't find one.
    await assert.rejects(
      buildSandboxImage({
        dockerfile,
        uid: 2345,
        gid: 3456,
        builder: "factory",
      }),
      /factory-local-base/,
    );
    assert.equal(
      await buildSandboxImage({ dockerfile, uid: 2345, gid: 3456 }),
      image,
    );
    assert.equal(
      execFileSync(
        "docker",
        ["run", "--rm", "--entrypoint", "id", image, "-u"],
        { encoding: "utf8", timeout: 60_000 },
      ).trim(),
      "2345",
    );
  },
);

test(
  "an opted-in host builds both images in the factory builder and prunes only its cache",
  { skip: !dockerAvailable, timeout: 900_000 },
  async (t) => {
    const dockerfile =
      'FROM debian:bookworm-slim\nLABEL factory.test.builder="factory"\n';
    const image = await buildSandboxImage({
      dockerfile,
      uid: 2345,
      gid: 3456,
      builder: "factory",
    });
    t.after(() =>
      execFileSync("docker", ["image", "rm", image, `${image}-toolchain`]),
    );
    assert.equal(
      execFileSync(
        "docker",
        ["run", "--rm", "--entrypoint", "sh", image, "-ec", "id -u; id -g"],
        { encoding: "utf8", timeout: 60_000 },
      ),
      "2345\n3456\n",
    );
    // The image the factory builder loaded is reused by either builder.
    for (const builder of ["factory", "daemon"] as const)
      assert.equal(
        await buildSandboxImage({ dockerfile, uid: 2345, gid: 3456, builder }),
        image,
      );
    // The build ran in the factory's own builder, whose cache is the only one
    // retention prunes; none of it is a day old yet, and a host back on the
    // daemon's builder prunes none of it.
    assert.match(
      execFileSync("docker", ["buildx", "inspect", sandboxBuilder], {
        encoding: "utf8",
      }),
      /Driver:\s+docker-container/,
    );
    const usage = () =>
      execFileSync("docker", ["buildx", "du", "--builder", sandboxBuilder], {
        encoding: "utf8",
      });
    assert.match(usage(), /^Total:\s+(?!0B\s*$)/m);
    const prune = (builder: "daemon" | "factory", hours: number) =>
      pruneSandboxCache((args) => docker(args), { builder, hours });
    assert.equal(await prune("factory", 24), null);
    const before = /^Total:.*$/m.exec(usage())?.[0];
    assert.equal(await prune("daemon", 1), null);
    assert.equal(/^Total:.*$/m.exec(usage())?.[0], before);
  },
);

for (const major of [24, 26]) {
  test(
    `the factory layer replaces node's UID 1000 and reuses its GID on node:${major}-bookworm`,
    {
      skip: !dockerAvailable,
      timeout: 900_000,
    },
    async (t) => {
      const image = await buildSandboxImage({
        // The toolchain's own policy files, which the factory layer replaces.
        dockerfile:
          `FROM node:${major}-bookworm\n` +
          "RUN mkdir -p /etc/codex /etc/claude-code/managed-settings.d && " +
          "printf '[features]\\napps = true\\n' > /etc/codex/requirements.toml && " +
          "echo '{' > /etc/claude-code/managed-settings.d/toolchain.json && " +
          "chown -R node /etc/codex /etc/claude-code\n" +
          "USER node\n",
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
      assert.match(output, new RegExp(`^v${major}\\.`, "m"));
      assertProviderPolicy(image);
      assertCodeModeHost(image);
    },
  );
}

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

test(
  "retention removes an obsolete pair by its tags, keeping aliases and pairs containers use",
  { skip: !dockerAvailable, timeout: 300_000 },
  async (t) => {
    const run = (args: string[], input?: string) =>
      execFileSync("docker", args, { encoding: "utf8", input }).trim();
    const unique = randomUUID();
    const hash = (name: string) =>
      createHash("sha256").update(`${unique}${name}`).digest("hex");
    const pairs = {
      current: hash("current"),
      used: hash("used"),
      old: hash("old"),
    };
    const tags = Object.values(pairs).flatMap((pair) => [
      `factory-sandbox:${pair}`,
      `factory-sandbox:${pair}-toolchain`,
    ]);
    const alias = `factory-retention-alias:${unique}`;
    let container = "";
    t.after(() => {
      if (container) spawnSync("docker", ["rm", "--force", container]);
      spawnSync("docker", ["image", "rm", ...tags, alias]);
    });
    for (const tag of tags)
      run(
        ["build", "--quiet", "--tag", tag, "-"],
        `FROM debian:bookworm-slim\nLABEL factory.retention.test="${unique} ${tag}"\n`,
      );
    run(["tag", `factory-sandbox:${pairs.old}`, alias]);
    container = run(["create", `factory-sandbox:${pairs.used}`]);
    // Pairs other tests left keep their place as current ones.
    const others = run(["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"])
      .split("\n")
      .filter(
        (tag) => tag.startsWith("factory-sandbox:") && !tags.includes(tag),
      );
    const before = run(["image", "inspect", "--format", "{{.Id}}", alias]);
    const result = await retainSandboxImages((args) => docker(args), {
      repositories: [],
      current: [`factory-sandbox:${pairs.current}`, ...others],
      running: [],
      obsoletePairs: 0,
    });
    assert.deepEqual(result, {
      removed: [
        `factory-sandbox:${pairs.old}`,
        `factory-sandbox:${pairs.old}-toolchain`,
      ],
      problems: [],
    });
    assert.equal(
      run(["image", "inspect", "--format", "{{.Id}}", alias]),
      before,
    );
    for (const pair of [pairs.current, pairs.used])
      run([
        "image",
        "inspect",
        `factory-sandbox:${pair}`,
        `factory-sandbox:${pair}-toolchain`,
      ]);
    // Without --force the daemon itself refuses an image a stopped container
    // uses, which guards a container created after retention's inventory.
    const refused = spawnSync(
      "docker",
      ["image", "rm", `factory-sandbox:${pairs.used}`],
      { encoding: "utf8" },
    );
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /must force|is using its referenced image/);
  },
);
