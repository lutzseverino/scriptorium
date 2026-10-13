import assert from "node:assert/strict";
import { test } from "node:test";
import { createRedactor } from "../src/redaction.ts";

test("every secret added is redacted wherever it appears", () => {
  const redactor = createRedactor();
  assert.equal(redactor.redact("nothing to hide"), "nothing to hide");
  redactor.add("ghs_one");
  redactor.add("a.b+c(d)|e/f");
  redactor.add("ghs_one");
  assert.equal(
    redactor.redact("ghs_one, ghs_one and a.b+c(d)|e/f but not aXb+c"),
    "<REDACTED>, <REDACTED> and <REDACTED> but not aXb+c",
  );
});

test("a secret containing another is redacted whole", () => {
  const redactor = createRedactor();
  redactor.add("token");
  redactor.add("token-and-more");
  assert.equal(redactor.redact("token-and-more"), "<REDACTED>");
});

test("a blank secret is ignored", () => {
  const redactor = createRedactor();
  redactor.add("");
  redactor.add(" \n");
  assert.equal(redactor.redact("a b\n"), "a b\n");
});
