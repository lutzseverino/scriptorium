import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const agentLayer = readFileSync(
  new URL("../src/agent-layer.Dockerfile", import.meta.url),
  "utf8",
);

// Execute the actual install RUN with command spies: no Docker, downloads or
// filesystem changes. This exercises both architecture branches and shell
// expansion, rather than maintaining another copy of the URLs and versions.
export function installEvents(layer: string, architecture: string): string[][] {
  const runs = layer.replaceAll(/\\\n/g, "").match(/^RUN .*$/gm)!;
  const downloads = runs.filter((run) => /\bcurl\s+-/.test(run));
  assert.equal(downloads.length, 1, "all downloads belong to the guarded RUN");
  const spies = `
    test_arch=$1
    dpkg() { printf '%s\\n' "$test_arch"; }
    mkdir() { :; }
    rm() { :; }
    curl() {
      test "$#" = 4 && test "$1" = -fsSL && test "$3" = -o || exit 1
      printf 'download\\t%s\\t%s\\n' "$2" "$4"
    }
    sha256sum() {
      test "$#" = 2 && test "$1" = -c && test "$2" = - || exit 1
      read -r digest destination
      printf 'check\\t%s\\t%s\\n' "$digest" "$destination"
    }
    tar() { printf 'extract\\t%s\\n' "$2"; }
    install() { printf 'install\\t%s\\t%s\\n' "$3" "$4"; }
    chmod() { printf 'chmod\\t%s\\n' "$2"; }
  `;
  return execFileSync(
    "sh",
    ["-c", spies + downloads[0]!.slice(4), "sh", architecture],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  )
    .trim()
    .split("\n")
    .map((line) => line.split("\t"));
}

export function verifiedDownloads(layer: string, architecture: string) {
  const pins = new Map(
    [...layer.matchAll(/\b(\w+)_sha256_(amd64|arm64)=([^;\s]+);/g)].map(
      ([, tool, arch, digest]) => [`${tool}_${arch}`, digest!],
    ),
  );
  for (const [pin, digest] of pins)
    assert.match(digest, /^[0-9a-f]{64}$/, `${pin} is a lowercase SHA-256`);
  const tools: Record<string, string> = {
    "git.tar.gz": "git",
    "gh.tar.gz": "gh",
    "codex.tar.gz": "codex",
    "codex-code-mode-host.tar.gz": "code_mode_host",
    claude: "claude",
  };
  const downloads: { url: string; digest: string; destination: string }[] = [];
  let pending: { url: string; destination: string } | undefined;
  let checked: string | undefined;
  for (const [command, first, second] of installEvents(layer, architecture)) {
    if (command === "download") {
      assert.equal(
        pending,
        undefined,
        "check each download before the next one",
      );
      assert.ok(
        second!.startsWith("/tmp/factory-tools/"),
        "download into staging",
      );
      pending = { url: first!, destination: second! };
      checked = undefined;
    } else if (command === "check") {
      assert.ok(pending, "a check follows its download");
      assert.equal(second, pending.destination, "check the downloaded file");
      const tool = tools[second!.split("/").at(-1)!];
      for (const arch of ["amd64", "arm64"])
        assert.ok(
          pins.has(`${tool}_${arch}`),
          `${pending.url} has a ${arch} pin`,
        );
      assert.equal(
        first,
        pins.get(`${tool}_${architecture}`),
        "select the matching pin",
      );
      downloads.push({ ...pending, digest: first! });
      checked = pending.destination;
      pending = undefined;
    } else {
      assert.equal(pending, undefined, `${command} must follow verification`);
      assert.ok(checked, `${command} needs a verified download`);
      if (command === "extract") assert.equal(first, checked);
      if (command === "install" && first === "/tmp/factory-tools/claude")
        assert.equal(first, checked);
    }
  }
  assert.equal(pending, undefined, "every download is checked");
  assert.equal(downloads.length, Object.keys(tools).length);
  return downloads;
}
