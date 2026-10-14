import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

export const AGENT_LAYER_VERSION = "4";

// The factory layer's label, which every sandbox container carries from its
// image.
const identityLabel = "factory.agent.identity";

export function sandboxImageTag(
  dockerfile: string,
  layerVersion: string,
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([dockerfile, layerVersion]))
    .digest("hex");
  return `factory-sandbox:${hash}`;
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
  await docker(["build", "--tag", toolchain, "-"], dockerfile);
  const layer = await readFile(
    new URL("./agent-layer.Dockerfile", import.meta.url),
    "utf8",
  );
  await docker(
    [
      "build",
      "--tag",
      image,
      "--build-arg",
      `TOOLCHAIN_IMAGE=${toolchain}`,
      "--build-arg",
      `AGENT_UID=${uid}`,
      "--build-arg",
      `AGENT_GID=${gid}`,
      "-",
    ],
    layer,
  );
  return image;
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

function docker(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "docker",
      args,
      { maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(`docker ${args[0]} failed: ${stderr || error.message}`),
          );
        else resolve(stdout);
      },
    );
    child.stdin!.on("error", () => {
      // An early Docker exit can close stdin; the process callback reports it.
    });
    child.stdin!.end(input);
  });
}
