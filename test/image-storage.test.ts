import assert from "node:assert/strict";
import { test } from "node:test";
import { createImageStorage, ImageStorageHold } from "../src/image-storage.ts";

const GiB = 1073741824;
const policy = {
  storePaths: ["/actual/containerd"],
  reserveBytes: 15 * GiB,
  resumeBytes: 17 * GiB,
};
const at = "2026-10-29T14:00:00.000Z";

test("pressure holds below reserve and recovery, including equality and a fresh post-reclamation reading", async () => {
  let availableBytes = 15 * GiB;
  let reclaimed = 0;
  const storage = createImageStorage(policy, {
    observe: async () => [
      { paths: policy.storePaths, filesystem: "device:7", availableBytes },
    ],
    reclaim: async () => {
      reclaimed++;
      return null;
    },
    now: () => new Date(at),
  });
  const admit = () =>
    storage.run(async (check) => {
      await check();
      return "built";
    });
  assert.equal(await admit(), "built");
  availableBytes--;
  await assert.rejects(admit(), ImageStorageHold);
  assert.equal(storage.status()?.held, true);
  assert.equal(storage.status()?.resumeBytes, 17 * GiB);
  assert.equal(storage.status()?.observedAt, at);
  assert.equal(storage.status()?.filesystems[0].filesystem, "device:7");
  availableBytes = 16 * GiB;
  await assert.rejects(admit(), ImageStorageHold);
  availableBytes = 17 * GiB;
  assert.equal(await admit(), "built");
  assert.equal(storage.status()?.held, false);
  assert.equal(reclaimed, 4);
});

test("unknown, incomplete and invalid observations fail closed without pruning", async () => {
  for (const observation of [
    [],
    [{ paths: ["/wrong"], filesystem: "dev:1", availableBytes: 100 * GiB }],
    [{ paths: policy.storePaths, filesystem: "", availableBytes: 100 * GiB }],
    ...[NaN, Infinity, -1, 1.5].map((availableBytes) => [
      { paths: policy.storePaths, filesystem: "dev:1", availableBytes },
    ]),
    new Error("statfs unavailable"),
  ]) {
    let prunes = 0;
    const storage = createImageStorage(policy, {
      observe: async () => {
        if (observation instanceof Error) throw observation;
        return observation;
      },
      reclaim: async () => {
        prunes++;
        return null;
      },
      now: () => new Date(at),
    });
    await assert.rejects(
      storage.run((check) => check()),
      ImageStorageHold,
    );
    assert.equal(prunes, 0);
    assert.match(storage.status()!.reason!, /observation|unavailable/);
  }
});

test("pressure reclamation must recover every constrained filesystem and pruning failure holds", async () => {
  const configured = { ...policy, cachePath: "/builder/cache" };
  let available = [14 * GiB, 18 * GiB];
  let failure: Error | null = null;
  let recovered = [16 * GiB, 18 * GiB];
  const pressure: boolean[] = [];
  const storage = createImageStorage(configured, {
    observe: async () => [
      {
        paths: policy.storePaths,
        filesystem: "image-device",
        availableBytes: available[0],
      },
      {
        paths: [configured.cachePath],
        filesystem: "cache-device",
        availableBytes: available[1],
      },
    ],
    reclaim: async (low) => {
      pressure.push(low);
      if (failure) throw failure;
      available = recovered;
      return "2GiB";
    },
    now: () => new Date(at),
  });
  await assert.rejects(
    storage.run((check) => check()),
    ImageStorageHold,
  );
  assert.equal(storage.status()?.reclamation.freed, "2GiB");
  recovered = [18 * GiB, 16 * GiB];
  await assert.rejects(
    storage.run((check) => check()),
    ImageStorageHold,
  );
  recovered = [17 * GiB, 17 * GiB];
  await storage.run((check) => check());
  failure = new Error("prune failed");
  await assert.rejects(
    storage.run((check) => check()),
    ImageStorageHold,
  );
  assert.equal(storage.status()?.reclamation.error, "Error: prune failed");
  assert.deepEqual(pressure, [true, true, true, false]);
});

test("concurrent image preparations and maintenance serialize; later builds observe new pressure", async () => {
  let availableBytes = 18 * GiB;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const storage = createImageStorage(policy, {
    observe: async () => {
      events.push("observe");
      return [
        { paths: policy.storePaths, filesystem: "dev:1", availableBytes },
      ];
    },
    reclaim: async () => {
      events.push("prune");
      return null;
    },
    now: () => new Date(at),
  });
  const first = storage.run(async (check) => {
    await check();
    events.push("first");
    await gate;
    availableBytes = 14 * GiB;
  });
  const second = storage.run(async (check) => {
    await check();
    events.push("second");
  });
  const failed = assert.rejects(second, ImageStorageHold);
  const maintenance = storage.maintain();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["observe", "prune", "observe", "first"]);
  release();
  await Promise.all([first, failed, maintenance]);
  assert.deepEqual(events, [
    "observe",
    "prune",
    "observe",
    "first",
    "observe",
    "prune",
    "observe",
    "prune",
  ]);
});

test("observations use explicit stores, deduplicate filesystem aliases and reject remote Docker", async () => {
  const { observeImageStorage } = await import("../src/image-storage.ts");
  const measured: string[] = [];
  const filesystem = async (path: string) => {
    measured.push(path);
    return {
      filesystem: path.startsWith("/cache")
        ? "cache-device"
        : "containerd-device",
      availableBytes: 18 * GiB,
    };
  };
  const run = async () => "unix:///var/run/docker.sock";
  const paths = ["/actual/containerd", "/alias/containerd", "/cache/buildkit"];
  assert.deepEqual(
    await observeImageStorage(paths, { run, filesystem, environment: {} }),
    [
      {
        paths: paths.slice(0, 2),
        filesystem: "containerd-device",
        availableBytes: 18 * GiB,
      },
      {
        paths: paths.slice(2),
        filesystem: "cache-device",
        availableBytes: 18 * GiB,
      },
    ],
  );
  assert.deepEqual(measured, paths);
  measured.length = 0;
  for (const endpoint of ["ssh://remote", "tcp://localhost:2375", ""]) {
    await assert.rejects(
      observeImageStorage(paths, {
        run: async () => endpoint,
        filesystem,
        environment: {},
      }),
      /local.*Docker/,
    );
    assert.deepEqual(measured, []);
  }
  await assert.rejects(
    observeImageStorage(paths, {
      run,
      filesystem,
      environment: { DOCKER_HOST: "ssh://remote" },
    }),
    /local.*Docker/,
  );
  // DOCKER_CONTEXT takes precedence over DOCKER_HOST, as in the Docker CLI.
  await observeImageStorage(paths, {
    run,
    filesystem,
    environment: { DOCKER_CONTEXT: "local", DOCKER_HOST: "ssh://unused" },
  });
});

test("real filesystem observations follow store aliases and reject missing paths and ordinary files", async (t) => {
  const { observeImageStorage } = await import("../src/image-storage.ts");
  const { directory } = await import("./fakes.ts");
  const { symlink, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const root = directory(t);
  const alias = join(root, "alias");
  await symlink(root, alias);
  const ports = {
    run: async () => "unix:///var/run/docker.sock",
    environment: {},
  };
  const result = await observeImageStorage([root, alias], ports);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].paths, [root, alias]);
  assert.match(result[0].filesystem, /^device:/);
  assert.ok(Number.isSafeInteger(result[0].availableBytes));
  await assert.rejects(
    observeImageStorage([join(root, "missing")], ports),
    /ENOENT/,
  );
  const file = join(root, "file");
  await writeFile(file, "x");
  await assert.rejects(observeImageStorage([file], ports), /directory/);
});

test("factory storage observation rejects remote, multiple or unresolved builder nodes", async () => {
  const { observeImageStorage } = await import("../src/image-storage.ts");
  for (const selected of [
    { Driver: "docker-container", Nodes: [{ Endpoint: "ssh://remote" }] },
    { Driver: "remote", Nodes: [{ Endpoint: "unix:///var/run/docker.sock" }] },
    { Driver: "docker-container", Nodes: [] },
    { Driver: "docker-container", Nodes: [{ Endpoint: "unix:///other.sock" }] },
  ]) {
    await assert.rejects(
      observeImageStorage(["/store"], {
        environment: {},
        builder: "factory",
        run: async (args) =>
          args[0] === "context"
            ? "unix:///var/run/docker.sock"
            : JSON.stringify(selected),
        filesystem: async () => {
          assert.fail("untrusted stores must not be measured");
        },
      }),
    );
  }
  const run = async (args: string[]) => {
    if (args[0] === "context") return "unix:///var/run/docker.sock";
    return JSON.stringify({
      Driver: "docker-container",
      Nodes: [{ Endpoint: "default" }],
    });
  };
  assert.equal(
    (
      await observeImageStorage(["/store"], {
        run,
        environment: {},
        builder: "factory",
        filesystem: async () => ({
          filesystem: "dev:1",
          availableBytes: 18 * GiB,
        }),
      })
    ).length,
    1,
  );
});

test("a configured cache target gates builds even without a filesystem reserve", async () => {
  const storage = createImageStorage(undefined, {
    observe: async () => {
      assert.fail("no storage policy means no filesystem measurements");
    },
    reclaim: async () => {
      throw new Error("factory cache remains above its target");
    },
    checkCache: true,
    now: () => new Date(at),
  });
  await assert.rejects(
    storage.run((check) => check()),
    ImageStorageHold,
  );
  assert.match(storage.status()!.reason!, /cache.*target/);
});

test("a restart retains a storage hold until the configured recovery threshold", async (t) => {
  const { directory } = await import("./fakes.ts");
  const { join } = await import("node:path");
  const statePath = join(directory(t), "storage.json");
  let availableBytes = 14 * GiB;
  const ports = {
    statePath,
    observe: async () => [
      { paths: policy.storePaths, filesystem: "device:7", availableBytes },
    ],
    reclaim: async () => null,
    now: () => new Date(at),
  };
  await assert.rejects(
    createImageStorage(policy, ports).run((check) => check()),
    ImageStorageHold,
  );
  availableBytes = 16 * GiB;
  const restarted = createImageStorage(policy, ports);
  await assert.rejects(
    restarted.run((check) => check()),
    ImageStorageHold,
  );
  availableBytes = 17 * GiB;
  await restarted.run((check) => check());
});
