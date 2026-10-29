// Storage admission is independent of ticket and provider state. One host
// serializes complete image preparations and cache maintenance, including the
// fresh checks immediately before each expanding Docker operation.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  mkdir,
  realpath,
  rename,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import {
  docker,
  sandboxBuilder,
  type DockerRun,
  type ImageBuilder,
} from "./sandbox-image.ts";
import type { ImageStoragePolicy } from "./host-configuration.ts";

export type StorageFilesystem = {
  paths: string[];
  filesystem: string;
  availableBytes: number;
};
export type ImageStorageStatus = {
  held: boolean;
  reason: string | null;
  observedAt: string;
  reserveBytes: number | null;
  resumeBytes: number | null;
  filesystems: StorageFilesystem[];
  reclamation: {
    pressure: boolean;
    freed: string | null;
    error: string | null;
  };
};

export class ImageStorageHold extends Error {
  readonly diagnostic: ImageStorageStatus;
  constructor(diagnostic: ImageStorageStatus) {
    super(
      `sandbox image builds wait for storage: ${JSON.stringify(diagnostic)}`,
    );
    this.name = "ImageStorageHold";
    this.diagnostic = diagnostic;
  }
}

export type ImageStorage = ReturnType<typeof createImageStorage>;

export function createImageStorage(
  policy: ImageStoragePolicy | undefined,
  ports: {
    observe(paths: string[]): Promise<StorageFilesystem[]>;
    // Apply age/size retention normally, and reclaim recent unused dedicated
    // cache under pressure. Reject if pruning or its size target fails.
    reclaim(pressure: boolean): Promise<string | null>;
    now(): Date;
    checkCache?: boolean;
    statePath?: string;
  },
) {
  let held = false;
  if (ports.statePath) {
    try {
      held = JSON.parse(readFileSync(ports.statePath, "utf8")).held !== false;
    } catch (error) {
      // A missing first-run record starts without a hold. An unreadable or
      // damaged record recovers conservatively at the recovery threshold.
      held = (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  }
  let status: ImageStorageStatus | undefined;
  let queue = Promise.resolve();

  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = queue.then(operation);
    queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  async function check() {
    if (!policy && !ports.checkCache) return;
    const paths = policy
      ? [...policy.storePaths, ...(policy.cachePath ? [policy.cachePath] : [])]
      : [];
    let filesystems: StorageFilesystem[] = [];
    let reason: string | null = null;
    const reclamation = {
      pressure: held,
      freed: null as string | null,
      error: null as string | null,
    };
    try {
      if (policy) {
        filesystems = await ports.observe(paths);
        validateObservation(paths, filesystems);
        const threshold = held ? policy.resumeBytes : policy.reserveBytes;
        if (filesystems.some((fs) => fs.availableBytes < threshold))
          held = true;
      }
      reclamation.pressure = held;
      try {
        reclamation.freed = await ports.reclaim(held);
      } catch (error) {
        reclamation.error = `${error}`;
        throw error;
      }
      // Never admit using a measurement from before reclamation, even if the
      // prune reports success or says it freed nothing.
      if (policy) {
        filesystems = await ports.observe(paths);
        validateObservation(paths, filesystems);
        const required = held ? policy.resumeBytes : policy.reserveBytes;
        if (filesystems.some((fs) => fs.availableBytes < required)) {
          held = true;
          reason = `available storage is below ${required} bytes; recover to ${policy.resumeBytes} bytes on every constrained filesystem`;
        } else held = false;
      } else held = false;
    } catch (error) {
      held = true;
      reason = `${error}`;
    }
    status = {
      held,
      reason,
      observedAt: ports.now().toISOString(),
      reserveBytes: policy?.reserveBytes ?? null,
      resumeBytes: policy?.resumeBytes ?? null,
      filesystems,
      reclamation,
    };
    if (ports.statePath) {
      try {
        await mkdir(dirname(ports.statePath), { recursive: true });
        await writeFile(
          `${ports.statePath}.partial`,
          JSON.stringify(status) + "\n",
          { mode: 0o600 },
        );
        await rename(`${ports.statePath}.partial`, ports.statePath);
      } catch (error) {
        held = status.held = true;
        status.reason = `storage admission state could not be recorded: ${error}`;
      }
    }
    if (held) throw new ImageStorageHold(status);
  }

  return {
    enabled: Boolean(policy || ports.checkCache),
    run<T>(operation: (check: () => Promise<void>) => Promise<T>): Promise<T> {
      return exclusive(() => operation(check));
    },
    maintain(): Promise<string | null> {
      return exclusive(() => ports.reclaim(false));
    },
    status: () => status,
  };
}

function validateObservation(
  paths: string[],
  filesystems: StorageFilesystem[],
) {
  if (
    filesystems.length === 0 ||
    filesystems.some(
      (fs) =>
        !fs.filesystem ||
        !Number.isSafeInteger(fs.availableBytes) ||
        fs.availableBytes < 0,
    ) ||
    paths.some((path) => !filesystems.some((fs) => fs.paths.includes(path)))
  )
    throw new Error(
      "storage observation is invalid or incomplete; verify the configured local store paths",
    );
}

// Explicit paths are the operator's assertion of which native local stores
// Docker uses. Never infer them from data-root or the process filesystem.
export async function observeImageStorage(
  paths: string[],
  {
    run = docker,
    builder = "daemon",
    environment = process.env,
    filesystem = readFilesystem,
  }: {
    run?: DockerRun;
    builder?: ImageBuilder;
    environment?: NodeJS.ProcessEnv;
    filesystem?: (path: string) => Promise<Omit<StorageFilesystem, "paths">>;
  } = {},
): Promise<StorageFilesystem[]> {
  const endpoint =
    environment.DOCKER_HOST && !environment.DOCKER_CONTEXT
      ? environment.DOCKER_HOST
      : (
          await run([
            "context",
            "inspect",
            ...(environment.DOCKER_CONTEXT ? [environment.DOCKER_CONTEXT] : []),
            "--format",
            "{{.Endpoints.docker.Host}}",
          ])
        ).trim();
  const requireLocal = (endpoint: string) => {
    if (!endpoint.startsWith("unix:///"))
      throw new Error(
        "storage admission requires a native local Docker socket and explicitly mapped local stores; remote or unresolved stores cannot be measured",
      );
  };
  requireLocal(endpoint);
  if (builder === "factory") {
    let inspected;
    try {
      inspected = await run([
        "buildx",
        "inspect",
        sandboxBuilder,
        "--format",
        "{{json .}}",
      ]);
    } catch (error) {
      if (!/no builder .* found/i.test(String(error))) throw error;
    }
    if (inspected !== undefined) {
      const selected = JSON.parse(inspected) as {
        Driver: string;
        Nodes: { Endpoint: string }[];
      };
      if (
        selected.Driver !== "docker-container" ||
        selected.Nodes?.length !== 1
      )
        throw new Error(
          "storage admission requires a single local factory builder node",
        );
      const node = selected.Nodes[0].Endpoint;
      const nodeEndpoint = node.includes("://")
        ? node
        : (
            await run([
              "context",
              "inspect",
              node,
              "--format",
              "{{.Endpoints.docker.Host}}",
            ])
          ).trim();
      requireLocal(nodeEndpoint);
      if (nodeEndpoint !== endpoint)
        throw new Error(
          "factory builder and image store must use the same local Docker endpoint",
        );
    }
  }
  const observed = new Map<string, StorageFilesystem>();
  for (const path of paths) {
    const reading = await filesystem(path);
    const previous = observed.get(reading.filesystem);
    if (previous) {
      previous.paths.push(path);
      previous.availableBytes = Math.min(
        previous.availableBytes,
        reading.availableBytes,
      );
    } else observed.set(reading.filesystem, { ...reading, paths: [path] });
  }
  const result = [...observed.values()];
  validateObservation(paths, result);
  return result;
}

async function readFilesystem(
  path: string,
): Promise<Omit<StorageFilesystem, "paths">> {
  const resolved = await realpath(path);
  const info = await stat(resolved, { bigint: true });
  if (!info.isDirectory())
    throw new Error(`storage path ${path} is not a directory`);
  const space = await statfs(resolved, { bigint: true });
  const available = space.bavail * space.bsize;
  if (
    space.bsize <= 0n ||
    space.blocks <= 0n ||
    space.bavail < 0n ||
    space.bavail > space.blocks ||
    available > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error(`storage observation for ${path} is invalid`);
  return {
    filesystem: `device:${info.dev}`,
    availableBytes: Number(available),
  };
}
