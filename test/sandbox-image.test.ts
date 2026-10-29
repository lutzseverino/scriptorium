import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  AGENT_LAYER_VERSION,
  buildkitImage,
  buildSandboxImage,
  sandboxImageTag,
  type DockerRun,
  type ImageBuilder,
} from "../src/sandbox-image.ts";

test("sandbox image tags change only with the repository Dockerfile or agent layer version", () => {
  const dockerfile = "FROM debian:bookworm-slim\n";
  const tag = sandboxImageTag(dockerfile, "1");
  assert.match(tag, /^factory-sandbox:[a-f0-9]{64}$/);
  assert.equal(sandboxImageTag(dockerfile, "1"), tag);
  assert.notEqual(
    sandboxImageTag(`${dockerfile}RUN apt-get update\n`, "1"),
    tag,
  );
  assert.notEqual(sandboxImageTag(dockerfile, "2"), tag);
  assert.notEqual(sandboxImageTag("ab", "c"), sandboxImageTag("a", "bc"));
});

// Builds against a fake Docker CLI that records each command. `identity` is
// the label an existing image of the tag carries, if any, and
// `factoryBuilder` whether the factory builder exists. A bake's files are read while it runs,
// since the build removes them afterwards.
async function build({
  builder,
  identity,
  factoryBuilder = false,
  uid = 2345,
  gid = 3456,
}: {
  builder?: ImageBuilder;
  identity?: string;
  factoryBuilder?: boolean;
  uid?: number;
  gid?: number;
}) {
  const dockerfile = "FROM debian:bookworm-slim\n";
  const calls: { args: string[]; input?: string }[] = [];
  const baked: { context: string[]; bake: unknown; dockerfiles: string[] }[] =
    [];
  const run: DockerRun = async (args, { cwd, input } = {}) => {
    calls.push({ args, ...(input !== undefined && { input }) });
    const command = args.slice(0, 2).join(" ");
    if (command === "image inspect") {
      if (identity === undefined) throw new Error("Error: No such image");
      return `${identity}\n`;
    }
    if (command === "buildx inspect") {
      if (!factoryBuilder)
        throw new Error('ERROR: no builder "factory-sandbox" found');
      return "Name: factory-sandbox\nDriver: docker-container\n";
    }
    if (command === "buildx bake") {
      baked.push({
        context: readdirSync(join(cwd!, "context")),
        bake: JSON.parse(readFileSync(join(cwd!, "bake.json"), "utf8")),
        dockerfiles: ["toolchain", "agent"].map((name) =>
          readFileSync(join(cwd!, `${name}.Dockerfile`), "utf8"),
        ),
      });
    }
    return "";
  };
  const image = await buildSandboxImage(
    { dockerfile, uid, gid, ...(builder && { builder }) },
    run,
  );
  return { dockerfile, image, calls, baked };
}

const layer = readFileSync(
  new URL("../src/agent-layer.Dockerfile", import.meta.url),
  "utf8",
);

test("by default the daemon's own builder builds both images from stdin, never touching the factory builder", async () => {
  for (const builder of [undefined, "daemon"] as const)
    for (const factoryBuilder of [false, true]) {
      const { dockerfile, image, calls, baked } = await build({
        builder,
        factoryBuilder,
      });
      assert.equal(image, sandboxImageTag(dockerfile, AGENT_LAYER_VERSION));
      assert.deepEqual(baked, []);
      assert.deepEqual(calls.slice(1), [
        {
          args: ["build", "--tag", `${image}-toolchain`, "-"],
          input: dockerfile,
        },
        {
          args: [
            "build",
            "--tag",
            image,
            "--build-arg",
            `TOOLCHAIN_IMAGE=${image}-toolchain`,
            "--build-arg",
            "AGENT_UID=2345",
            "--build-arg",
            "AGENT_GID=3456",
            "-",
          ],
          input: layer,
        },
      ]);
    }
});

test("an opted-in host bakes both images in the factory builder from an empty context", async () => {
  const absent = await build({ builder: "factory" });
  const { dockerfile, image } = absent;
  assert.equal(image, sandboxImageTag(dockerfile, AGENT_LAYER_VERSION));
  assert.deepEqual(
    absent.calls.slice(1).map(({ args }) => args.slice(0, 2).join(" ")),
    ["buildx inspect", "buildx create", "buildx bake"],
  );
  assert.deepEqual(absent.calls[2]!.args, [
    "buildx",
    "create",
    "--name",
    "factory-sandbox",
    "--driver",
    "docker-container",
    "--driver-opt",
    `image=${buildkitImage}`,
  ]);
  assert.deepEqual(absent.calls[3]!.args, [
    "buildx",
    "bake",
    "--builder",
    "factory-sandbox",
    "--file",
    "bake.json",
    "--load",
    "toolchain",
    "agent",
  ]);
  const [baked] = absent.baked;
  assert.deepEqual(baked!.context, []);
  assert.deepEqual(baked!.dockerfiles, [dockerfile, layer]);
  const { toolchain, agent } = (
    baked!.bake as { target: Record<string, Record<string, unknown>> }
  ).target;
  assert.deepEqual(toolchain!.tags, [`${image}-toolchain`]);
  assert.deepEqual(agent!.tags, [image]);
  assert.deepEqual(agent!.contexts, {
    "factory-toolchain": "target:toolchain",
  });
  assert.deepEqual(agent!.args, {
    TOOLCHAIN_IMAGE: "factory-toolchain",
    AGENT_UID: "2345",
    AGENT_GID: "3456",
  });

  const present = await build({ builder: "factory", factoryBuilder: true });
  assert.deepEqual(
    present.calls.slice(1).map(({ args }) => args.slice(0, 2).join(" ")),
    ["buildx inspect", "buildx bake"],
  );
});

test("either builder reuses an image built for the host's identity and rebuilds its tag for another", async () => {
  for (const builder of ["daemon", "factory"] as const) {
    const reused = await build({ builder, identity: "2345:3456" });
    assert.deepEqual(
      reused.calls.map(({ args }) => args.slice(0, 2).join(" ")),
      ["image inspect"],
    );
    const rebuilt = await build({
      builder,
      identity: "1000:1000",
      factoryBuilder: true,
    });
    assert.equal(rebuilt.image, reused.image);
    assert.ok(
      rebuilt.calls.some(({ args }) =>
        builder === "daemon" ? args[0] === "build" : args[1] === "bake",
      ),
    );
  }
  for (const [uid, gid] of [
    [0, 1000],
    [1000, 1.5],
  ])
    await assert.rejects(
      build({ uid, gid }),
      /UID and GID must be positive integers/,
    );
});

test("storage admission gates every expanding build and still permits existing-image reuse", async () => {
  const { createImageStorage, ImageStorageHold } =
    await import("../src/image-storage.ts");
  for (const builder of ["daemon", "factory"] as const) {
    for (const existing of [false, true]) {
      let availableBytes = 14;
      const builds: string[] = [];
      const storage = createImageStorage(
        { storePaths: ["/store"], reserveBytes: 15, resumeBytes: 17 },
        {
          observe: async () => [
            { paths: ["/store"], filesystem: "dev:1", availableBytes },
          ],
          reclaim: async () => null,
          now: () => new Date(),
        },
      );
      const run: DockerRun = async (args) => {
        if (args[0] === "image") return existing ? "1000:1000" : "";
        if (args[0] === "build" || args[1] === "bake") {
          builds.push(args[0]);
          availableBytes = 14;
        }
        return "";
      };
      const build = () =>
        buildSandboxImage(
          { dockerfile: "FROM base", uid: 1000, gid: 1000, builder, storage },
          run,
        );
      if (existing) await build();
      else await assert.rejects(build(), ImageStorageHold);
      assert.deepEqual(builds, []);
      availableBytes = 17;
      if (existing) await build();
      else await assert.rejects(build(), ImageStorageHold); // toolchain consumed reserve; agent must wait
      assert.equal(builds.length, existing ? 0 : 1);
    }
  }
});

test("factory builds recheck pressure after builder setup and before bake starts", async () => {
  const { createImageStorage, ImageStorageHold } =
    await import("../src/image-storage.ts");
  let availableBytes = 18;
  const storage = createImageStorage(
    { storePaths: ["/store"], reserveBytes: 15, resumeBytes: 17 },
    {
      observe: async () => [
        { paths: ["/store"], filesystem: "dev:1", availableBytes },
      ],
      reclaim: async () => null,
      now: () => new Date(),
    },
  );
  const calls: string[][] = [];
  await assert.rejects(
    buildSandboxImage(
      {
        dockerfile: "FROM base",
        uid: 1000,
        gid: 1000,
        builder: "factory",
        storage,
      },
      async (args) => {
        calls.push(args);
        if (args[1] === "inspect" && args[0] === "buildx") availableBytes = 14;
        return "";
      },
    ),
    ImageStorageHold,
  );
  assert.equal(
    calls.some((args) => args[1] === "bake"),
    false,
  );
});

test("an admitted factory pair builds toolchain and agent targets under separate fresh admissions", async () => {
  const { createImageStorage } = await import("../src/image-storage.ts");
  const targets: string[][] = [];
  let observations = 0;
  const storage = createImageStorage(
    { storePaths: ["/store"], reserveBytes: 15, resumeBytes: 17 },
    {
      observe: async () => {
        observations++;
        return [{ paths: ["/store"], filesystem: "dev:1", availableBytes: 18 }];
      },
      reclaim: async () => null,
      now: () => new Date(),
    },
  );
  const beforeBuild: number[] = [];
  await buildSandboxImage(
    {
      dockerfile: "FROM base",
      uid: 1000,
      gid: 1000,
      builder: "factory",
      storage,
    },
    async (args) => {
      if (args[1] === "bake") {
        targets.push(args.slice(args.indexOf("--load") + 1));
        beforeBuild.push(observations);
      }
      return "";
    },
  );
  assert.deepEqual(targets, [["toolchain"], ["agent"]]);
  assert.equal(beforeBuild.length, 2);
  assert.ok(
    beforeBuild[1] > beforeBuild[0],
    "agent target requires a new filesystem observation",
  );
});
