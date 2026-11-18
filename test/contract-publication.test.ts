import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConnectionWithLinkAdditions } from "@lutzseverino/postern";
import { repositoryPlatform } from "../src/platform.ts";
import {
  parseRunResult,
  resultPost,
  type RunResult,
} from "../src/run-result.ts";
import { reviewAttestation } from "../src/review-attestation.ts";
import { contractResultHold, triageBacked } from "../src/contract-result.ts";
import {
  readContractMode,
  ContractPublicationHold,
  ContractPublicationStop,
  digest,
} from "../src/contract-protocol.ts";
import type {
  Publication,
  PublicationProgress,
} from "../src/contract-publication.ts";
import {
  contractFixture,
  contractConfiguration,
  brief,
  directTicket,
} from "./contract-fixture.ts";

const run = {
  id: "triage-7",
  kind: "triage" as const,
  provider: "codex",
  model: "gpt-6.1-sol",
  effort: "high",
  attempt: 1,
};
const post = (configuration = contractConfiguration) =>
  resultPost(
    {
      outcome: "done",
      state: "state:ready",
      labels: ["type:enhancement", "model:gpt-6.1-sol"],
      body: brief,
    },
    run,
    configuration,
  );
function setup(configuration = contractConfiguration) {
  const fixture = contractFixture();
  const unused = () => {
    throw new Error("unexpected port");
  };
  const connection = fixture.wrap({
    repository: {
      platform: "github",
      host: "github.com",
      path: "acme/widgets",
    },
    issueTracker: { capabilities: { bodyEditTime: true } },
    access: {
      request: unused,
      async role() {
        return "admin";
      },
    },
  } as unknown as ConnectionWithLinkAdditions);
  fixture.evaluate();
  const platform = () => repositoryPlatform(connection, configuration);
  let checkpoint: Publication | undefined;
  const resume = (): PublicationProgress => ({
    state: structuredClone(checkpoint),
    now: () => new Date("2026-10-09T00:00:00Z"),
    save(state) {
      checkpoint = structuredClone(state);
    },
  });
  return {
    fixture,
    connection,
    platform,
    resume,
    get checkpoint() {
      return checkpoint;
    },
  };
}

test("notice-free prepared intake publishes evidence before waiting for evaluation", async () => {
  const { decideIssueContract } = await import(
    new URL("../vendor/repo-canon/validate-issue-contract.mjs", import.meta.url)
      .href
  );
  const s = setup();
  s.fixture.controls.mode = "prepared";
  s.fixture.issue.labels = ["type:bug", "state:triage"];
  s.fixture.issue.body =
    "### Steps to reproduce\n\nRun the factory.\n\n### Expected behavior\n\nPublish the brief.\n\n### Actual behavior\n\nPublication holds.\n";
  const decision = decideIssueContract({
    issue: {
      ...s.fixture.issue,
      labels: s.fixture.issue.labels.map((name) => ({ name })),
    },
    comments: [],
    issueEvents: [],
    permissions: {},
    event: { kind: "opened", actor: "owner" },
  });
  assert.equal(decision.message, "Valid bug report.");
  assert.equal(decision.feedback, null);
  s.fixture.controls.missingResult = decision.feedback === null;
  assert.equal(await s.platform().postResult(4, post(), s.resume()), null);
  assert.equal(s.fixture.comments.length, 1);
  assert.match(s.fixture.comments[0].body, /Agent Brief/);
  assert.equal(s.fixture.issue.labels.includes("state:ready"), false);
  assert.equal(await s.platform().postResult(4, post(), s.resume()), null);
  assert.equal(s.fixture.comments.length, 1);
});

for (const boundary of [
  "ledger",
  "body",
  "after-body",
  "comment",
  "after-comment",
  "dispatch",
  "labels",
  "edits",
])
  test(`publication recovers after ${boundary} failure without duplicate evidence/body/ready events`, async () => {
    const s = setup();
    s.fixture.controls.fail = boundary;
    await assert.rejects(
      s.platform().postResult(4, post(), s.resume()),
      new RegExp(`interrupted ${boundary}`),
    );
    const link = await s.platform().postResult(4, post(), s.resume());
    assert.match(link!, /github.com/);
    assert.equal(s.checkpoint?.readyRequested, true);
    assert.equal(s.fixture.writes.filter((w) => w === "body").length, 1);
    assert.equal(s.fixture.writes.filter((w) => w === "attestation").length, 1);
    assert.equal(
      s.fixture.changes.filter((c) => c.label === "state:ready").length,
      1,
    );
    assert.equal(s.fixture.issue.body.split("## Original request").length, 2);
    const proof = structuredClone(s.fixture.record!.publication);
    await s.platform().postResult(4, post(), s.resume());
    assert.deepEqual(s.fixture.record!.publication, proof);
    assert.equal(
      s.fixture.changes.filter((c) => c.label === "state:ready").length,
      1,
    );
  });

test("no readiness precedes the body notice or the matching proof notice", async () => {
  const s = setup();
  s.fixture.controls.evaluation = false;
  assert.equal(await s.platform().postResult(4, post(), s.resume()), null);
  assert.equal(s.fixture.writes.includes("body"), true);
  assert.equal(s.fixture.writes.includes("attestation"), false);
  assert.equal(s.fixture.issue.labels.includes("state:ready"), false);
  s.fixture.controls.evaluation = true;
  s.fixture.controls.fail = "dispatch";
  await assert.rejects(
    s.platform().postResult(4, post(), s.resume()),
    /interrupted dispatch/,
  );
  assert.equal(s.fixture.writes.includes("attestation"), true);
  assert.equal(s.fixture.issue.labels.includes("state:ready"), false);
  assert.ok(await s.platform().postResult(4, post(), s.resume()));
});

test("a concurrent human edit is held instead of overwritten on retry", async () => {
  const s = setup();
  s.fixture.controls.fail = "body";
  await assert.rejects(s.platform().postResult(4, post(), s.resume()));
  s.fixture.issue.body = "Human replacement";
  s.fixture.edits.I_4 = { id: "HUMAN_EDIT", editedAt: "2026-10-08T01:01:00Z" };
  await assert.rejects(
    s.platform().postResult(4, post(), s.resume()),
    /changed before body publication/,
  );
  assert.equal(s.fixture.issue.body, "Human replacement");
  assert.equal(s.fixture.writes.includes("attestation"), false);
});

for (const tamper of ["body", "attestation", "restore", "delete"])
  test(`a ${tamper} change after evidence never replays old acceptance`, async () => {
    const s = setup();
    s.fixture.controls.fail = "dispatch";
    await assert.rejects(s.platform().postResult(4, post(), s.resume()));
    const evidence = s.fixture.comments.find((c) =>
      c.body.includes("triage-attestation"),
    )!;
    if (tamper === "body") s.fixture.edits.I_4.id = "OTHER_BODY_EDIT";
    if (tamper === "attestation") evidence.body += " edited";
    if (tamper === "restore")
      s.fixture.edits[evidence.nodeId!] = {
        id: "OTHER_ATTEST_EDIT",
        editedAt: "2026-10-08T01:03:00Z",
      };
    if (tamper === "delete")
      s.fixture.comments.splice(s.fixture.comments.indexOf(evidence), 1);
    await assert.rejects(
      s.platform().postResult(4, post(), s.resume()),
      ContractPublicationHold,
    );
    assert.equal(s.fixture.issue.labels.includes("state:ready"), false);
  });

test("same or unknown factory intake writer holds, while independent authenticated provenance qualifies", async () => {
  for (const writer of [null, "triage-7", "intake-1"]) {
    const s = setup();
    s.fixture.issue.author = { login: "factory[bot]", bot: true };
    const sourceEdit = s.fixture.edits.I_4;
    s.fixture.record = {
      issue: "I_4",
      cutoff: "a".repeat(40),
      migrated: false,
      retired: false,
      intake: {
        original: s.fixture.issue.body,
        author: "factory[bot]",
        sourceEdit,
        writerRun: writer,
        writerProof: writer
          ? {
              repository: "acme/widgets",
              issue: "I_4",
              run: writer,
              sourceEdit,
            }
          : null,
      },
    };
    if (writer !== "intake-1")
      await assert.rejects(
        s.platform().postResult(4, post(), s.resume()),
        /same or unknown writer/,
      );
    else assert.ok(await s.platform().postResult(4, post(), s.resume()));
  }
});

test("prepared publication remains immutable alongside report progress, and a cutoff holds its retry", async () => {
  const s = setup();
  s.fixture.controls.mode = "prepared";
  s.fixture.controls.missingResult = true;
  assert.equal(await s.platform().postResult(4, post(), s.resume()), null);
  s.fixture.controls.missingResult = false;
  assert.ok(await s.platform().postResult(4, post(), s.resume()));
  const evidence = structuredClone(s.fixture.comments[0]);
  const platform = s.platform();
  await platform.comments.write(4, {
    phase: "triage",
    facts: { state: "done" },
    result: { body: brief },
  });
  await platform.comments.write(4, {
    phase: "implement",
    facts: { state: "running" },
    result: { body: "Implementation result" },
  });
  await platform.comments.write(4, {
    phase: "review",
    facts: { state: "stopped" },
    resume: { pullRequests: [] },
  });
  await s
    .platform()
    .comments.write(4, { phase: "review", facts: { state: "running" } });
  assert.deepEqual(s.fixture.comments[0], evidence);
  assert.equal(
    s.fixture.comments.filter((c) => c.body.includes('"phases":')).length,
    1,
  );
  s.fixture.controls.mode = "body";
  await assert.rejects(
    s.platform().postResult(4, post(), s.resume()),
    /mode changed/,
  );
  assert.deepEqual(s.fixture.comments[0], evidence);
  assert.equal(s.fixture.writes.includes("body"), false);
});

test("stop and failed results never replace body contracts", async () => {
  const s = setup(),
    body = s.fixture.issue.body;
  await s
    .platform()
    .postResult(
      4,
      resultPost(
        { outcome: "stop", state: "state:owner", body: "Question" },
        run,
        contractConfiguration,
      ),
    );
  await s
    .platform()
    .postResult(
      4,
      resultPost(
        { outcome: "failed", reason: "failed", body: "Failure" },
        { ...run, id: "another" },
        contractConfiguration,
      ),
    );
  assert.equal(s.fixture.issue.body, body);
  assert.equal(s.fixture.writes.includes("body"), false);
});

test("unknown mode and old-host/new-validator formats fail closed", async () => {
  const s = setup();
  s.fixture.controls.mode = "unknown";
  await assert.rejects(
    readContractMode(s.connection),
    /Unknown or conflicting/,
  );
  assert.equal(s.fixture.writes.length, 0);
});

test("an edited result marker cannot be adopted as a successful legacy retry", async () => {
  const s = setup();
  s.fixture.controls.mode = "prepared";
  await s.platform().postResult(4, post(), s.resume());
  const evidence = s.fixture.comments[0];
  evidence.body += " changed";
  await assert.rejects(
    s.platform().postResult(4, post(), s.resume()),
    /Legacy evidence was deleted or edited|Evidence publication has conflicting or edited/,
  );
  assert.equal(s.fixture.comments.length, 1);
});

test("a selected evidence identity resembling a report is never a report upsert target", async () => {
  const s = setup();
  s.fixture.controls.mode = "prepared";
  await s.platform().postResult(4, post(), s.resume());
  const evidence = s.fixture.comments[0];
  evidence.body =
    'Edited proof\n<!-- scriptorium:run {"phases":{"triage":{"state":"done"}}} -->';
  s.fixture.comments.push({
    id: 9999,
    nodeId: "FEEDBACK",
    author: { login: "github-actions[bot]", bot: true },
    url: "result",
    createdAt: evidence.createdAt,
    updatedAt: evidence.updatedAt,
    body: `<!-- repo-canon:issue-contract-state ${JSON.stringify({ source: { type: "comment", id: String(evidence.id) } })} -->`,
  });
  const bytes = evidence.body;
  await s
    .platform()
    .comments.write(4, { phase: "implement", facts: { state: "running" } });
  assert.equal(evidence.body, bytes);
  assert.equal(s.fixture.comments.length, 3);
  assert.equal(digest(evidence.body), digest(bytes));
});

test("body mode refuses an old or unknown validator before replacing intake", async () => {
  for (const format of [
    "repo-canon/issue-contract-state/v1",
    "repo-canon/issue-contract-state/v5",
  ]) {
    const s = setup();
    s.fixture.controls.format = format;
    s.fixture.evaluate();
    const original = s.fixture.issue.body;
    await assert.rejects(
      s.platform().postResult(4, post(), s.resume()),
      /supported well-formed v2 validator/,
    );
    assert.equal(s.fixture.issue.body, original);
    assert.equal(s.fixture.writes.includes("attestation"), false);
    assert.equal(s.fixture.issue.labels.includes("state:ready"), false);
  }
});

test("body evidence survives the report's implement/review, stop/resume and replacement result journey", async () => {
  const s = setup();
  await s.platform().postResult(4, post(), s.resume());
  const original = s.fixture.issue.body;
  const evidence = structuredClone(
    s.fixture.comments.find((c) => c.body.includes("triage-attestation"))!,
  );
  const association = structuredClone(s.fixture.result!.factoryTriage);
  const event = s.fixture.result!.reviewEventId;
  for (const [phase, state] of [
    ["triage", "done"],
    ["implement", "running"],
    ["implement", "done"],
    ["review", "stopped"],
    ["review", "running"],
    ["review", "done"],
  ] as const) {
    await s.platform().comments.write(4, {
      phase,
      facts: { state },
      result: { body: `Latest ${phase} ${state}` },
      ...(state === "stopped" && { resume: { pullRequests: [] } }),
    });
  }
  assert.equal(
    s.fixture.comments.filter((c) => c.body.includes('"phases":')).length,
    1,
  );
  assert.equal(s.fixture.issue.body, original);
  assert.deepEqual(
    s.fixture.comments.find((c) => c.id === evidence.id),
    evidence,
  );
  assert.deepEqual(s.fixture.result!.factoryTriage, association);
  assert.equal(s.fixture.result!.reviewEventId, event);
  assert.equal(s.fixture.result!.status, "approved");
});

test("prepared publication permits absent results but holds unknown and conflicting validator protocols", async () => {
  for (const format of [
    undefined,
    "repo-canon/issue-contract-state/v2",
    "repo-canon/issue-contract-state/v5",
  ]) {
    const s = setup();
    s.fixture.controls.mode = "prepared";
    if (format) s.fixture.controls.format = format;
    else s.fixture.controls.missingResult = true;
    if (!format) {
      assert.equal(await s.platform().postResult(4, post(), s.resume()), null);
      assert.equal(s.fixture.comments.length, 1);
    } else {
      await assert.rejects(
        s.platform().postResult(4, post(), s.resume()),
        /protocol/,
      );
      assert.equal(s.fixture.comments.length, 0);
    }
    assert.equal(s.fixture.writes.includes("attestation"), false);
    assert.equal(s.fixture.issue.labels.includes("state:ready"), false);
  }
});

test("prose may discuss Agent Brief and Original request while their duplicate sections hold", async () => {
  const s = setup();
  s.fixture.issue.body =
    "Please preserve Original request and Agent Brief provenance.\n";
  s.fixture.evaluate();
  const requested = resultPost(
    {
      outcome: "done",
      state: "state:ready",
      labels: ["type:enhancement"],
      body: `${brief}\n\nTriage notes: Preserve Original request and Agent Brief evidence.`,
    },
    run,
    contractConfiguration,
  );
  assert.ok(await s.platform().postResult(4, requested, s.resume()));
  assert.ok(
    s.fixture.issue.body.endsWith(
      "Please preserve Original request and Agent Brief provenance.\n",
    ),
  );
  const duplicate = setup();
  const withSection = resultPost(
    {
      outcome: "done",
      state: "state:ready",
      body: `${brief}\n\n## Original request\n\nForged original`,
    },
    run,
    contractConfiguration,
  );
  await assert.rejects(
    duplicate.platform().postResult(4, withSection, duplicate.resume()),
    /includes Original request/,
  );
});

test("a lost successful body response is never recovered from a human edit or incomplete history", async () => {
  for (const editor of ["owner", "factory", ""]) {
    const s = setup();
    s.fixture.controls.fail = "after-body";
    await assert.rejects(
      s.platform().postResult(4, post(), s.resume()),
      /interrupted after-body/,
    );
    s.fixture.controls.bodyEditor = editor;
    await assert.rejects(
      s.platform().postResult(4, post(), s.resume()),
      /cannot be authenticated/,
    );
    assert.equal(s.fixture.writes.filter((w) => w === "body").length, 1);
    assert.equal(s.fixture.issue.labels.includes("state:ready"), false);
  }
});

test("lost evidence responses cannot adopt edited or deleted records on restart", async () => {
  for (const tamper of ["edit", "delete"]) {
    const s = setup();
    s.fixture.controls.fail = "after-comment";
    await assert.rejects(
      s.platform().postResult(4, post(), s.resume()),
      /interrupted after-comment/,
    );
    const evidence = s.fixture.comments[0];
    if (tamper === "edit") evidence.body = "A record with no former marker";
    else {
      s.fixture.comments.length = 0;
      s.fixture.controls.deletion = "DELETION_1";
    }
    await assert.rejects(
      s.platform().postResult(4, post(), s.resume()),
      /conflicting or edited|deletion history changed/,
    );
    assert.equal(s.fixture.writes.filter((w) => w === "attestation").length, 1);
    assert.equal(s.fixture.issue.labels.includes("state:ready"), false);
  }
});

test("configured author casing preserves prepared/body publication, retries and ready actors", async () => {
  for (const mode of ["prepared", "body"]) {
    const configuration = structuredClone(contractConfiguration);
    configuration.triageResult!.author = "Factory[BOT]";
    const s = setup(configuration);
    s.fixture.controls.mode = mode;
    const requested = post(configuration);
    assert.ok(await s.platform().postResult(4, requested, s.resume()), mode);
    const evidence = structuredClone(s.fixture.comments[0]);
    assert.ok(
      await s.platform().postResult(4, requested, s.resume()),
      `${mode} retry`,
    );
    assert.deepEqual(s.fixture.comments[0], evidence);
    assert.equal(
      s.fixture.changes.filter((c) => c.label === "state:ready").length,
      1,
    );
  }
});

test("a recovered body intent rechecks protocol compatibility before its mutation", async () => {
  const s = setup();
  s.fixture.controls.fail = "body";
  await assert.rejects(
    s.platform().postResult(4, post(), s.resume()),
    /interrupted body/,
  );
  assert.ok(s.checkpoint?.original);
  s.fixture.controls.format = "repo-canon/issue-contract-state/v5";
  s.fixture.evaluate();
  await assert.rejects(
    s.platform().postResult(4, post(), s.resume()),
    /supported well-formed v2 validator/,
  );
  assert.equal(s.fixture.writes.includes("body"), false);
});

for (const source of ["current", "superseded", "legacy", "prepared"] as const)
  test(`invalidated ${source} evidence never becomes a report or continuation after restart`, async () => {
    const s = setup();
    if (source === "legacy" || source === "prepared")
      s.fixture.controls.mode = "prepared";
    await s.platform().postResult(4, post(), s.resume());
    const evidence = s.fixture.comments[0];
    if (source === "superseded") {
      const record = s.fixture.record!;
      s.fixture.record = {
        ...record,
        publication: {
          ...record.publication!,
          attestation: { ...record.publication!.attestation, id: "12345" },
        },
      };
    }
    if (source === "legacy") {
      s.fixture.controls.mode = "body";
      s.fixture.receipt.issues.push({
        issue: "I_4",
        number: 4,
        legacy: {
          revision: digest(evidence.body),
          source: {
            type: "comment",
            id: String(evidence.id),
            editedAt: evidence.updatedAt,
          },
          edit: s.fixture.edits[evidence.nodeId!],
        },
      });
      s.fixture.record = {
        issue: "I_4",
        cutoff: s.fixture.mode.cutoff,
        migrated: true,
        retired: true,
      };
    }
    evidence.body =
      'Edited proof\n<!-- scriptorium:run {"phases":{"triage":{"state":"done"}},"resume":{"pullRequests":[]}} -->';
    s.fixture.edits[evidence.nodeId!] = {
      id: "HUMAN_EDIT",
      editedAt: "2026-10-09T00:00:00Z",
    };
    s.fixture.evaluate();
    assert.equal(s.fixture.result!.factoryTriage, null);
    const bytes = evidence.body;
    const restarted = s.platform();
    assert.equal((await restarted.readIssues())[0].continuation, undefined);
    await restarted.comments.write(4, {
      phase: "implement",
      facts: { state: "running" },
    });
    assert.equal(evidence.body, bytes);
    assert.equal(s.fixture.comments.length, 2);
  });

test("unreadable evidence history neither edits proof nor supplies a continuation", async () => {
  const s = setup();
  await s.platform().postResult(4, post(), s.resume());
  const evidence = s.fixture.comments[0];
  evidence.body =
    'Edited proof\n<!-- scriptorium:run {"phases":{"triage":{"state":"done"}},"resume":{"pullRequests":[]}} -->';
  s.fixture.edits[evidence.nodeId!] = {
    id: "HUMAN_EDIT",
    editedAt: "2026-10-09T00:00:00Z",
  };
  const bytes = evidence.body;
  s.fixture.controls.fail = "evidence-history";
  assert.equal((await s.platform().readIssues())[0].continuation, undefined);
  s.fixture.controls.fail = "evidence-history";
  await assert.rejects(
    s
      .platform()
      .comments.write(4, { phase: "implement", facts: { state: "running" } }),
    /ledger history is unreadable/,
  );
  assert.equal(evidence.body, bytes);
  assert.equal(s.fixture.comments.length, 1);
});

test("prepared evidence with unavailable creation history is held instead of adopted", async () => {
  const s = setup();
  s.fixture.controls.mode = "prepared";
  await s.platform().postResult(4, post(), s.resume());
  const evidence = s.fixture.comments[0];
  evidence.body =
    'Edited proof\n<!-- scriptorium:run {"phases":{"triage":{"state":"done"}},"resume":{"pullRequests":[]}} -->';
  s.fixture.edits[evidence.nodeId!] = {
    id: "HUMAN_EDIT",
    editedAt: "2026-10-09T00:00:00Z",
  };
  s.fixture.controls.originalHistory = false;
  const bytes = evidence.body;
  assert.equal((await s.platform().readIssues())[0].continuation, undefined);
  await assert.rejects(
    s
      .platform()
      .comments.write(4, { phase: "implement", facts: { state: "running" } }),
    /Original report role cannot be verified/,
  );
  assert.equal(evidence.body, bytes);
  assert.equal(s.fixture.comments.length, 1);
});

for (const mismatch of ["revision", "status"] as const)
  test(`prepared publication grants no readiness when a notice selecting the brief has another ${mismatch}`, async () => {
    const s = setup();
    s.fixture.controls.mode = "prepared";
    s.fixture.controls.missingResult = true;
    assert.equal(await s.platform().postResult(4, post(), s.resume()), null);
    s.fixture.controls.missingResult = false;
    s.fixture.controls.result =
      mismatch === "revision"
        ? { revision: `sha256:${"0".repeat(64)}` }
        : { status: "needs-attention" };
    if (mismatch === "status")
      // A completed evaluation of this brief is not a wait for one.
      await assert.rejects(
        s.platform().postResult(4, post(), s.resume()),
        (error) =>
          error instanceof ContractPublicationHold &&
          /published brief is needs-attention/.test(error.message),
      );
    else
      assert.equal(await s.platform().postResult(4, post(), s.resume()), null);
    assert.equal(s.fixture.issue.labels.includes("state:ready"), false);
    assert.equal(s.fixture.comments.length, 1);
    s.fixture.controls.result = {};
    assert.ok(await s.platform().postResult(4, post(), s.resume()));
    assert.equal(
      s.fixture.changes.filter((c) => c.label === "state:ready").length,
      1,
    );
  });

// A published brief, then the validator's notice with `result` evaluated
// after it unless the result names its own evaluation time.
async function noticed(
  result: (brief: { id: number; createdAt: string }) => Record<string, unknown>,
  seams = false,
) {
  const s = setup();
  s.fixture.controls.mode = "prepared";
  s.fixture.controls.missingResult = true;
  assert.equal(await s.platform().postResult(4, post(), s.resume()), null);
  s.fixture.controls.missingResult = false;
  s.fixture.controls.seams = seams;
  s.fixture.controls.result = result(s.fixture.comments[0]);
  return s;
}
const issueBody = {
  revision: `sha256:${"1".repeat(64)}`,
  source: { type: "issue-body", editedAt: "2026-10-08T00:30:00Z" },
};
const noSource = { revision: null, source: null };
const unrequested = (s: Awaited<ReturnType<typeof noticed>>) => {
  assert.equal(s.fixture.issue.labels.includes("state:ready"), false);
  assert.equal(
    s.fixture.changes.filter((c) => c.label === "state:ready").length,
    0,
  );
  assert.equal(s.fixture.comments.length, 1);
};

for (const status of [
  "awaiting-review",
  "approved",
  "needs-attention",
  "needs-attention (v3)",
  "no-contract",
])
  test(`a notice after the brief selecting another source stops publication whatever its ${status} status`, async () => {
    const s = await noticed(
      () => ({ ...issueBody, status: status.split(" ")[0] }),
      status.endsWith("(v3)"),
    );
    await assert.rejects(
      s.platform().postResult(4, post(), s.resume()),
      (error) =>
        error instanceof ContractPublicationStop &&
        error.message.includes(
          `[the configured validator's notice](https://github.com/feedback), evaluated after the published brief, is ${status.split(" ")[0]} and selects another contract source`,
        ),
    );
    if (status.endsWith("(v3)"))
      assert.equal(
        s.fixture.result!.format,
        "repo-canon/issue-contract-state/v3",
      );
    unrequested(s);
    assert.ok(s.fixture.issue.labels.includes("state:triage"));
    assert.ok(s.fixture.issue.labels.includes("type:enhancement"));
  });

test("a stop after the brief restores the triage state a person removed", async () => {
  const s = await noticed(() => ({ ...issueBody, status: "awaiting-review" }));
  s.fixture.issue.labels = s.fixture.issue.labels.filter(
    (label) => label !== "state:triage",
  );
  await assert.rejects(
    s.platform().postResult(4, post(), s.resume()),
    ContractPublicationStop,
  );
  assert.ok(s.fixture.issue.labels.includes("state:triage"));
});

for (const hold of [
  {
    case: "no source, no-contract",
    result: { ...noSource, status: "no-contract" },
  },
  {
    case: "no source, needs-attention",
    result: { ...noSource, status: "needs-attention" },
  },
  { case: "the brief, needs-attention", result: { status: "needs-attention" } },
])
  test(`a notice after the brief selecting ${hold.case} holds visibly until a notice selecting the brief publishes`, async () => {
    const s = await noticed(() => hold.result);
    const status = hold.result.status;
    for (let pass = 0; pass < 2; pass++)
      await assert.rejects(
        s.platform().postResult(4, post(), s.resume()),
        (error) =>
          error instanceof ContractPublicationHold &&
          error.message.includes(
            "[the configured validator's notice](https://github.com/feedback)",
          ) &&
          error.message.includes(` is ${status} `) &&
          error.message.includes("make the repair the linked notice lists") ===
            (status === "needs-attention") &&
          !/fresh triage|restore automatic/.test(error.message),
      );
    unrequested(s);
    assert.ok(s.fixture.issue.labels.includes("state:triage"));
    s.fixture.controls.result = {};
    assert.ok(await s.platform().postResult(4, post(), s.resume()));
    assert.equal(
      s.fixture.changes.filter((c) => c.label === "state:ready").length,
      1,
    );
    assert.equal(s.fixture.issue.labels.includes("state:triage"), false);
    assert.equal(s.fixture.comments.length, 1);
  });

for (const timing of ["unevaluated", "before the brief", "the brief's second"])
  for (const [selected, fields] of [
    ["another source", issueBody],
    ["no source", noSource],
    ["the brief", {}],
  ] as const)
    for (const status of [
      "awaiting-review",
      "approved",
      "needs-attention",
      "no-contract",
    ])
      test(`a ${status} notice selecting ${selected}, evaluated ${timing}, keeps the wait`, async () => {
        const s = await noticed((brief) => ({
          ...fields,
          status,
          evaluatedAt:
            timing === "unevaluated"
              ? null
              : timing === "before the brief"
                ? new Date(Date.parse(brief.createdAt) - 1000)
                    .toISOString()
                    .replace(".000Z", "Z")
                : brief.createdAt,
        }));
        assert.equal(
          await s.platform().postResult(4, post(), s.resume()),
          null,
        );
        unrequested(s);
        assert.ok(s.fixture.issue.labels.includes("state:triage"));
      });

test("a present unreadable prepared result holds before any publication write", async () => {
  const s = setup();
  s.fixture.controls.mode = "prepared";
  s.fixture.comments.push({
    id: 100000,
    nodeId: "BAD_RESULT",
    author: { login: "github-actions[bot]", bot: true },
    body: "<!-- repo-canon:issue-contract-state {unreadable} -->",
    url: "bad",
    createdAt: "2026-10-08T01:00:00Z",
    updatedAt: "2026-10-08T01:00:00Z",
  });
  await assert.rejects(
    s.platform().postResult(4, post(), s.resume()),
    /unreadable/,
  );
  assert.deepEqual(s.fixture.writes, []);
});

for (const boundary of ["after-comment", "labels", "ready-checkpoint"])
  test(`prepared publication resumes ${boundary} partial success without duplicate evidence or readiness`, async () => {
    const s = setup();
    s.fixture.controls.mode = "prepared";
    if (boundary !== "ready-checkpoint") s.fixture.controls.fail = boundary;
    const progress = s.resume();
    const save = progress.save;
    progress.save = (state) => {
      if (boundary === "ready-checkpoint" && state.readyRequested)
        throw new Error("lost readiness checkpoint");
      save(state);
    };
    await assert.rejects(s.platform().postResult(4, post(), progress));
    assert.ok(await s.platform().postResult(4, post(), s.resume()));
    assert.equal(s.fixture.comments.length, 1);
    assert.equal(
      s.fixture.changes.filter((c) => c.label === "state:ready").length,
      1,
    );
    assert.equal(s.checkpoint?.readyRequested, true);
  });

test("prepared readiness recovery needs no configured triage author", async () => {
  const { triageResult: _, ...configuration } = contractConfiguration;
  const s = setup(configuration);
  s.fixture.controls.mode = "prepared";
  const progress = s.resume();
  const save = progress.save;
  progress.save = (state) => {
    if (state.readyRequested) throw new Error("lost readiness checkpoint");
    save(state);
  };
  await assert.rejects(
    s.platform().postResult(4, post(configuration), progress),
  );
  assert.ok(await s.platform().postResult(4, post(configuration), s.resume()));
  assert.equal(s.fixture.comments.length, 1);
  assert.equal(
    s.fixture.changes.filter((c) => c.label === "state:ready").length,
    1,
  );
  assert.equal(s.checkpoint?.readyRequested, true);
});

test("prepared publication holds an unauthorized carried readiness event", async () => {
  const s = setup();
  s.fixture.controls.mode = "prepared";
  s.fixture.controls.missingResult = true;
  assert.equal(await s.platform().postResult(4, post(), s.resume()), null);
  s.fixture.controls.missingResult = false;
  s.fixture.issue.labels.push("state:ready");
  s.fixture.changes.push({
    id: 99,
    action: "added",
    label: "state:ready",
    actor: { login: "outsider", bot: false },
    time: "2026-10-08T03:00:00Z",
  });
  await assert.rejects(
    s.platform().postResult(4, post(), s.resume()),
    /belongs to another reviewer/,
  );
  assert.equal(s.checkpoint?.readyRequested, undefined);
});

test("the real validator's first prepared notice permits readiness in a later second", async () => {
  const { decideIssueContract } = await import(
    new URL("../vendor/repo-canon/validate-issue-contract.mjs", import.meta.url)
      .href
  );
  const s = setup();
  s.fixture.controls.mode = "prepared";
  s.fixture.controls.missingResult = true;
  const requested = post();
  requested.comment = requested.comment.replace(
    "**Out of scope:**",
    "**Seams:** No trigger\n\n**Out of scope:**",
  );
  assert.equal(await s.platform().postResult(4, requested, s.resume()), null);
  const evidence = s.fixture.comments[0];
  const decision = decideIssueContract({
    issue: {
      ...s.fixture.issue,
      state: "open",
      labels: s.fixture.issue.labels.map((name) => ({ name })),
    },
    comments: [
      { ...evidence, node_id: evidence.nodeId, updated_at: evidence.updatedAt },
    ],
    issueEvents: [],
    permissions: {},
    event: { kind: "commentCreated", actor: { login: "factory[bot]" } },
    evaluatedAt: "2026-10-08T03:00:00Z",
    seamsBoundary: {
      tag: "v0.26.0",
      commit: "a".repeat(40),
      publishedAt: "2026-10-01T00:00:00Z",
    },
  });
  assert.equal(decision.exitCode, 0, decision.message);
  const line = decision.feedback.body
    .split("\n")
    .find((line: string) =>
      line.startsWith("<!-- repo-canon:issue-contract-state "),
    );
  const state = JSON.parse(
    line.slice("<!-- repo-canon:issue-contract-state ".length, -4),
  );
  assert.equal(state.format, "repo-canon/issue-contract-state/v1");
  assert.equal(state.publishedAt, null);
  assert.equal(state.status, "awaiting-review");
  s.fixture.controls.evaluation = false;
  s.fixture.comments.push({
    id: 100000,
    nodeId: "FIRST_NOTICE",
    author: { login: "github-actions[bot]", bot: true },
    body: decision.feedback.body,
    createdAt: "2026-10-08T03:00:00Z",
    updatedAt: "2026-10-08T03:00:00Z",
    url: "notice",
  });
  const sameSecond = s.resume();
  sameSecond.now = () => new Date("2026-10-08T03:00:00Z");
  assert.equal(await s.platform().postResult(4, requested, sameSecond), null);
  assert.equal(s.fixture.issue.labels.includes("state:ready"), false);
  assert.ok(await s.platform().postResult(4, requested, s.resume()));
  assert.equal(
    s.fixture.changes.filter((c) => c.label === "state:ready").length,
    1,
  );
});

test("prepared publication completes the handshake under v3 base-v1 results", async () => {
  const s = setup();
  s.fixture.controls.mode = "prepared";
  s.fixture.controls.seams = true;
  await s.platform().postResult(4, post(), s.resume());
  assert.equal(s.fixture.result!.format, "repo-canon/issue-contract-state/v3");
  assert.equal(s.fixture.result!.status, "approved");
  assert.equal(s.fixture.issue.labels.includes("state:ready"), true);
});

test("body publication completes the handshake and migrated proof under v3 base-v2 results", async () => {
  const s = setup();
  s.fixture.controls.seams = true;
  await s.platform().postResult(4, post(), s.resume());
  assert.equal(s.fixture.result!.format, "repo-canon/issue-contract-state/v3");
  assert.equal(s.fixture.result!.status, "approved");
  assert.equal(s.fixture.result!.factoryTriage.run, "triage-7");
  assert.equal(s.fixture.issue.labels.includes("state:ready"), true);
});

// A direct ticket under Repo Canon's installed validator, with its first
// notice, and a triage result accepting `revision`, by default the one that
// notice names.
function direct() {
  const s = setup();
  s.fixture.controls.mode = "prepared";
  s.fixture.controls.direct = true;
  s.fixture.issue.body = directTicket;
  s.fixture.evaluate();
  const reviewed: string = s.fixture.result!.revision;
  const accept = (revision = reviewed) =>
    resultPost(
      {
        outcome: "done",
        state: "state:ready",
        labels: ["model:claude-opus-5-5"],
        body: "**Verdict:** holds.",
        revision,
      },
      run,
      contractConfiguration,
    );
  return Object.assign(s, { reviewed, accept });
}
const readyEvents = (s: ReturnType<typeof direct>) =>
  s.fixture.changes.filter((c) => c.label === "state:ready");
const attestations = (s: ReturnType<typeof direct>) =>
  s.fixture.comments.filter((c) =>
    c.body.includes("<!-- repo-canon:review-attestation "),
  );
// Run a body edit through the platform and the validator.
function editBody(s: ReturnType<typeof direct>) {
  const { issue, edits } = s.fixture;
  issue.body = `${issue.body}\nAnswer within half a second.\n`;
  issue.bodyEditTime = "2026-10-08T05:00:00Z";
  edits[issue.nodeId!] = { id: "BODY_EDIT", editedAt: issue.bodyEditTime };
  s.fixture.evaluate({ kind: "edited", actor: { login: "owner" } });
}

test("an acceptance attests the reviewed revision, then applies readiness once after the matching notice", async () => {
  const s = direct();
  assert.equal(s.fixture.result!.format, "repo-canon/issue-contract-state/v1");
  const link = await s.platform().postResult(4, s.accept(), s.resume());
  assert.ok(link);
  const [attestation] = attestations(s);
  assert.equal(attestations(s).length, 1);
  assert.equal(link, attestation.url);
  assert.match(
    attestation.body,
    /^> \*This was generated by AI during triage\.\*\n\n\*\*Verdict:\*\* holds\./,
  );
  assert.match(
    attestation.body.split("\n").at(-1)!,
    /^<!-- scriptorium:run \{"run":"triage-7","outcome":"done"\} -->$/,
  );
  const result = s.fixture.result!;
  assert.equal(result.format, "repo-canon/issue-contract-state/v4");
  assert.equal(result.status, "approved");
  assert.equal(result.revision, s.reviewed);
  assert.equal(result.reviewer, "factory[bot]");
  assert.equal(result.factoryReview.run, "triage-7");
  assert.equal(result.factoryReview.attestation.id, String(attestation.id));
  assert.equal(readyEvents(s).length, 1);
  assert.deepEqual(s.fixture.issue.labels, [
    "model:claude-opus-5-5",
    "state:ready",
  ]);
  // A retry settles on the same attestation and readiness.
  assert.equal(await s.platform().postResult(4, s.accept(), s.resume()), link);
  assert.equal(attestations(s).length, 1);
  assert.equal(readyEvents(s).length, 1);

  // Admission reads the v4 approval as the factory's own readiness.
  const comments = await s.connection.issueTracker.comments(4);
  const facts = {
    comments,
    labelChanges: s.fixture.changes,
    ready: readyEvents(s).at(-1)!,
    bodyEditTime: s.fixture.issue.bodyEditTime,
    latestDeletion: null,
  };
  assert.equal(contractResultHold(facts, contractConfiguration), null);
  assert.equal(triageBacked(facts, contractConfiguration), true);
  const copied = comments.map((c) =>
    c.id === attestation.id ? { ...c, body: `${c.body}\n` } : c,
  );
  assert.equal(
    triageBacked({ ...facts, comments: copied }, contractConfiguration),
    false,
  );
});

test("a notice evaluated before the attestation keeps the acceptance waiting", async () => {
  const s = direct();
  s.fixture.controls.evaluation = false;
  assert.equal(await s.platform().postResult(4, s.accept(), s.resume()), null);
  assert.equal(attestations(s).length, 1);
  assert.equal(await s.platform().postResult(4, s.accept(), s.resume()), null);
  assert.equal(attestations(s).length, 1);
  assert.equal(s.fixture.issue.labels.includes("state:ready"), false);
  s.fixture.controls.evaluation = true;
  s.fixture.evaluate();
  assert.ok(await s.platform().postResult(4, s.accept(), s.resume()));
  assert.equal(attestations(s).length, 1);
  assert.equal(readyEvents(s).length, 1);
});

test("a notice naming another revision after the attestation stops in the triage state without readiness", async () => {
  const s = direct();
  s.fixture.controls.evaluation = false;
  assert.equal(await s.platform().postResult(4, s.accept(), s.resume()), null);
  s.fixture.issue.labels = [];
  s.fixture.controls.evaluation = true;
  editBody(s);
  assert.notEqual(s.fixture.result!.revision, s.reviewed);
  await assert.rejects(
    s.platform().postResult(4, s.accept(), s.resume()),
    (error) =>
      error instanceof ContractPublicationStop &&
      /names another revision than the attested/.test(error.message),
  );
  assert.deepEqual(s.fixture.issue.labels, ["state:triage"]);
  assert.equal(readyEvents(s).length, 0);
  assert.equal(attestations(s).length, 1);
});

test("a body changed before the attestation stops without posting one", async () => {
  const s = direct();
  editBody(s);
  await assert.rejects(
    s.platform().postResult(4, s.accept(), s.resume()),
    (error) =>
      error instanceof ContractPublicationStop &&
      /body changed after its review/.test(error.message),
  );
  // The validator has not yet evaluated the edit: the issue's edit decides.
  const t = direct();
  t.fixture.controls.evaluation = false;
  editBody(t);
  await assert.rejects(
    t.platform().postResult(4, t.accept(), t.resume()),
    ContractPublicationStop,
  );
  for (const run of [s, t]) {
    assert.equal(attestations(run).length, 0);
    assert.equal(readyEvents(run).length, 0);
    assert.deepEqual(run.fixture.issue.labels, ["state:triage"]);
  }
});

test("an installed module without the review attestation refuses the acceptance result as invalid", async () => {
  const s = direct();
  const text = JSON.stringify({
    outcome: "done",
    state: "state:ready",
    body: "**Verdict:** holds.",
    revision: s.reviewed,
  });
  assert.deepEqual(
    parseRunResult(
      text,
      contractConfiguration,
      "triage",
      reviewAttestation({}),
    ),
    {
      invalid:
        "its run result accepts a revision, but the repository's installed issue-contract module has no review attestation",
    },
  );
  assert.equal(
    (parseRunResult(text, contractConfiguration, "triage") as RunResult)
      .revision,
    s.reviewed,
  );
  assert.deepEqual(s.fixture.writes, []);
});

for (const boundary of [
  "after-comment",
  "comment",
  "labels",
  "ready-checkpoint",
])
  test(`an acceptance interrupted at ${boundary} recovers without a second attestation or readiness`, async () => {
    const s = direct();
    if (boundary !== "ready-checkpoint") s.fixture.controls.fail = boundary;
    const progress = s.resume();
    const save = progress.save;
    progress.save = (state) => {
      if (boundary === "ready-checkpoint" && state.readyRequested)
        throw new Error("lost readiness checkpoint");
      save(state);
    };
    await assert.rejects(s.platform().postResult(4, s.accept(), progress));
    assert.ok(await s.platform().postResult(4, s.accept(), s.resume()));
    assert.equal(attestations(s).length, 1);
    assert.equal(readyEvents(s).length, 1);
    assert.equal(s.fixture.result!.status, "approved");
    assert.equal(s.checkpoint?.readyRequested, true);
  });
