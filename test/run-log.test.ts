import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createRedactor } from "../src/redaction.ts";
import { followRunLog, readLogEnd } from "../src/run-log.ts";
import { directory } from "./fakes.ts";

async function until(condition: () => boolean) {
  for (let wait = 0; wait < 200 && !condition(); wait++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition(), "the condition held in time");
}

test("each complete raw line is published redacted as it arrives, and closing publishes the rest", async (t) => {
  const root = directory(t);
  const raw = join(root, "agent.log");
  const published = join(root, "logs", "issue-4-attempt-1.log");
  const redactor = createRedactor();
  redactor.add("ghs_one");
  const log = await followRunLog(raw, published, redactor.redact);
  assert.equal(statSync(raw).mode & 0o777, 0o600);
  appendFileSync(raw, "token ghs_one\nhalf a li");
  await until(
    () => existsSync(published) && readFileSync(published, "utf8") !== "",
  );
  assert.equal(readFileSync(published, "utf8"), "token <REDACTED>\n");
  // A secret learned during the run is redacted from what follows.
  redactor.add("ghs_two");
  appendFileSync(raw, "ne ghs_two\nend ghs_one ✓");
  await log.close();
  assert.equal(
    readFileSync(published, "utf8"),
    "token <REDACTED>\nhalf a line <REDACTED>\nend <REDACTED> ✓",
  );
});

test("a raw log's end starts at the first whole line within its last bytes", async (t) => {
  const raw = join(directory(t), "agent.log");
  writeFileSync(raw, "");
  assert.equal(await readLogEnd(raw), "");
  writeFileSync(raw, "first\nsecond\nlast ✓\n");
  assert.equal(await readLogEnd(raw), "first\nsecond\nlast ✓\n");
  assert.equal(await readLogEnd(raw, 12), "last ✓\n");
  // One line fills the window.
  assert.equal(await readLogEnd(raw, 4), "✓\n");
  writeFileSync(raw, "first\nlast");
  assert.equal(await readLogEnd(raw, 3), "ast");
});
