// The factory process: `node src/main.ts <host configuration>` serves every
// repository the host configuration lists until it is stopped.
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { tokenCommand } from "./github-token.ts";
import { createHost } from "./host.ts";
import { readHostConfiguration } from "./host-configuration.ts";
import { createRegistry } from "./providers.ts";
import { buildSandboxImage, stopSandboxes } from "./sandbox-image.ts";

const path = process.argv[2];
if (process.argv.length !== 3) {
  console.error("Usage: node src/main.ts <host configuration>");
  process.exit(2);
}
let configuration;
try {
  configuration = readHostConfiguration(path);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

// Git never prompts, including the fetches Sandcastle makes in the clones.
process.env.GIT_TERMINAL_PROMPT = "0";

const run = promisify(execFile);
const maxBuffer = 64 * 1024 * 1024;

// Git asks this helper for GitHub credentials, and it answers with the token
// in its environment, so the token is in no command line or Git config.
const credentialHelper =
  '!f() { test "$1" = get && echo username=x-access-token && echo "password=$FACTORY_GITHUB_TOKEN"; }; f';

const registry = createRegistry(configuration.providers);

// The process log. Every line reaches it through the host, which redacts it.
function log(line: string) {
  console.log(`${new Date().toISOString()} ${line}`);
}

const host = createHost(configuration, registry, {
  async gh(token, args) {
    const { stdout } = await run("gh", args, {
      env: { ...process.env, GH_TOKEN: token, GH_PROMPT_DISABLED: "1" },
      maxBuffer,
    });
    return stdout;
  },
  async git(token, cwd, args) {
    const { stdout } = await run(
      "git",
      [
        "-c",
        "credential.https://github.com.helper=",
        "-c",
        `credential.https://github.com.helper=${credentialHelper}`,
        ...args,
      ],
      { cwd, env: { ...process.env, FACTORY_GITHUB_TOKEN: token }, maxBuffer },
    );
    return stdout;
  },
  token: tokenCommand(configuration.github.tokenCommand),
  remoteUrl: (repository) => `https://github.com/${repository}.git`,
  buildImage: (dockerfile) =>
    buildSandboxImage({
      dockerfile,
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
    }),
  readUsage: (provider) => registry.providers.get(provider)!.readUsage(),
  launch: (provider, request) =>
    registry.providers.get(provider)!.launch(request),
  stopSandboxes,
  now: () => new Date(),
  report: log,
});

// A restart doesn't drain: the process records its running runs as
// interrupted, so they launch again as the same attempts, removes their
// sandboxes and exits. Registered before any launch, this handler runs before
// Sandcastle's own, which would exit without those records.
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    host.report(`${signal} received; interrupting the running runs`);
    try {
      host.interrupt();
    } catch (error) {
      host.report(`the runs were not fully interrupted: ${error}`);
      process.exit(1);
    }
    process.exit(0);
  });

// Tokens are refreshed every minute, whether or not a pass is running, so a
// long pass or poll never lets a running sandbox's token expire.
(async () => {
  for (;;) {
    await sleep(60_000);
    await host.refreshTokens();
  }
})();

for (;;) {
  try {
    for (const decision of await host.tick())
      if (decision.kind !== "skip") host.report(JSON.stringify(decision));
  } catch (error) {
    host.report(`pass failed: ${error}`);
  }
  await sleep(configuration.pollSeconds * 1000);
}
