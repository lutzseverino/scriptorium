// One local probe for configuration preflight and build admission. It uses the
// caller's identity and mount view and never substitutes a different path.
import { realpathSync, statSync, statfsSync } from "node:fs";

export function readStorageFilesystem(path: string): {
  filesystem: string;
  availableBytes: number;
} {
  const resolved = realpathSync(path);
  const info = statSync(resolved, { bigint: true });
  if (!info.isDirectory())
    throw new Error(`storage path ${path} is not a directory`);
  const space = statfsSync(resolved, { bigint: true });
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
