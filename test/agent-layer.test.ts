import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { agentLayer, verifiedDownloads } from "./agent-layer-fixture.ts";

test("the factory layer installs process census and init packages", () => {
  const runs = agentLayer.replaceAll(/\\\n/g, "").match(/^RUN .*$/gm)!;
  const packages = runs.filter((run) => /\bapt-get\s+/.test(run));
  assert.equal(packages.length, 1, "distribution packages share one RUN");
  const output = execFileSync(
    "bash",
    [
      "-fc",
      `
        apt-get() { printf '%s\\n' "$*"; }
        rm() { :; }
      ` + packages[0]!.slice(4),
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  const installs = output
    .trim()
    .split("\n")
    .map((line) => line.split(/\s+/))
    .filter((args) => args[0] === "install");
  assert.ok(
    installs.some((args) => args.includes("procps")),
    "the actual apt-get install must request procps",
  );
  assert.ok(
    installs.some((args) => args.includes("tini")),
    "the actual apt-get install must request tini",
  );
});

for (const architecture of ["amd64", "arm64"]) {
  test(`every ${architecture} download has a pinned SHA-256 checked before use`, () => {
    verifiedDownloads(agentLayer, architecture);
  });
}

test("the guard rejects an added download without a digest", () => {
  const changed = agentLayer.replace(
    "    rm -rf /tmp/factory-tools",
    '    curl -fsSL "https://example.com/new-tool" -o /tmp/factory-tools/new-tool; \\\n    rm -rf /tmp/factory-tools',
  );
  assert.throws(
    () => verifiedDownloads(changed, "amd64"),
    /every download is checked/,
  );
});

test("the guard rejects extraction or installation before verification", () => {
  for (const use of [
    'tar -xzf "$3" -C /tmp/factory-tools;',
    'install -m 0755 "$3" /usr/local/bin/unchecked;',
  ]) {
    const changed = agentLayer.replace(
      'curl -fsSL "$1" -o "$3";',
      `curl -fsSL "$1" -o "$3"; ${use}`,
    );
    assert.throws(
      () => verifiedDownloads(changed, "amd64"),
      /must follow verification/,
    );
  }
});

test("the guard rejects malformed pins and a missing arm64 pin", () => {
  const pin = /git_sha256_arm64=[0-9a-f]{64};/;
  for (const digest of ["abc", "A".repeat(64)])
    assert.throws(
      () =>
        verifiedDownloads(
          agentLayer.replace(pin, `git_sha256_arm64=${digest};`),
          "arm64",
        ),
      /lowercase SHA-256/,
    );
  assert.throws(
    () => verifiedDownloads(agentLayer.replace(pin, ""), "amd64"),
    /has a arm64 pin/,
  );
});

test("the guard rejects bypassing the checksum command", () => {
  const changed = agentLayer.replace("sha256sum -c -", "cat >/dev/null");
  assert.throws(
    () => verifiedDownloads(changed, "amd64"),
    /must follow verification/,
  );
});
