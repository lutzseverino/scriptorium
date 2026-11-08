import assert from "node:assert/strict";
import { test } from "node:test";
import { filingRun, trustedFinding, type Provenance } from "../src/triggers.ts";
import type { Actor } from "../src/readiness.ts";

const policy = {
  ready: "state:ready",
  authorizedRoles: ["admin"],
  neverAuthorize: [],
};
const record: Provenance = {
  id: "recorded-run",
  issue: 1,
  at: "2026-10-01T00:00:00Z",
  account: "factory[bot]",
  trusted: true,
};
const issue = {
  createdAt: "2026-10-02T00:00:00Z",
  author: { kind: "bot", login: "FACTORY[bot]" } as Actor,
  filingRun: record.id,
};

test("a finding's citation must identify a trusted host run and match its filing credential", () => {
  assert.equal(trustedFinding(issue, [record], policy), true);
  for (const records of [
    [],
    [{ ...record, trusted: false }],
    [{ ...record, account: "other[bot]" }],
    [{ ...record, account: null }],
    [{ ...record, at: "2026-10-03T00:00:00Z" }],
  ])
    assert.equal(trustedFinding(issue, records, policy), false);
  assert.equal(
    trustedFinding({ ...issue, filingRun: "forged" }, [record], policy),
    false,
  );
  assert.equal(
    trustedFinding(
      { ...issue, author: { kind: "user", login: "outsider", role: null } },
      [record],
      policy,
    ),
    false,
  );
  assert.equal(
    trustedFinding(issue, [record], {
      ...policy,
      neverAuthorize: ["factory[bot]"],
    }),
    false,
  );
});

test("only one exact machine citation is read; issue prose and malformed citations confer no trust", () => {
  const line = '<!-- scriptorium:filing-run {"run":"recorded-run"} -->';
  assert.equal(filingRun({ body: `A finding\n\n${line}\n` }), record.id);
  for (const body of [
    "recorded-run",
    `quoted ${line}`,
    `${line}\n${line}`,
    "<!-- scriptorium:filing-run {bad} -->",
    '<!-- scriptorium:filing-run {"run":2} -->',
  ])
    assert.equal(filingRun({ body }), null);
});
