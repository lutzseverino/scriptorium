import assert from "node:assert/strict";
import { test } from "node:test";
import { sandboxImageTag } from "../src/sandbox-image.ts";

test("sandbox image tags change only with the repository Dockerfile or agent layer version", () => {
  const dockerfile = "FROM debian:bookworm-slim\n";
  const tag = sandboxImageTag(dockerfile, "1");
  assert.match(tag, /^factory-sandbox:[a-f0-9]{64}$/);
  assert.equal(sandboxImageTag(dockerfile, "1"), tag);
  assert.notEqual(
    sandboxImageTag(`${dockerfile}RUN apt-get update\n`, "1"),
    tag,
  );
  assert.notEqual(sandboxImageTag(dockerfile, "2"), tag);
  assert.notEqual(sandboxImageTag("ab", "c"), sandboxImageTag("a", "bc"));
});
