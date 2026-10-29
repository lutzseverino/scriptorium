import assert from "node:assert/strict";
import { test } from "node:test";
import {
  legacyImageName,
  pruneSandboxCache,
  retainSandboxImages,
  type Docker,
} from "../src/image-retention.ts";

// Image retention and cache pruning, driven against a fake Docker daemon that
// refuses what the real one refuses and fails on any command retention must
// never run, such as a forced removal or a host-wide prune.

type Image = { id: string; created: string; tags: string[] };

function fakeDocker({
  images,
  containers = [],
  builder = false,
  freed = "2.5GB",
}: {
  images: Image[];
  // Each container's image ID, running or stopped.
  containers?: string[];
  builder?: boolean;
  freed?: string;
}) {
  const calls: string[][] = [];
  // Runs before each command; it may change the daemon or throw.
  let before: (args: string[]) => void = () => {};
  const image = (reference: string) =>
    images.find((candidate) => candidate.tags.includes(reference));
  const docker: Docker = async (args) => {
    calls.push(args);
    before(args);
    const command = args.slice(0, 2).join(" ");
    if (command === "image ls") {
      assert.deepEqual(args, [
        "image",
        "ls",
        "--no-trunc",
        "--format",
        "{{.Repository}}\t{{.Tag}}\t{{.ID}}",
      ]);
      return images
        .flatMap(({ id, tags }) =>
          tags.length === 0
            ? [`<none>\t<none>\t${id}`]
            : tags.map((tag) => {
                const colon = tag.lastIndexOf(":");
                return `${tag.slice(0, colon)}\t${tag.slice(colon + 1)}\t${id}`;
              }),
        )
        .map((line) => `${line}\n`)
        .join("");
    }
    if (command === "image inspect") {
      assert.deepEqual(args.slice(2, 4), ["--format", "{{.Id}}\t{{.Created}}"]);
      return args
        .slice(4)
        .map((id) => {
          const found = images.find((candidate) => candidate.id === id);
          if (!found) throw new Error(`Error: No such image: ${id}`);
          return `${found.id}\t${found.created}\n`;
        })
        .join("");
    }
    if (command === "ps --all") {
      assert.deepEqual(args, ["ps", "--all", "--quiet", "--no-trunc"]);
      return containers.map((_, index) => `container-${index}\n`).join("");
    }
    if (command === "container inspect") {
      assert.deepEqual(args.slice(2, 4), ["--format", "{{.Image}}"]);
      return args
        .slice(4)
        .map((name) => {
          const used = containers[Number(name.slice("container-".length))];
          if (used === undefined)
            throw new Error(`Error: No such container: ${name}`);
          return `${used}\n`;
        })
        .join("");
    }
    if (command === "image rm") {
      assert.equal(args.length, 3, `no option may force a removal: ${args}`);
      const reference = args[2];
      const found = image(reference);
      if (!found) throw new Error(`Error: No such image: ${reference}`);
      // Another tag keeps the image; only this tag goes.
      if (found.tags.length === 1) {
        if (containers.includes(found.id))
          throw new Error(
            `Error response from daemon: conflict: unable to remove repository reference "${reference}" (must force) - container is using its referenced image ${found.id}`,
          );
        images.splice(images.indexOf(found), 1);
      } else found.tags.splice(found.tags.indexOf(reference), 1);
      return `Untagged: ${reference}\n`;
    }
    if (command === "buildx inspect") {
      if (!builder)
        throw new Error('ERROR: no builder "factory-sandbox" found');
      assert.deepEqual(
        args.slice(2).filter((arg) => arg !== "--bootstrap"),
        ["factory-sandbox"],
      );
      return "Name: factory-sandbox\nDriver: docker-container\n";
    }
    if (command === "buildx prune") {
      assert.deepEqual(args, [
        "buildx",
        "prune",
        "--builder",
        "factory-sandbox",
        "--all",
        "--force",
        "--filter",
        "until=24h",
      ]);
      return `ID\tRECLAIMABLE\tSIZE\tLAST ACCESSED\nTotal:\t${freed}\n`;
    }
    assert.fail(`retention never runs docker ${args.join(" ")}`);
  };
  return {
    docker,
    images,
    calls,
    removals: () =>
      calls.filter((args) => args[1] === "rm").map((args) => args[2]),
    tags: () => images.flatMap((image) => image.tags).sort(),
    before(hook: (args: string[]) => void) {
      before = hook;
    },
  };
}

// A hash of `n`, and the image IDs and times of its pair.
const hash = (n: number) => n.toString(16).padStart(64, "0");
const agent = (n: number) => `factory-sandbox:${hash(n)}`;
const toolchain = (n: number) => `${agent(n)}-toolchain`;
const day = (n: number) =>
  `2026-10-${String(n).padStart(2, "0")}T08:00:00.123456789Z`;
const pair = (n: number, created = day(n)): Image[] => [
  {
    id: `sha256:${"a".repeat(62)}${String(n).padStart(2, "0")}`,
    created,
    tags: [agent(n)],
  },
  {
    id: `sha256:${"b".repeat(62)}${String(n).padStart(2, "0")}`,
    created,
    tags: [toolchain(n)],
  },
];
const idOf = (images: Image[], reference: string) =>
  images.find((image) => image.tags.includes(reference))!.id;

const served = ["acme/widgets", "acme/gadgets"];

test("legacy image names match the earlier factory releases' names exactly", () => {
  // The name an earlier release's own test recorded for acme/widgets.
  assert.equal(
    legacyImageName("acme/widgets"),
    "factory-acme-widgets-d782c8744023",
  );
  assert.notEqual(legacyImageName("a-b/c"), legacyImageName("a/b-c"));
  assert.match(
    legacyImageName("Acme/Wid.gets_2"),
    /^factory-acme-wid-gets-2-[0-9a-f]{12}$/,
  );
});

test("every current pair stays, shared or old, with the newest obsolete pairs up to the allowance", async () => {
  const daemon = fakeDocker({
    images: [1, 2, 3, 4, 5, 6, 7].flatMap((n) => pair(n)),
  });
  const result = await retainSandboxImages(daemon.docker, {
    repositories: [...served, "acme/tools"],
    // Two repositories share pair 7; the oldest pair is a third's current one.
    current: [agent(7), agent(7), agent(1)],
    running: [],
    obsoletePairs: 3,
  });
  // Pairs 6, 5 and 4 are the newest obsolete pairs; 3 and 2 go, agent first.
  assert.deepEqual(result, {
    removed: [agent(3), toolchain(3), agent(2), toolchain(2)],
    problems: [],
  });
  assert.deepEqual(
    daemon.tags(),
    [1, 4, 5, 6, 7].flatMap((n) => [agent(n), toolchain(n)]).sort(),
  );
});

test("container and running references keep their pairs beyond the allowance", async () => {
  const images = [1, 2, 3, 4, 5].flatMap((n) => pair(n));
  // A rebuild for another UID and GID moved pair 2's agent tag; the old image
  // stays untagged while a stopped container still uses it.
  const rebuilt = idOf(images, agent(2));
  images.find((image) => image.id === rebuilt)!.tags = [];
  images.push({
    id: `sha256:${"c".repeat(64)}`,
    created: day(20),
    tags: [agent(2)],
  });
  const daemon = fakeDocker({
    images,
    // Pair 1's toolchain is used by a container; the untagged agent too.
    containers: [idOf(images, toolchain(1)), rebuilt],
    builder: true,
  });
  const result = await retainSandboxImages(daemon.docker, {
    repositories: served,
    current: [agent(5)],
    // A run whose sandbox may still be starting uses pair 3.
    running: [agent(3)],
    obsoletePairs: 1,
  });
  // Pairs 1 and 3 exceed the allowance of one by themselves, so even the
  // newest unprotected pair goes.
  assert.deepEqual(result, {
    removed: [agent(2), toolchain(2), agent(4), toolchain(4)],
    problems: [],
  });
  assert.deepEqual(
    daemon.tags(),
    [1, 3, 5].flatMap((n) => [agent(n), toolchain(n)]).sort(),
  );
  assert.ok(
    daemon.images.some((image) => image.id === rebuilt),
    "the untagged image a container uses is never removed",
  );
});

test("only the factory's own tags are candidates; lookalikes, aliases and untagged images stay", async () => {
  const legacy = legacyImageName("acme/widgets");
  const unserved = legacyImageName("acme/retired");
  const lookalikes = [
    "factory-sandbox:abc123",
    `factory-sandbox:${hash(0xabc)}-other`,
    `factory-sandbox:${hash(0xabc).toUpperCase()}`,
    "factory-sandbox:latest",
    `factory-sandboxes:${hash(0xabc)}`,
    `registry.example/factory-sandbox:${hash(0xabc)}`,
    `${legacy}:old`,
    "factory-acme-widgets-000000000000:latest",
    `${unserved}:latest`,
    "debian:bookworm-slim",
  ];
  const images: Image[] = [
    ...pair(1),
    ...pair(2),
    {
      id: `sha256:${"d".repeat(64)}`,
      created: day(3),
      tags: [`${legacy}:latest`],
    },
    ...lookalikes.map((tag, index) => ({
      id: `sha256:${String(index).padStart(64, "e")}`,
      created: day(1),
      tags: [tag],
    })),
    { id: `sha256:${"f".repeat(64)}`, created: day(1), tags: [] },
  ];
  // An operator's alias of pair 1's agent image.
  images[0].tags.push("mine:keep");
  const daemon = fakeDocker({ images });
  const result = await retainSandboxImages(daemon.docker, {
    repositories: served,
    current: [agent(2)],
    running: [],
    obsoletePairs: 0,
  });
  assert.deepEqual(result, {
    removed: [`${legacy}:latest`, agent(1), toolchain(1)],
    problems: [],
  });
  assert.deepEqual(
    daemon.tags(),
    [...lookalikes, "mine:keep", agent(2), toolchain(2)].sort(),
  );
  assert.ok(daemon.images.some((image) => image.tags.length === 0));
});

test("a legacy image counts as one obsolete pair by its age", async () => {
  const legacy = `${legacyImageName("acme/gadgets")}:latest`;
  const daemon = fakeDocker({
    images: [
      ...pair(1),
      { id: `sha256:${"d".repeat(64)}`, created: day(2), tags: [legacy] },
      ...pair(3),
      ...pair(4),
    ],
  });
  const result = await retainSandboxImages(daemon.docker, {
    repositories: served,
    current: [agent(4)],
    running: [],
    obsoletePairs: 2,
  });
  assert.deepEqual(result.removed, [agent(1), toolchain(1)]);
  assert.ok(daemon.tags().includes(legacy));
});

for (const [name, failing] of [
  ["the image listing", "image ls"],
  ["an image's creation time", "image inspect"],
  ["a container's image", "container inspect"],
] as const)
  test(`an inventory that cannot read ${name} removes nothing`, async () => {
    const daemon = fakeDocker({
      images: [1, 2, 3].flatMap((n) => pair(n)),
      containers: ["sha256:unrelated"],
    });
    daemon.before((args) => {
      if (args.slice(0, 2).join(" ") === failing)
        throw new Error(`docker ${failing} failed: the daemon went away`);
    });
    await assert.rejects(
      retainSandboxImages(daemon.docker, {
        repositories: served,
        current: [agent(3)],
        running: [],
        obsoletePairs: 0,
      }),
      new RegExp(`docker ${failing} failed`),
    );
    assert.deepEqual(daemon.removals(), []);
  });

test("an image removed or a container gone during the inventory removes nothing", async () => {
  for (const vanish of ["image", "container"] as const) {
    const images = [1, 2, 3].flatMap((n) => pair(n));
    const containers = ["sha256:unrelated"];
    const daemon = fakeDocker({ images, containers });
    daemon.before((args) => {
      if (vanish === "image" && args[1] === "inspect" && args[0] === "image")
        images.splice(0, 1);
      if (vanish === "container" && args[0] === "container")
        containers.splice(0, 1);
    });
    await assert.rejects(
      retainSandboxImages(daemon.docker, {
        repositories: served,
        current: [agent(3)],
        running: [],
        obsoletePairs: 0,
      }),
      /No such/,
    );
    assert.deepEqual(daemon.removals(), []);
  }
});

test("a container started after the inventory keeps its pair, and the other removals go ahead", async () => {
  const images = [1, 2, 3].flatMap((n) => pair(n));
  const containers: string[] = [];
  const daemon = fakeDocker({ images, containers });
  daemon.before((args) => {
    if (args[1] === "rm" && containers.length === 0)
      containers.push(idOf(images, agent(2)));
  });
  const result = await retainSandboxImages(daemon.docker, {
    repositories: served,
    current: [agent(3)],
    running: [],
    obsoletePairs: 0,
  });
  assert.deepEqual(result.removed, [agent(1), toolchain(1)]);
  assert.equal(result.problems.length, 1);
  assert.match(
    result.problems[0],
    new RegExp(`^${agent(2)} was not removed: Error: .*must force`),
  );
  // The pair stays whole: its toolchain is not removed without its agent.
  assert.deepEqual(daemon.removals(), [agent(2), agent(1), toolchain(1)]);
  assert.ok(daemon.tags().includes(toolchain(2)));
});

test("with no factory image nothing is inspected or removed", async () => {
  const daemon = fakeDocker({
    images: [
      {
        id: `sha256:${"e".repeat(64)}`,
        created: day(1),
        tags: ["debian:bookworm-slim"],
      },
    ],
  });
  assert.deepEqual(
    await retainSandboxImages(daemon.docker, {
      repositories: served,
      current: [agent(1)],
      running: [],
      obsoletePairs: 0,
    }),
    { removed: [], problems: [] },
  );
  assert.deepEqual(
    daemon.calls.map((args) => args.slice(0, 2).join(" ")),
    ["image ls"],
  );
});

test("the build cache is pruned only in the factory's own builder, by age", async () => {
  const factory = { builder: "factory", hours: 24 } as const;
  const absent = fakeDocker({ images: [] });
  assert.equal(await pruneSandboxCache(absent.docker, factory), null);
  assert.deepEqual(absent.calls, [["buildx", "inspect", "factory-sandbox"]]);

  const present = fakeDocker({ images: [], builder: true });
  assert.equal(await pruneSandboxCache(present.docker, factory), "2.5GB");
  assert.deepEqual(present.calls, [
    ["buildx", "inspect", "factory-sandbox"],
    ["buildx", "inspect", "--bootstrap", "factory-sandbox"],
    [
      "buildx",
      "prune",
      "--builder",
      "factory-sandbox",
      "--all",
      "--force",
      "--filter",
      "until=24h",
    ],
  ]);

  const empty = fakeDocker({ images: [], builder: true, freed: "0B" });
  assert.equal(await pruneSandboxCache(empty.docker, factory), null);

  const failing = fakeDocker({ images: [], builder: true });
  failing.before((args) => {
    if (args[1] === "prune")
      throw new Error("docker buildx prune failed: boom");
  });
  await assert.rejects(pruneSandboxCache(failing.docker, factory), /boom/);
});

test("a host building with the daemon's own builder prunes no build cache, even with a factory builder left", async () => {
  for (const builder of [false, true]) {
    const daemon = fakeDocker({ images: [], builder });
    assert.equal(
      await pruneSandboxCache(daemon.docker, { builder: "daemon", hours: 24 }),
      null,
    );
    assert.deepEqual(daemon.calls, []);
  }
});

test("factory cache applies age then a size target, reclaiming recent unused cache under pressure", async () => {
  const records = [
    { Size: "6000000000", Reclaimable: true, recent: true },
    { Size: "2000000000", Reclaimable: false, recent: true },
    { Size: "1000000000", Reclaimable: true, recent: false },
  ];
  const calls: string[][] = [];
  const docker: Docker = async (args) => {
    calls.push(args);
    assert.equal(args.includes("factory-sandbox"), true);
    if (args[1] === "prune") {
      const age = args.includes("until=24h");
      for (let i = records.length - 1; i >= 0; i--)
        if (records[i].Reclaimable && (!age || !records[i].recent))
          records.splice(i, 1);
      return "Total: 1GB";
    }
    if (args[1] === "du")
      return records.map((r) => JSON.stringify(r)).join("\n");
    assert.equal(args[1], "inspect");
    return "present";
  };
  await pruneSandboxCache(docker, {
    builder: "factory",
    hours: 24,
    maximumBytes: 3000000000,
    minimumFreeBytes: 18253611008,
  });
  assert.deepEqual(records, [
    { Size: "2000000000", Reclaimable: false, recent: true },
  ]);
  const prunes = calls.filter((args) => args[1] === "prune");
  assert.equal(prunes.length, 2);
  assert.ok(prunes[0].includes("until=24h"));
  assert.deepEqual(prunes[1], [
    "buildx",
    "prune",
    "--builder",
    "factory-sandbox",
    "--all",
    "--force",
    "--max-used-space",
    "3000000000",
    "--min-free-space",
    "18253611008",
    "--reserved-space",
    "0",
  ]);
  await assert.rejects(
    pruneSandboxCache(docker, {
      builder: "factory",
      hours: 24,
      maximumBytes: 1000000000,
    }),
    /cache.*target/,
  );
});

test("enabled cache targets never prune daemon cache or a leftover builder and tolerate an absent factory builder", async () => {
  for (const builder of ["daemon", "factory"] as const) {
    const daemon = fakeDocker({ images: [] });
    assert.equal(
      await pruneSandboxCache(daemon.docker, {
        builder,
        hours: 24,
        maximumBytes: 8000000000,
        minimumFreeBytes: 18253611008,
      }),
      null,
    );
    assert.deepEqual(
      daemon.calls,
      builder === "daemon" ? [] : [["buildx", "inspect", "factory-sandbox"]],
    );
  }
  await assert.rejects(
    pruneSandboxCache(
      async () => {
        throw new Error("Docker unavailable");
      },
      { builder: "factory", hours: 24 },
    ),
    /Docker unavailable/,
  );
});

test("cache size checks accept byte strings and unit-formatted output at the target and reject unknown output", async () => {
  for (const Size of ["2000000000", "2GB"]) {
    const docker: Docker = async (args) =>
      args[1] === "du" ? JSON.stringify({ Size }) : "Total: 0B";
    assert.equal(
      await pruneSandboxCache(docker, {
        builder: "factory",
        hours: 24,
        maximumBytes: 2000000000,
      }),
      null,
    );
    await assert.rejects(
      pruneSandboxCache(docker, {
        builder: "factory",
        hours: 24,
        maximumBytes: 1999999999,
      }),
      /above its target/,
    );
  }
  for (const Size of ["unknown", "-1", "9007199254740992", null]) {
    await assert.rejects(
      pruneSandboxCache(
        async (args) => (args[1] === "du" ? JSON.stringify({ Size }) : ""),
        {
          builder: "factory",
          hours: 24,
          maximumBytes: 2000000000,
        },
      ),
      /unreadable/,
    );
  }
});
