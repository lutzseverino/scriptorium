import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connect } from "@lutzseverino/postern";
import { createQuota } from "../src/quota.ts";

test("observed frozen Postern ports pass calls and capabilities through", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "scriptorium-quota-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const base = connect("https://github.com/acme/widgets.git", {
    credential: () => "test-token",
  });
  const connection = {
    ...base,
    issueTracker: Object.freeze({
      ...base.issueTracker,
      issues: async () => [],
    }),
    pullRequests: Object.freeze({
      ...base.pullRequests,
      byHeadBranch: async (branch: string) => {
        assert.equal(branch, "fix/quota");
        return [];
      },
    }),
    releaseSource: Object.freeze({
      ...base.releaseSource,
      tagCommit: async (tag: string) => {
        assert.equal(tag, "scriptorium-v4.4.0");
        return "1746c54";
      },
    }),
    access: Object.freeze({
      ...base.access,
      request: async () => ({ status: 200, headers: {}, data: "available" }),
    }),
  };
  const quota = createQuota({
    repositories: ["acme/widgets"],
    connect: () => connection,
    now: () => new Date("2026-11-19T16:00:00Z"),
    path: join(directory, "quota.json"),
    report: assert.fail,
  });
  const observed = quota.observe("acme/widgets", connection);

  assert.deepEqual(await observed.issueTracker.issues(), []);
  assert.deepEqual(await observed.pullRequests.byHeadBranch("fix/quota"), []);
  assert.equal(
    await observed.releaseSource.tagCommit("scriptorium-v4.4.0"),
    "1746c54",
  );
  assert.deepEqual(await observed.access.request({ path: "/rate_limit" }), {
    status: 200,
    headers: {},
    data: "available",
  });
  for (const key of [
    "issueTracker",
    "pullRequests",
    "releaseSource",
    "access",
  ] as const) {
    assert.equal(observed[key].capabilities, connection[key].capabilities);
    assert.deepEqual(Object.keys(observed[key]), Object.keys(connection[key]));
  }
});
