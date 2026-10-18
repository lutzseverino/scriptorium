import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const AGENT_LAYER_VERSION = "4";

// The factory layer's label, which every sandbox container carries from its
// image.
const identityLabel = "factory.agent.identity";

// The Docker image repository that holds every sandbox image the factory
// builds, and nothing else.
export const sandboxImageRepository = "factory-sandbox";

// The factory's own BuildKit builder. Every sandbox image build runs in it, so
// its build cache holds the factory's builds and nobody else's.
export const sandboxBuilder = "factory-sandbox";

// The BuildKit release the builder runs, pinned to its multi-platform index.
export const buildkitImage =
  "moby/buildkit:v0.34.0@sha256:b059f8d7226d0b326bc871af489a5dddf65e36af4d20d14251b072974d9ee87c";

export function sandboxImageTag(
  dockerfile: string,
  layerVersion: string,
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([dockerfile, layerVersion]))
    .digest("hex");
  return `${sandboxImageRepository}:${hash}`;
}

export async function buildSandboxImage(options: {
  dockerfile: string;
  uid: number;
  gid: number;
}): Promise<string> {
  const { dockerfile, uid, gid } = options;
  for (const id of [uid, gid]) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(
        "The sandbox agent UID and GID must be positive integers",
      );
    }
  }
  const image = sandboxImageTag(dockerfile, AGENT_LAYER_VERSION);
  const identity = `${uid}:${gid}`;
  // A host identity change rebuilds the same tag; identity is not a tag input.
  const existing = await docker([
    "image",
    "inspect",
    "--format",
    `{{ index .Config.Labels "${identityLabel}" }}`,
    image,
  ]).catch(() => "");
  if (existing.trim() === identity) return image;

  const toolchain = `${image}-toolchain`;
  const layer = await readFile(
    new URL("./agent-layer.Dockerfile", import.meta.url),
    "utf8",
  );
  await ensureBuilder();
  // One bake builds both images in the factory's builder and loads them into
  // the daemon. The agent layer starts from the toolchain build's result, not
  // from a daemon image, which the builder can't see. The builds' context is
  // an empty directory.
  const work = await mkdtemp(join(tmpdir(), "factory-sandbox-build-"));
  try {
    await mkdir(join(work, "context"));
    const target = { context: "context" };
    await writeFile(
      join(work, "bake.json"),
      JSON.stringify({
        target: {
          toolchain: {
            ...target,
            "dockerfile-inline": dockerfile,
            tags: [toolchain],
          },
          agent: {
            ...target,
            "dockerfile-inline": layer,
            contexts: { "factory-toolchain": "target:toolchain" },
            args: {
              TOOLCHAIN_IMAGE: "factory-toolchain",
              AGENT_UID: String(uid),
              AGENT_GID: String(gid),
            },
            tags: [image],
          },
        },
      }),
    );
    await docker(
      [
        "buildx",
        "bake",
        "--builder",
        sandboxBuilder,
        "--file",
        "bake.json",
        "--load",
        "toolchain",
        "agent",
      ],
      { cwd: work },
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return image;
}

// Creates the factory's builder unless it exists.
async function ensureBuilder(): Promise<void> {
  const exists = () =>
    docker(["buildx", "inspect", sandboxBuilder]).then(
      () => true,
      () => false,
    );
  if (await exists()) return;
  try {
    await docker([
      "buildx",
      "create",
      "--name",
      sandboxBuilder,
      "--driver",
      "docker-container",
      "--driver-opt",
      `image=${buildkitImage}`,
    ]);
  } catch (error) {
    if (!(await exists())) throw error;
  }
}

// Removes every sandbox container on the host, running or not. One factory
// process runs on a host, so these are its own or an earlier process's.
export function stopSandboxes(): void {
  const list = () =>
    execFileSync(
      "docker",
      ["ps", "--all", "--quiet", "--filter", `label=${identityLabel}`],
      { encoding: "utf8", timeout: 60_000 },
    )
      .split("\n")
      .filter(Boolean);
  const containers = list();
  if (containers.length === 0) return;
  try {
    execFileSync("docker", ["rm", "--force", ...containers], {
      stdio: "ignore",
      timeout: 60_000,
    });
  } catch (error) {
    // A container Sandcastle removed meanwhile is gone all the same.
    if (list().length > 0) throw error;
  }
}

// Runs the Docker CLI and resolves its standard output.
export function docker(
  args: string[],
  { cwd }: { cwd?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "docker",
      args,
      {
        cwd,
        // Default attestations would make the loaded images manifest lists.
        env: { ...process.env, BUILDX_NO_DEFAULT_ATTESTATIONS: "1" },
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `docker ${args.slice(0, 2).join(" ")} failed: ${stderr || error.message}`,
            ),
          );
        else resolve(stdout);
      },
    );
    child.stdin!.on("error", () => {
      // An early Docker exit can close stdin; the process callback reports it.
    });
    child.stdin!.end();
  });
}
