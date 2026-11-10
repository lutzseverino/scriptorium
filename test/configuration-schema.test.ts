import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  checkReleaseArtifact,
  configurationSchemaUrl,
} from "../scripts/check-release-artifact.ts";

// Resolve the release URL namespace against the candidate artifact before its
// tag exists. The release procedure repeats this against the public URLs.
const candidate = (url: string) => {
  const prefix =
    "https://raw.githubusercontent.com/lutzseverino/scriptorium/scriptorium-v4.1.0/";
  assert.ok(url.startsWith(prefix), `unexpected artifact URL: ${url}`);
  return readFile(
    new URL(`../${url.slice(prefix.length)}`, import.meta.url),
    "utf8",
  );
};

test("the candidate release resolves its schema, supported fixtures and same-tag docs", async () => {
  await checkReleaseArtifact(configurationSchemaUrl, candidate);
});

test("the release artifact check refuses unresolved schema and documentation URLs", async () => {
  for (const missing of [
    "schemas/factory-configuration.schema.json",
    "docs/usage/factory-configuration.md",
    "docs/usage/sandbox-image.md",
  ])
    await assert.rejects(
      checkReleaseArtifact(configurationSchemaUrl, async (url) => {
        if (url.endsWith(missing)) throw new Error("HTTP 404");
        return candidate(url);
      }),
      /HTTP 404/,
    );
});

test("the release artifact check refuses moving schema or documentation references", async () => {
  await assert.rejects(
    checkReleaseArtifact(
      configurationSchemaUrl.replace("scriptorium-v4.1.0", "main"),
      candidate,
    ),
    /release tag/,
  );
  for (const field of ["$id", "description"])
    await assert.rejects(
      checkReleaseArtifact(configurationSchemaUrl, async (url) => {
        const text = await candidate(url);
        if (url !== configurationSchemaUrl) return text;
        const schema = JSON.parse(text);
        schema[field] = schema[field].replaceAll("scriptorium-v4.1.0", "main");
        return JSON.stringify(schema);
      }),
      /public URL|description must link/,
    );
});
