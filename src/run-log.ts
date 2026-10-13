// A run's log: Sandcastle writes the agent's raw log into the run's private
// directory, and the factory copies it, redacted line by line, to the log
// people read. A secret never spans lines, so redacting whole lines finds
// every one.
import { watch } from "node:fs";
import { appendFile, mkdir, open, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type RunLog = {
  // Copies what remains, including an unterminated last line, and stops.
  close(): Promise<void>;
};

// Creates the raw log, readable only by the host's user, and copies each
// complete line written to it into `published` as it arrives.
export async function followRunLog(
  raw: string,
  published: string,
  redact: (text: string) => string,
): Promise<RunLog> {
  await writeFile(raw, "", { mode: 0o600 });
  await mkdir(dirname(published), { recursive: true });
  let offset = 0;
  let partial = Buffer.alloc(0);

  // A failed copy keeps its bytes for the next one.
  async function copy(final: boolean) {
    const file = await open(raw, "r");
    const chunks = [partial];
    let read = offset;
    try {
      for (;;) {
        const { bytesRead, buffer } = await file.read({
          buffer: Buffer.alloc(64 * 1024),
          position: read,
        });
        if (bytesRead === 0) break;
        read += bytesRead;
        chunks.push(buffer.subarray(0, bytesRead));
      }
    } finally {
      await file.close();
    }
    const bytes = Buffer.concat(chunks);
    // A newline byte never occurs inside a UTF-8 character.
    const end = final ? bytes.length : bytes.lastIndexOf(0x0a) + 1;
    if (end > 0)
      await appendFile(
        published,
        redact(bytes.subarray(0, end).toString("utf8")),
      );
    offset = read;
    partial = bytes.subarray(end);
  }

  // One copy at a time, in the order requested.
  let copying: Promise<void> = Promise.resolve();
  const request = (final: boolean) =>
    (copying = copying.catch(() => {}).then(() => copy(final)));
  // A copy the watcher misses, or one that fails, is caught up by the next
  // one or by closing. The watcher alone never keeps the process running.
  const watcher = watch(raw, () => {
    request(false).catch(() => {});
  }).on("error", () => {});
  watcher.unref();
  return {
    async close() {
      watcher.close();
      await request(true);
    },
  };
}

// The end of a raw log: its last `bytes` bytes, starting at a line's start
// unless one line fills them all.
export async function readLogEnd(
  raw: string,
  bytes = 64 * 1024,
): Promise<string> {
  const file = await open(raw, "r");
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - bytes);
    const { buffer, bytesRead } = await file.read({
      buffer: Buffer.alloc(size - start),
      position: start,
    });
    const end = buffer.subarray(0, bytesRead);
    // The first newline ends a line that began before the window, unless it
    // ends the window's last line.
    const newline = end.indexOf(0x0a);
    const line =
      start === 0 || newline === -1 || newline === end.length - 1
        ? 0
        : newline + 1;
    return end.subarray(line).toString("utf8");
  } finally {
    await file.close();
  }
}
