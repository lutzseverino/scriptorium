// Codex: its credential is the host's copy of a Codex login (`auth.json`),
// which the host keeps renewing.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { codex } from "@ai-hero/sandcastle";
import type {
  LaunchRequest,
  ProviderAdapter,
  ProviderPorts,
} from "../providers.ts";
import { launchAgent } from "./launch.ts";
import { fullest } from "./usage.ts";

type Effort = "low" | "medium" | "high" | "xhigh";
const efforts: Effort[] = ["low", "medium", "high", "xhigh"];

// Codex signs in from its default home's login.
export const sandboxLogin = "/home/agent/.codex/auth.json";

export function codexAdapter(
  credential: string,
  ports: ProviderPorts,
): ProviderAdapter {
  return {
    name: "codex",
    credential,
    efforts,
    defaultEffort: "high",
    vendorPrefixes: ["gpt-"],
    skillPrefix: "$",
    // The login is mounted read-only as it stands at this launch; the rest of
    // the Codex home stays writable and private to the sandbox.
    async launch(request: LaunchRequest) {
      for (const secret of await loginSecrets(credential))
        request.delivered?.(secret);
      await launchAgent(
        ports.sandcastle,
        request,
        codex(request.model, { effort: request.effort as Effort }),
        [{ hostPath: credential, sandboxPath: sandboxLogin, readonly: true }],
      );
    },
    readUsage: () => readCodexUsage(credential, ports.codexExecutable),
  };
}

// A Codex login's secret values: its API key and its sign-in tokens. A login
// that is not JSON can't sign in, so its launch fails before Sandcastle.
async function loginSecrets(path: string): Promise<string[]> {
  let login;
  try {
    login = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    // A parse error quotes the login, so its message stays out.
    throw new Error(`the Codex login ${path} is not readable JSON`, {
      cause: error,
    });
  }
  const tokens = login?.tokens;
  return [
    login?.OPENAI_API_KEY,
    ...(typeof tokens === "object" && tokens !== null
      ? Object.values(tokens)
      : []),
  ].filter((secret): secret is string => typeof secret === "string");
}

// The Codex app-server's documented rate-limit read, over stdio JSONL. Each
// read signs in from its own private copy of the login, removed afterwards.
export async function readCodexUsage(
  login: string,
  executable: string,
  timeoutMs = 30_000,
): Promise<number | null> {
  const home = await mkdtemp(join(tmpdir(), "factory-codex-"));
  try {
    await writeFile(join(home, "auth.json"), await readFile(login), {
      mode: 0o600,
    });
    return await readRateLimits(
      executable,
      { ...process.env, CODEX_HOME: home },
      timeoutMs,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function readRateLimits(
  executable: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<number | null> {
  const server = spawn(executable, ["app-server"], {
    stdio: ["pipe", "pipe", "ignore"],
    env,
  });
  const exited = new Promise((resolve) => server.on("close", resolve));
  // One reader for the whole session: each reply settles its request by id.
  const pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  const abandon = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  server.on("error", abandon);
  createInterface({ input: server.stdout })
    .on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    })
    .on("close", () =>
      abandon(new Error("codex app-server closed before replying")),
    );
  const send = (message: object) =>
    server.stdin.write(`${JSON.stringify(message)}\n`);
  // The timers end with the read, rather than outlasting it.
  const timers = new AbortController();
  const request = (method: string, id: number, params?: object) => {
    const reply = new Promise((resolve, reject) =>
      pending.set(id, { resolve, reject }),
    );
    send({ method, id, params });
    return Promise.race([
      reply,
      sleep(timeoutMs, undefined, { signal: timers.signal }).then(timeout),
    ]);
  };
  try {
    await request("initialize", 0, {
      clientInfo: { name: "factory", title: "Factory", version: "1.0.0" },
    });
    send({ method: "initialized", params: {} });
    return codexUsage(await request("account/rateLimits/read", 1));
  } finally {
    timers.abort();
    server.kill();
    // The server writes into its Codex home until it exits, so the caller
    // removes that home only afterwards.
    if (server.pid !== undefined) await exited;
  }
}

function timeout(): never {
  throw new Error("timed out");
}

// The result of the Codex app-server's `account/rateLimits/read`.
export function codexUsage(result: any): number | null {
  const limits = result?.rateLimits;
  return fullest([
    limits?.primary?.usedPercent,
    limits?.secondary?.usedPercent,
  ]);
}
