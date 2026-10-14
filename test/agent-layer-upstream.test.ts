import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { agentLayer, verifiedDownloads } from "./agent-layer-fixture.ts";

test("both architectures' pins match upstream release digests", async (t) => {
  const releases = new Map<
    string,
    { assets: { name: string; digest: string }[] }
  >();
  const manifests = new Map<
    string,
    { platforms: Record<string, { checksum: string }> }
  >();
  const comparisons: { url: string; pinned: string; published: string }[] = [];
  try {
    for (const architecture of ["amd64", "arm64"]) {
      for (const { url, digest } of verifiedDownloads(
        agentLayer,
        architecture,
      )) {
        let published: string;
        const github = url.match(
          /^https:\/\/github.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/(.+)$/,
        );
        const claude = url.match(
          /^(https:\/\/downloads.claude.ai\/claude-code-releases\/[^/]+)\/([^/]+)\/claude$/,
        );
        if (github) {
          const [, repository, tag, name] = github;
          const endpoint = `repos/${repository}/releases/tags/${tag}`;
          if (!releases.has(endpoint))
            releases.set(
              endpoint,
              JSON.parse(
                execFileSync("gh", ["api", endpoint], {
                  encoding: "utf8",
                  timeout: 60_000,
                  stdio: ["ignore", "pipe", "pipe"],
                }),
              ),
            );
          published =
            releases.get(endpoint)!.assets.find((asset) => asset.name === name)
              ?.digest ?? "";
          assert.match(
            published,
            /^sha256:[0-9a-f]{64}$/,
            `${url} publishes a SHA-256`,
          );
          published = published.slice(7);
        } else {
          assert.ok(claude, `unknown upstream digest source: ${url}`);
          const [, base, platform] = claude;
          if (!manifests.has(base!)) {
            const response = await fetch(`${base}/manifest.json`, {
              signal: AbortSignal.timeout(60_000),
            });
            assert.ok(response.ok, `Claude manifest HTTP ${response.status}`);
            manifests.set(
              base!,
              (await response.json()) as {
                platforms: Record<string, { checksum: string }>;
              },
            );
          }
          published =
            manifests.get(base!)!.platforms[platform!]?.checksum ?? "";
        }
        comparisons.push({ url, pinned: digest, published });
      }
    }
  } catch (error) {
    // HTTP errors, missing assets and wrong digests are failures even locally.
    // Only an unavailable network may skip outside CI.
    const detail =
      String(error) +
      String((error as { cause?: unknown }).cause ?? "") +
      String((error as { stderr?: unknown }).stderr ?? "");
    if (
      !process.env.CI &&
      ((error as { name?: string }).name === "TimeoutError" ||
        /ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ETIMEDOUT|no such host|network is unreachable|connection refused|TLS handshake timeout|error connecting to [^\r\n]+[\s\S]*check your internet connection/.test(
          detail,
        ))
    ) {
      t.skip("upstream network unavailable locally");
      return;
    }
    throw error;
  }
  for (const { url, pinned, published } of comparisons)
    await t.test(url, () => assert.equal(pinned, published));
});
