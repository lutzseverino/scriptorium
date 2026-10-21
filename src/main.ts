// The factory process: `node src/main.ts <host configuration>` serves every
// repository the host configuration lists until it is stopped, and
// `node src/main.ts resume <host configuration> <provider>` queues the owner's
// resume request for it.
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { connect, detectPlatform } from "@lutzseverino/postern";
import { tokenCommand } from "./github-token.ts";
import { createHost } from "./host.ts";
import { readHostConfiguration } from "./host-configuration.ts";
import { createRegistry } from "./providers.ts";
import { pruneSandboxCache, retainSandboxImages } from "./image-retention.ts";
import { resume, resumeUsage } from "./resume.ts";
import { buildSandboxImage, docker, stopSandboxes } from "./sandbox-image.ts";

if (process.argv[2] === "resume")
  process.exit(
    resume(process.argv.slice(3), {
      now: () => new Date(),
      print: (line) => console.log(line),
      error: (line) => console.error(line),
    }),
  );

const path = process.argv[2];
if (process.argv.length !== 3) {
  console.error(
    `Usage: node src/main.ts <host configuration>\n   or: ${resumeUsage}`,
  );
  process.exit(2);
}
// The process log. Every line reaches it through the host, which redacts it,
// apart from the host configuration's warnings, which hold no secret.
function log(line: string) {
  console.log(`${new Date().toISOString()} ${line}`);
}

let configuration;
try {
  configuration = readHostConfiguration(path, log);
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
const remoteUrl = (repository: string) =>
  `https://github.com/${repository}.git`;

const host = createHost(configuration, registry, {
  connect,
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
  // The token command of the repository's platform.
  async token(repository) {
    const { platform } = detectPlatform(remoteUrl(repository));
    const settings = configuration.platforms[platform];
    if (!settings)
      throw new Error(
        `the host configuration has no settings for ${repository}'s platform, ${platform}`,
      );
    return tokenCommand(settings.tokenCommand)(repository);
  },
  remoteUrl,
  buildImage: (dockerfile) =>
    buildSandboxImage({
      dockerfile,
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
      builder: configuration.imageBuilder,
    }),
  retainImages: (current, running) =>
    retainSandboxImages((args) => docker(args), {
      repositories: configuration.repositories,
      current,
      running,
      obsoletePairs: configuration.imageRetention.obsoletePairs,
    }),
  pruneBuildCache: () =>
    pruneSandboxCache((args) => docker(args), {
      builder: configuration.imageBuilder,
      hours: configuration.imageRetention.cacheMinimumAgeHours,
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
