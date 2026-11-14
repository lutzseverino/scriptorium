import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";

// The package's boundary with Repo Canon and the hosting platform: it imports
// Node.js, Sandcastle, Postern and Canon's installed result reader. The
// factory decides readiness without reading an issue's body or parsing Markdown.
const source = resolve(import.meta.dirname, "../src");

test("the package's modules import only each other and their declared runtime boundaries", () => {
  const files = readdirSync(source, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(source, file));
  assert.ok(files.length > 0);
  for (const file of files)
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(
      /^(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gms,
    )) {
      const where = `${relative(source, file)} imports ${specifier}`;
      if (specifier === "../vendor/repo-canon/validate-issue-contract.mjs")
        assert.equal(relative(source, file), "contract-result.ts", where);
      else if (specifier.startsWith("."))
        assert.ok(
          !relative(source, resolve(dirname(file), specifier)).startsWith(".."),
          where,
        );
      else
        assert.match(
          specifier,
          /^(node:|@ai-hero\/sandcastle\b|@lutzseverino\/postern$)/,
          where,
        );
    }
});

test("the package declares only its runtime boundaries as dependencies, so no Markdown parser", () => {
  const manifest = JSON.parse(
    readFileSync(join(source, "../package.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
    "@ai-hero/sandcastle",
    "@lutzseverino/postern",
  ]);
});

test("no module reads an issue's body; only Postern's adapter reads relationship sections", () => {
  for (const file of ["platform.ts", "readiness.ts", "factory.ts", "host.ts"])
    assert.doesNotMatch(
      readFileSync(join(source, file), "utf8"),
      // A transport request may have a body; issue content cannot be read or
      // destructured. The validator's result comment is read only in
      // contract-result.ts.
      /\.body\b|\{[^}]*\bbody\b[^}]*\}\s*=/,
      file,
    );
});
