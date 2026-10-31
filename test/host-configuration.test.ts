import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readHostConfiguration } from "../src/host-configuration.ts";
import { directory } from "./fakes.ts";

// Host configuration validation, driven by fixture files.
function fixture(name: string): string {
  return fileURLToPath(
    new URL(`fixtures/host-configuration/${name}.json`, import.meta.url),
  );
}

function refusal(name: string): string[] {
  return refused(fixture(name));
}

function refused(path: string): string[] {
  const warnings: string[] = [];
  try {
    readHostConfiguration(path, (warning) => warnings.push(warning));
  } catch (error) {
    assert.deepEqual(warnings, [], "an invalid configuration warns of nothing");
    return (error as Error).message.split("\n");
  }
  assert.fail(`${path} was accepted`);
}

// The configuration a file holds, and the warnings reading it gave.
function read(path: string) {
  const warnings: string[] = [];
  const configuration = readHostConfiguration(path, (warning) =>
    warnings.push(warning),
  );
  return { configuration, warnings };
}

test("a complete host configuration is read as written", () => {
  assert.deepEqual(read(fixture("valid")).warnings, []);
  assert.deepEqual(read(fixture("valid")).configuration, {
    repositories: ["acme/widgets", "acme/gadgets"],
    providers: {
      "claude-code": { cap: 2, credential: "/etc/factory/claude-token" },
      codex: { cap: 1, credential: "/etc/factory/codex-auth.json" },
    },
    models: { default: "claude-sonnet-5-5", retry: "claude-opus-5-5@xhigh" },
    timeLimitMinutes: 240,
    usage: {
      drainThreshold: 90,
      pauseThreshold: 95,
      afterDrain: "auto-resume",
    },
    pollSeconds: 300,
    platforms: {
      github: {
        tokenCommand: ["/usr/local/bin/factory-token", "--app", "7"],
        authorizedRoles: ["admin", "maintain"],
        neverAuthorize: ["dependabot[bot]"],
      },
    },
    unpushablePaths: [".github/workflows/"],
    stateDirectory: "/var/lib/factory",
    gitIdentity: { name: "factory[bot]", email: "factory@example.com" },
    imageBuilder: "daemon",
    imageRetention: { obsoletePairs: 3, cacheMinimumAgeHours: 24 },
  });
});

test("readiness and github, the form before platforms, are read as GitHub's platform settings", () => {
  const { platforms, ...rest } = read(fixture("valid")).configuration;
  assert.deepEqual(read(fixture("github-shorthand")), {
    configuration: {
      ...rest,
      platforms: {
        github: {
          tokenCommand: ["/usr/local/bin/factory-token", "--app", "7"],
          authorizedRoles: ["admin", "maintain"],
        },
      },
    },
    warnings: [],
  });
  assert.deepEqual(platforms.github!.authorizedRoles, ["admin", "maintain"]);
});

test("the form before platforms can't be set alongside platforms, and a configuration without either names platforms", (t) => {
  const path = join(directory(t), "host.json");
  const valid = JSON.parse(readFileSync(fixture("valid"), "utf8"));
  const shorthand = JSON.parse(
    readFileSync(fixture("github-shorthand"), "utf8"),
  );
  writeFileSync(
    path,
    JSON.stringify({
      ...valid,
      readiness: shorthand.readiness,
      github: shorthand.github,
    }),
  );
  assert.deepEqual(refused(path), [
    `The host configuration ${path} is invalid:`,
    "- readiness: is GitHub's setting in the form before platforms and can't be set with platforms; move it into platforms.github",
    "- github: is GitHub's setting in the form before platforms and can't be set with platforms; move it into platforms.github",
  ]);
  const { platforms: _, ...without } = valid;
  writeFileSync(path, JSON.stringify(without));
  assert.deepEqual(refused(path), [
    `The host configuration ${path} is invalid:`,
    "- platforms: is missing",
  ]);
  writeFileSync(path, JSON.stringify({ ...valid, platforms: {} }));
  assert.deepEqual(refused(path), [
    `The host configuration ${path} is invalid:`,
    "- platforms: is empty",
  ]);
  // The accounts that never authorize are optional and may be none.
  for (const neverAuthorize of [undefined, []]) {
    const github = { ...valid.platforms.github, neverAuthorize };
    writeFileSync(path, JSON.stringify({ ...valid, platforms: { github } }));
    assert.deepEqual(
      read(path).configuration.platforms.github!.neverAuthorize,
      neverAuthorize,
    );
  }
});

test("each platform's role names, accounts and token command are validated", () => {
  assert.deepEqual(refusal("platforms-malformed"), [
    `The host configuration ${fixture("platforms-malformed")} is invalid:`,
    "- platforms.github.botMarking: is not a host configuration field",
    "- platforms.github.tokenCommand: is empty",
    '- platforms.github.authorizedRoles[0]: "Admin" is not one of admin, maintain, write, triage, read',
    '- platforms.github.authorizedRoles[2]: repeats "maintain"',
    '- platforms.github.neverAuthorize[1]: repeats "Dependabot[bot]"',
    '- platforms.github.neverAuthorize[2]: "two words" is not an account login',
    "- platforms.github.neverAuthorize[3]: is not a non-empty string",
    "- platforms.gitlab: is not a platform Postern serves; choose github",
  ]);
});

test("images build with the daemon's own builder unless the host opts into the factory builder", (t) => {
  const path = join(directory(t), "host.json");
  const valid = JSON.parse(readFileSync(fixture("valid"), "utf8"));
  assert.equal(Object.hasOwn(valid, "imageBuilder"), false);
  for (const builder of ["daemon", "factory"]) {
    writeFileSync(path, JSON.stringify({ ...valid, imageBuilder: builder }));
    assert.deepEqual(read(path), {
      configuration: {
        ...read(fixture("valid")).configuration,
        imageBuilder: builder,
      },
      warnings: [],
    });
  }
  for (const builder of ["buildx", "Factory", "default"]) {
    writeFileSync(path, JSON.stringify({ ...valid, imageBuilder: builder }));
    assert.deepEqual(refused(path), [
      `The host configuration ${path} is invalid:`,
      `- imageBuilder: ${JSON.stringify(builder)} is not one of daemon, factory`,
    ]);
  }
  for (const builder of [null, "", true, 1]) {
    writeFileSync(path, JSON.stringify({ ...valid, imageBuilder: builder }));
    assert.deepEqual(refused(path), [
      `The host configuration ${path} is invalid:`,
      "- imageBuilder: is not a non-empty string",
    ]);
  }
});

test("image retention has defaults, and each setting may be given alone", (t) => {
  const path = join(directory(t), "host.json");
  const valid = JSON.parse(readFileSync(fixture("valid"), "utf8"));
  for (const [given, retention] of [
    [{}, { obsoletePairs: 3, cacheMinimumAgeHours: 24 }],
    [{ obsoletePairs: 0 }, { obsoletePairs: 0, cacheMinimumAgeHours: 24 }],
    [
      { cacheMinimumAgeHours: 168 },
      { obsoletePairs: 3, cacheMinimumAgeHours: 168 },
    ],
    [
      { obsoletePairs: 10, cacheMinimumAgeHours: 1 },
      { obsoletePairs: 10, cacheMinimumAgeHours: 1 },
    ],
  ]) {
    writeFileSync(path, JSON.stringify({ ...valid, imageRetention: given }));
    assert.deepEqual(read(path), {
      configuration: {
        ...read(fixture("valid")).configuration,
        imageRetention: retention,
      },
      warnings: [],
    });
  }
  writeFileSync(path, JSON.stringify({ ...valid, imageRetention: null }));
  assert.deepEqual(refused(path), [
    `The host configuration ${path} is invalid:`,
    "- imageRetention: is not an object",
  ]);
});

test("Claude Code accepts an optional absolute usage credential without changing other settings", (t) => {
  const configuration = JSON.parse(readFileSync(fixture("valid"), "utf8"));
  configuration.providers["claude-code"].usageCredential =
    "/etc/factory/claude-usage.json";
  const path = join(directory(t), "host.json");
  writeFileSync(path, JSON.stringify(configuration));
  assert.deepEqual(read(path).configuration, {
    ...configuration,
    imageBuilder: "daemon",
  });

  for (const value of [null, "", 42, "relative/login.json"]) {
    configuration.providers["claude-code"].usageCredential = value;
    writeFileSync(path, JSON.stringify(configuration));
    assert.throws(
      () => readHostConfiguration(path, assert.fail),
      /providers\.claude-code\.usageCredential:/,
    );
  }
  delete configuration.providers["claude-code"].usageCredential;
  configuration.providers.codex.usageCredential = "/etc/factory/other.json";
  writeFileSync(path, JSON.stringify(configuration));
  assert.throws(
    () => readHostConfiguration(path, assert.fail),
    /providers\.codex\.usageCredential: is not a host configuration field/,
  );
});

test("every missing required field is named", () => {
  assert.deepEqual(refusal("missing"), [
    `The host configuration ${fixture("missing")} is invalid:`,
    "- providers.claude-code.cap: is missing",
    "- models.retry: is missing",
    "- usage.drainThreshold: is missing",
    "- pollSeconds: is missing",
    "- readiness.authorizedRoles: is missing",
    "- github: is missing",
  ]);
});

test("unknown fields and providers without an adapter are refused", () => {
  assert.deepEqual(refusal("unknown"), [
    `The host configuration ${fixture("unknown")} is invalid:`,
    "- labels: is not a host configuration field",
    "- providers.claude-code.env: is not a host configuration field",
    "- providers.cursor: has no adapter; choose claude-code or codex",
    "- usage.reserve: is not a host configuration field",
    "- imageRetention.obsoleteImages: is not a host configuration field",
  ]);
});

test("malformed values are refused with every correction", () => {
  assert.deepEqual(refusal("malformed"), [
    `The host configuration ${fixture("malformed")} is invalid:`,
    '- repositories[1]: repeats "ACME/Widgets"',
    '- repositories[2]: "widgets" is not <owner>/<name>',
    "- providers.claude-code.cap: -1 is not a whole number of agents",
    '- providers.claude-code.credential: "claude-token" is not an absolute path',
    "- models.retry: is not a non-empty string",
    "- timeLimitMinutes: 0 is not a positive number of minutes a timer can wait",
    "- usage.drainThreshold: 120 is not a percentage from 0 to 100",
    "- usage.pauseThreshold: is not a number",
    '- usage.afterDrain: "later" is not one of auto-resume, owner-resume',
    "- pollSeconds: is not a number",
    '- readiness.authorizedRoles[0]: "owner" is not one of admin, maintain, write, triage, read',
    '- readiness.authorizedRoles[2]: repeats "admin"',
    '- unpushablePaths[0]: "/etc" is not a path inside the repository',
    '- unpushablePaths[1]: "../outside" is not a path inside the repository',
    "- unpushablePaths[2]: is not a non-empty string",
    '- stateDirectory: "state" is not an absolute path',
    "- gitIdentity.name: is not a non-empty string",
    "- github.tokenCommand: is empty",
    '- imageBuilder: "buildkit" is not one of daemon, factory',
    "- imageRetention.obsoletePairs: 1.5 is not a whole number of image pairs",
    "- imageRetention.cacheMinimumAgeHours: 0 is not a positive whole number of hours",
  ]);
});

test("the usage thresholds may be off, and the pause threshold and after-drain policy have defaults", () => {
  const { configuration, warnings } = read(fixture("usage-defaults"));
  assert.deepEqual(configuration.usage, {
    drainThreshold: null,
    pauseThreshold: null,
    afterDrain: "auto-resume",
  });
  assert.deepEqual(warnings, []);
});

test("a pause threshold below the drain threshold is refused", (t) => {
  assert.deepEqual(refusal("usage-misordered"), [
    `The host configuration ${fixture("usage-misordered")} is invalid:`,
    "- usage.pauseThreshold: 90 is below usage.drainThreshold, 95",
  ]);
  // Equal thresholds are allowed, the drain and the pause starting together,
  // and so is the owner-resume policy.
  const equal = join(directory(t), "host.json");
  const valid = JSON.parse(readFileSync(fixture("valid"), "utf8"));
  writeFileSync(
    equal,
    JSON.stringify({
      ...valid,
      usage: {
        drainThreshold: 95,
        pauseThreshold: 95,
        afterDrain: "owner-resume",
      },
    }),
  );
  assert.deepEqual(read(equal).configuration.usage, {
    drainThreshold: 95,
    pauseThreshold: 95,
    afterDrain: "owner-resume",
  });
});

test("for one release the legacy usageThreshold is read as the drain threshold, with a callback warning", () => {
  const { configuration, warnings } = read(fixture("legacy"));
  assert.deepEqual(configuration, {
    ...read(fixture("github-shorthand")).configuration,
    usage: {
      drainThreshold: 80,
      pauseThreshold: null,
      afterDrain: "auto-resume",
    },
  });
  assert.equal("usageThreshold" in configuration, false);
  assert.deepEqual(warnings, [
    `The host configuration ${fixture("legacy")}: usageThreshold is deprecated and read as usage.drainThreshold for this factory release; replace it with "usage": { "drainThreshold": 80 }`,
  ]);
});

test("one-argument callers migrate usageThreshold and warn on stderr", () => {
  const validator = new URL("../src/host-configuration.ts", import.meta.url)
    .href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { readHostConfiguration } from ${JSON.stringify(validator)};
       console.log(JSON.stringify(readHostConfiguration(process.argv[1])));`,
      fixture("legacy"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const { configuration, warnings } = read(fixture("legacy"));
  assert.deepEqual(JSON.parse(result.stdout), configuration);
  assert.equal(result.stderr, `${warnings[0]}\n`);
});

test("the legacy usageThreshold is refused alongside usage, and named when invalid", (t) => {
  assert.deepEqual(refusal("legacy-and-usage"), [
    `The host configuration ${fixture("legacy-and-usage")} is invalid:`,
    "- usageThreshold: is the deprecated form of usage.drainThreshold and can't be set with usage; remove it",
  ]);
  const invalid = join(directory(t), "host.json");
  const legacy = JSON.parse(readFileSync(fixture("legacy"), "utf8"));
  writeFileSync(invalid, JSON.stringify({ ...legacy, usageThreshold: 120 }));
  assert.deepEqual(refused(invalid), [
    `The host configuration ${invalid} is invalid:`,
    "- usageThreshold: 120 is not a percentage from 0 to 100",
  ]);
});

test("models the configured providers cannot run are refused", () => {
  assert.deepEqual(refusal("unresolvable-models"), [
    `The host configuration ${fixture("unresolvable-models")} is invalid:`,
    "- models.default: model claude-sonnet-5-5 names no provider; name it <provider>/claude-sonnet-5-5, choose codex",
    '- models.retry: effort "max" is not one codex accepts: low, medium, high, xhigh',
  ]);
});

test("a file that is not JSON or does not exist is refused", (t) => {
  const truncated = join(directory(t), "host.json");
  writeFileSync(truncated, '{ "repositories": ["acme/widgets"],\n');
  assert.throws(() => readHostConfiguration(truncated, assert.fail), {
    message: new RegExp(
      `^The host configuration ${truncated} is not JSON: SyntaxError`,
    ),
  });
  assert.match(
    refusal("absent")[0],
    /^The host configuration .*absent\.json is unreadable: Error: ENOENT/,
  );
});

test("an invalid host configuration stops the process with its reason", () => {
  const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const stopped = spawnSync(process.execPath, [main, fixture("missing")], {
    encoding: "utf8",
  });
  assert.equal(stopped.status, 1);
  assert.equal(stopped.stdout, "");
  assert.equal(
    stopped.stderr,
    [
      `The host configuration ${fixture("missing")} is invalid:`,
      "- providers.claude-code.cap: is missing",
      "- models.retry: is missing",
      "- usage.drainThreshold: is missing",
      "- pollSeconds: is missing",
      "- readiness.authorizedRoles: is missing",
      "- github: is missing",
      "",
    ].join("\n"),
  );
  const usage = spawnSync(process.execPath, [main], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.equal(
    usage.stderr,
    "Usage: node src/main.ts <host configuration>\n   or: node src/main.ts resume <host configuration> <provider> [--drain-threshold N]\n",
  );
});

test("storage admission and dedicated cache targets are opt-in and validated in bytes", (t) => {
  const path = join(directory(t), "host.json");
  const base = JSON.parse(readFileSync(fixture("valid"), "utf8"));
  const imageStorage = {
    storePaths: ["/var/lib/containerd", "/var/lib/docker"],
    cachePath: "/var/lib/docker/volumes/factory-sandbox/_data",
    reserveBytes: 16106127360,
    resumeBytes: 18253611008,
  };
  for (const imageBuilder of ["daemon", "factory"]) {
    writeFileSync(
      path,
      JSON.stringify({
        ...base,
        imageBuilder,
        imageStorage,
        imageRetention: { cacheMaximumBytes: 8000000000 },
      }),
    );
    const loaded = read(path).configuration;
    assert.deepEqual(loaded.imageStorage, imageStorage);
    assert.equal(loaded.imageRetention.cacheMaximumBytes, 8000000000);
    assert.equal(loaded.imageBuilder, imageBuilder);
  }
  for (const change of [
    { reserveBytes: 0 },
    { resumeBytes: -1 },
    { reserveBytes: 1.5 },
    { resumeBytes: imageStorage.reserveBytes },
    { resumeBytes: 1 },
    { storePaths: [] },
    { storePaths: ["relative"] },
    { storePaths: ["/store/../wrong"] },
    { cachePath: "relative" },
    { storePaths: ["/store\u0000bad"] },
  ]) {
    writeFileSync(
      path,
      JSON.stringify({ ...base, imageStorage: { ...imageStorage, ...change } }),
    );
    assert.throws(() => read(path), /imageStorage/);
  }
  writeFileSync(
    path,
    JSON.stringify({
      ...base,
      imageBuilder: "factory",
      imageStorage: { ...imageStorage, cachePath: undefined },
    }),
  );
  assert.throws(() => read(path), /imageStorage.cachePath/);
  for (const cacheMaximumBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    writeFileSync(
      path,
      JSON.stringify({ ...base, imageRetention: { cacheMaximumBytes } }),
    );
    assert.throws(() => read(path), /cacheMaximumBytes/);
  }
});

test("allowed models resolve uniquely without efforts and include default and retry", (t) => {
  const path = join(directory(t), "host.json");
  const base = JSON.parse(readFileSync(fixture("valid"), "utf8"));
  const allowed = ["claude-sonnet-5-5", "claude-code/claude-opus-5-5"];
  writeFileSync(
    path,
    JSON.stringify({ ...base, models: { ...base.models, allowed } }),
  );
  assert.deepEqual(read(path).configuration.models.allowed, allowed);
  for (const [entries, problem] of [
    [[], /models.allowed: is empty/],
    [[...allowed, "claude-opus-5-5"], /models.allowed\[2\]: repeats/],
    [[...allowed, "gpt-5.5@high"], /models.allowed\[2\]:.*effort/],
    [[...allowed, "unknown/model"], /models.allowed\[2\]:.*not configured/],
    [["claude-sonnet-5-5"], /models.retry:.*not in models.allowed/],
    [["claude-opus-5-5"], /models.default:.*not in models.allowed/],
  ] as const) {
    writeFileSync(
      path,
      JSON.stringify({ ...base, models: { ...base.models, allowed: entries } }),
    );
    assert.throws(() => read(path), problem);
  }
});
