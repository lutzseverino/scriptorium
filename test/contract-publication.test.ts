import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConnectionWithLinkAdditions } from "@lutzseverino/postern";
import { repositoryPlatform } from "../src/platform.ts";
import { resultPost } from "../src/run-result.ts";
import {
  readContractMode,
  ContractPublicationHold,
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
    "repo-canon/issue-contract-state/v3",
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
    "repo-canon/issue-contract-state/v3",
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
  s.fixture.controls.format = "repo-canon/issue-contract-state/v3";
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

for (const mismatch of ["source", "revision", "status"] as const)
  test(`prepared publication waits when a supported notice has another ${mismatch}`, async () => {
    const s = setup();
    s.fixture.controls.mode = "prepared";
    s.fixture.controls.missingResult = true;
    assert.equal(await s.platform().postResult(4, post(), s.resume()), null);
    s.fixture.controls.missingResult = false;
    s.fixture.controls.result =
      mismatch === "source"
        ? {
            source: {
              type: "comment",
              id: "98765",
              editedAt: s.fixture.comments[0].updatedAt,
            },
          }
        : mismatch === "revision"
          ? { revision: `sha256:${"0".repeat(64)}` }
          : { status: "needs-attention" };
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
