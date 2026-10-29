// Sandbox image retention: once a pass has prepared every served repository's
// sandbox image, the factory removes its own obsolete images beyond the host's
// allowance, and on a host that opted into the factory builder prunes that
// builder's cache past a minimum age. It removes only what it can prove is its
// own and nothing anything still uses.
import { createHash } from "node:crypto";
import {
  sandboxBuilder,
  sandboxImageRepository,
  type ImageBuilder,
} from "./sandbox-image.ts";

// Runs the Docker CLI with the arguments and resolves its standard output.
export type Docker = (args: string[]) => Promise<string>;

export type Retention = {
  // The image references removed.
  removed: string[];
  // The removals that failed, each with its reason. A failed removal leaves
  // the rest of its pair in place.
  problems: string[];
};

// One retention unit: a sandbox image pair, the agent image and its toolchain
// image sharing one hash, or one legacy image. The agent image comes first.
type Unit = {
  key: string;
  images: { reference: string; id: string }[];
  created: number;
};

const pairTag = /^([0-9a-f]{64})(-toolchain)?$/;

// The image name factory releases before the `factory-sandbox` repository gave
// a served repository, always tagged `latest`.
export function legacyImageName(repository: string): string {
  const [owner, name] = repository.split("/");
  const slug = `${owner}-${name}`.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
  const hash = createHash("sha256")
    .update(`${owner}/${name}`)
    .digest("hex")
    .slice(0, 12);
  return `factory-${slug}-${hash}`;
}

// Removes every obsolete unit beyond `obsoletePairs`, newest kept first. A
// unit is obsolete unless it holds one of the `current` images. An obsolete
// unit holding a `running` image or an image ID any container references,
// running or stopped, is kept too, and counts against the allowance. Rejects,
// removing nothing, when the inventory of images or containers fails.
export async function retainSandboxImages(
  docker: Docker,
  {
    repositories,
    current,
    running,
    obsoletePairs,
  }: {
    // Every served repository, whose legacy image names are the factory's.
    repositories: string[];
    // Every served repository's current sandbox image.
    current: string[];
    // The images of runs that have not exited, whose containers may not
    // exist yet.
    running: string[];
    obsoletePairs: number;
  },
): Promise<Retention> {
  const units = await inventory(docker, repositories);
  if (units.length === 0) return { removed: [], problems: [] };
  const used = await containerImages(docker);
  const holds = (unit: Unit, references: string[]) =>
    unit.images.some(({ reference }) =>
      references.some((held) => sameUnit(held, reference)),
    );
  const obsolete = units
    .filter((unit) => !holds(unit, current))
    .sort((a, b) => b.created - a.created || a.key.localeCompare(b.key));
  const kept = obsolete.filter(
    (unit) =>
      holds(unit, running) || unit.images.some(({ id }) => used.has(id)),
  );
  let allowance = obsoletePairs - kept.length;
  const removed: string[] = [];
  const problems: string[] = [];
  for (const unit of obsolete) {
    if (kept.includes(unit)) continue;
    if (allowance > 0) {
      allowance--;
      continue;
    }
    for (const { reference } of unit.images)
      try {
        // Without --force, Docker refuses an image a container started since
        // the inventory uses, and only untags an image another tag names.
        await docker(["image", "rm", reference]);
        removed.push(reference);
      } catch (error) {
        problems.push(`${reference} was not removed: ${error}`);
        break;
      }
  }
  return { removed, problems };
}

// Prunes the factory builder's cache last used at least `hours` ago, when the
// host builds there. A host building with the daemon's own builder prunes
// nothing, even if a factory builder remains from an earlier configuration,
// and a host without the builder has no factory cache. The cache of other
// builders and of the daemon's own builder is never touched. Resolves the
// space freed, as Docker reports it, or null when nothing was.
export async function pruneSandboxCache(
  docker: Docker,
  {
    builder,
    hours,
    maximumBytes,
    minimumFreeBytes,
  }: {
    builder: ImageBuilder;
    hours: number;
    maximumBytes?: number;
    minimumFreeBytes?: number;
  },
): Promise<string | null> {
  if (builder !== "factory") return null;
  try {
    await docker(["buildx", "inspect", sandboxBuilder]);
  } catch (error) {
    if (/no builder .* found/i.test(String(error))) return null;
    throw error;
  }
  // A builder stopped since the host restarted starts before it prunes.
  await docker(["buildx", "inspect", "--bootstrap", sandboxBuilder]);
  let output = await docker([
    "buildx",
    "prune",
    "--builder",
    sandboxBuilder,
    "--all",
    "--force",
    "--filter",
    `until=${hours}h`,
  ]);
  if (maximumBytes !== undefined || minimumFreeBytes !== undefined) {
    // This second pass may reclaim recent unused records. The age policy is
    // still applied independently above; ANDing it with the size filter would
    // leave recent cache unbounded.
    output +=
      "\n" +
      (await docker([
        "buildx",
        "prune",
        "--builder",
        sandboxBuilder,
        "--all",
        "--force",
        ...(maximumBytes !== undefined
          ? ["--max-used-space", String(maximumBytes)]
          : []),
        ...(minimumFreeBytes !== undefined
          ? ["--min-free-space", String(minimumFreeBytes)]
          : []),
        "--reserved-space",
        "0",
      ]));
  }
  if (maximumBytes !== undefined) {
    const records = await docker([
      "buildx",
      "du",
      "--builder",
      sandboxBuilder,
      "--format",
      "json",
    ]);
    const used = records
      .split("\n")
      .filter(Boolean)
      .reduce((total, line) => {
        const record = JSON.parse(line) as { Size: string };
        // Buildx exposes Size as a decimal, human-readable string, including in
        // JSON. Fail closed on unknown output instead of trusting prune success.
        const match = /^(\d+(?:\.\d+)?)\s*(B|kB|MB|GB|TB|PB)$/.exec(
          record.Size,
        );
        if (!match) throw new Error("factory cache usage is unreadable");
        return (
          total +
          Number(match[1]) *
            1000 ** ["B", "kB", "MB", "GB", "TB", "PB"].indexOf(match[2])
        );
      }, 0);
    if (!Number.isFinite(used) || used > maximumBytes)
      throw new Error(
        `factory cache remains at ${used} reported bytes above its target ${maximumBytes}; in-use or protected cache stays`,
      );
  }
  const totals = [...output.matchAll(/^Total:\s*(\S+)/gm)].map(
    (match) => match[1],
  );
  const total =
    totals.filter((total) => !/^0(\.0+)?B$/.test(total)).join(" + ") || null;
  return total;
}

// The factory's tagged images: current-format pairs and the served
// repositories' legacy images. Untagged images and every other name, however
// alike, are not inventoried, so they are never removed.
async function inventory(
  docker: Docker,
  repositories: string[],
): Promise<Unit[]> {
  const legacy = new Set(repositories.map(legacyImageName));
  const units = new Map<string, Unit>();
  const listing = await docker([
    "image",
    "ls",
    "--no-trunc",
    "--format",
    "{{.Repository}}\t{{.Tag}}\t{{.ID}}",
  ]);
  for (const line of listing.split("\n").filter(Boolean)) {
    const [repository, tag, id] = line.split("\t");
    if (!id?.startsWith("sha256:")) continue;
    let key, agent;
    const pair = repository === sandboxImageRepository && pairTag.exec(tag);
    if (pair) {
      key = pair[1];
      agent = pair[2] === undefined;
    } else if (legacy.has(repository) && tag === "latest") {
      key = repository;
      agent = true;
    } else continue;
    const unit = units.get(key) ?? { key, images: [], created: 0 };
    const image = { reference: `${repository}:${tag}`, id };
    if (agent) unit.images.unshift(image);
    else unit.images.push(image);
    units.set(key, unit);
  }
  if (units.size === 0) return [];
  const ids = new Set(
    [...units.values()].flatMap((unit) => unit.images.map(({ id }) => id)),
  );
  const created = new Map<string, number>();
  const inspected = await docker([
    "image",
    "inspect",
    "--format",
    "{{.Id}}\t{{.Created}}",
    ...ids,
  ]);
  for (const line of inspected.split("\n").filter(Boolean)) {
    const [id, at] = line.split("\t");
    created.set(id, Date.parse(at));
  }
  for (const unit of units.values())
    for (const { id } of unit.images) {
      const at = created.get(id);
      if (at === undefined || Number.isNaN(at))
        throw new Error(`the image ${id} has no creation time`);
      unit.created = Math.max(unit.created, at);
    }
  return [...units.values()];
}

// Every image ID a container references, running or stopped, including the
// untagged ID a rebuild of its tag left it.
async function containerImages(docker: Docker): Promise<Set<string>> {
  const containers = (await docker(["ps", "--all", "--quiet", "--no-trunc"]))
    .split("\n")
    .filter(Boolean);
  if (containers.length === 0) return new Set();
  const images = (
    await docker([
      "container",
      "inspect",
      "--format",
      "{{.Image}}",
      ...containers,
    ])
  )
    .split("\n")
    .filter(Boolean);
  if (images.length !== containers.length)
    throw new Error("the container inventory is incomplete");
  return new Set(images);
}

// Whether two image references belong to the same unit: one pair's agent and
// toolchain images, or the same legacy image.
function sameUnit(a: string, b: string): boolean {
  const hash = (reference: string) => {
    const [repository, tag] = reference.split(":");
    return repository === sandboxImageRepository
      ? (pairTag.exec(tag ?? "")?.[1] ?? null)
      : null;
  };
  return a === b || (hash(a) !== null && hash(a) === hash(b));
}
