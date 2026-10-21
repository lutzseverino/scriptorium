import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";

// The package's boundary with Repo Canon and the hosting platform: it imports
// nothing from outside itself but Node.js, Sandcastle and Postern, and decides
// readiness without reading an issue's body.
const source = resolve(import.meta.dirname, "../src");

test("the package's modules import only each other, Node.js, Sandcastle and Postern", () => {
  const files = readdirSync(source, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(source, file));
  assert.ok(files.length > 0);
  for (const file of files)
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(
      /^(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gms,
    )) {
      const where = `${relative(source, file)} imports ${specifier}`;
      if (specifier.startsWith("."))
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

test("no module reads an issue's body; only Postern's adapter reads relationship sections", () => {
  for (const file of ["platform.ts", "readiness.ts", "factory.ts", "host.ts"])
    assert.doesNotMatch(
      readFileSync(join(source, file), "utf8"),
      /\.body\b|\bbody:|\{[^}]*\bbody\b[^}]*\}\s*=/,
      file,
    );
});
