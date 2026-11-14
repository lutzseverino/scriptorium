import assert from "node:assert/strict";
import { test } from "node:test";
import type { Comment, Issue, LabelChange } from "@lutzseverino/postern";
import {
  contractResultHold,
  triageBacked,
  requirePreparedProtocol,
  type ContractFacts,
} from "../src/contract-result.ts";
import {
  bodyRevision,
  contractObservation,
  digest,
} from "../src/contract-protocol.ts";
import { readinessExclusion } from "../src/readiness.ts";
import { canonical, contractConfiguration } from "./contract-fixture.ts";
import {
  recordedSeamsLine,
  recordedSeamsState,
  resultComment,
  seamsState,
} from "./contract-result-fixture.ts";

function sample(index = 2) {
  const fixture = structuredClone(canonical.cases[index]);
  const s = fixture.snapshot,
    state = fixture.state;
  const comments: Comment[] = s.comments.map((c: any) => ({
    id: c.id,
    nodeId: c.node_id,
    body: c.body,
    author: { login: c.user.login, bot: c.user.login.endsWith("[bot]") },
    updatedAt: c.updated_at,
    createdAt: c.updated_at,
    url: `https://github.com/comment/${c.id}`,
  }));
  // Canon fixtures omit the body node from sourceEdits; their literal observation
  // deliberately covers that null. Platform readers additionally fetch that node.
  const issue: Issue = {
    ...s.issue,
    id: 42,
    nodeId: s.issue.node_id,
    bodyEditTime: s.bodyRevision.lastEditedAt,
    labels:
      fixture.expectedStatus === "approved"
        ? s.issue.labels
        : ["type:enhancement", "state:triage"],
    author: { login: s.issue.user.login, bot: false },
  };
  const changes: LabelChange[] = s.issueEvents.map((e: any) => ({
    id: e.id,
    action: e.event === "labeled" ? "added" : "removed",
    label: e.label.name,
    actor: e.actor,
    time: e.created_at,
  }));
  assert.equal(
    contractObservation(issue, comments, changes, s.sourceEdits),
    state.observation,
    fixture.name,
  );
  const edits = {
    ...s.sourceEdits,
    [issue.nodeId!]: {
      id: s.bodyRevision.editId ?? `created:${issue.nodeId}`,
      editedAt: issue.bodyEditTime,
    },
  };
  const feedback: Comment = {
    id: 999,
    nodeId: "FEEDBACK",
    url: "https://github.com/result",
    author: { login: "github-actions[bot]", bot: true },
    createdAt: "2026-11-09T01:02:00Z",
    updatedAt: "2026-11-09T01:02:00Z",
    body: "",
  };
  const refresh = () => {
    feedback.body = `<!-- repo-canon:issue-contract-feedback -->\n<!-- repo-canon:issue-contract-state ${JSON.stringify(state)} -->`;
  };
  const facts: ContractFacts = {
    comments: [
      ...comments.filter(
        (c) => !c.body.includes("<!-- repo-canon:issue-contract-feedback -->"),
      ),
      feedback,
    ],
    labelChanges: changes,
    ready: changes.at(-1) ?? {
      id: 0,
      action: "added",
      label: "state:ready",
      actor: null,
      time: "2026-11-09T01:01:00Z",
    },
    bodyEditTime: issue.bodyEditTime,
    latestDeletion: null,
    body: {
      issue,
      mode: {
        mode: "body",
        cutoff: s.contractSources.cutoff,
        receipt: s.contractSources.receipt,
      },
      edits,
      observation: state.observation,
    },
  };
  refresh();
  const config = {
    ...structuredClone(contractConfiguration),
    triageResult: s.triageResult ?? contractConfiguration.triageResult,
  };
  return { facts, state, config, refresh, fixture };
}

test("all literal Canon v2 decisions preserve their exact observation and approval meaning", () => {
  for (let i = 0; i < canonical.cases.length; i++) {
    const { facts, config, fixture } = sample(i);
    assert.equal(
      contractResultHold(facts, config) === null,
      fixture.expectedStatus === "approved",
      fixture.name,
    );
    assert.equal(
      triageBacked(facts, config),
      fixture.expectedFactoryRun !== null,
      fixture.name,
    );
  }
});

test("the literal exact-body revision uses issue identity and the platform edit node", () => {
  const { facts, state } = sample();
  assert.deepEqual(
    bodyRevision(
      facts.body!.issue,
      facts.body!.edits[facts.body!.issue.nodeId!],
    ),
    { revision: state.revision, source: state.source },
  );
});

test("body factory authorization checks referenced facts even under a fresh observation", () => {
  const mutations: [string, (s: ReturnType<typeof sample>) => void][] = [
    [
      "wrong ready actor",
      (s) => {
        s.facts.ready.actor = { login: "other[bot]", bot: true };
      },
    ],
    [
      "wrong ready event",
      (s) => {
        s.state.reviewEventId = "other";
      },
    ],
    [
      "wrong issue",
      (s) => {
        s.facts.body!.issue.nodeId = "I_OTHER";
      },
    ],
    [
      "wrong body edit",
      (s) => {
        s.facts.body!.edits.I42.id = "BODY2";
      },
    ],
    [
      "edited body",
      (s) => {
        s.facts.body!.issue.body += " edit";
        s.facts.body!.issue.bodyEditTime = "2026-11-09T01:10:00Z";
      },
    ],
    [
      "missing evidence",
      (s) => {
        s.facts.comments = s.facts.comments.filter((c) => c.id !== 20);
      },
    ],
    [
      "edited evidence",
      (s) => {
        s.facts.comments.find((c) => c.id === 20)!.body += " edit";
      },
    ],
    [
      "edit and restore",
      (s) => {
        s.facts.body!.edits.C20.id = "ATTEST2";
      },
    ],
    [
      "unreadable history",
      (s) => {
        delete s.facts.body!.edits.C20;
      },
    ],
    [
      "arbitrary app",
      (s) => {
        s.facts.comments.find((c) => c.id === 20)!.author = {
          login: "other[bot]",
          bot: true,
        };
      },
    ],
    [
      "wrong association run",
      (s) => {
        s.state.factoryTriage.run = "other";
      },
    ],
    [
      "wrong association revision",
      (s) => {
        s.state.factoryTriage.revision = digest("other");
      },
    ],
    [
      "unknown intake writer",
      (s) => {
        s.state.factoryTriage.intake = {
          author: "factory[bot]",
          writerRun: null,
        };
      },
    ],
    [
      "same intake writer",
      (s) => {
        s.state.factoryTriage.intake = {
          author: "factory[bot]",
          writerRun: "triage-7",
        };
      },
    ],
    [
      "missing association",
      (s) => {
        s.state.factoryTriage = null;
      },
    ],
    [
      "missing marker",
      (s) => {
        s.facts.comments.find((c) => c.id === 20)!.body = s.facts.comments
          .find((c) => c.id === 20)!
          .body.replace(/<!-- factory:run .* -->\n/, "");
      },
    ],
    [
      "multiple markers",
      (s) => {
        s.facts.comments.find((c) => c.id === 20)!.body +=
          '\n<!-- factory:run {"run":"triage-7"} -->';
      },
    ],
    [
      "triage off",
      (s) => {
        s.config.runKinds.triage = undefined;
      },
    ],
    [
      "unknown format",
      (s) => {
        s.state.format = "repo-canon/issue-contract-state/v4";
      },
    ],
    [
      "stale observation",
      (s) => {
        s.facts.body!.observation = digest("stale");
      },
    ],
    [
      "cutoff mismatch",
      (s) => {
        s.state.selection.cutoff.id = "b".repeat(40);
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    const s = sample();
    mutate(s);
    s.refresh();
    assert.equal(triageBacked(s.facts, s.config), false, name);
  }
});

test("report reevaluation preserves source/proof/event while stale observations wait", () => {
  const { facts, config, state, refresh } = sample();
  const before = structuredClone(state.factoryTriage),
    event = state.reviewEventId;
  const report: Comment = {
    id: 200,
    nodeId: "REPORT",
    body: 'progress\n<!-- scriptorium:run {"phases":{"implement":{"state":"running"}}} -->',
    author: { login: "factory[bot]", bot: true },
    createdAt: "2026-11-09T01:03:00Z",
    updatedAt: "2026-11-09T01:03:00Z",
    url: "https://github.com/report",
  };
  facts.comments.push(report);
  facts.body!.edits.REPORT = { id: "REPORT1", editedAt: report.updatedAt };
  facts.body!.observation = contractObservation(
    facts.body!.issue,
    facts.comments,
    facts.labelChanges,
    facts.body!.edits,
  );
  assert.equal(contractResultHold(facts, config)?.waiting, true);
  state.observation = facts.body!.observation;
  refresh();
  assert.equal(contractResultHold(facts, config), null);
  assert.equal(triageBacked(facts, config), true);
  assert.deepEqual(state.factoryTriage, before);
  assert.equal(state.reviewEventId, event);
});

test("a valid authorized-person ready event needs no factory exception", () => {
  const { facts, config } = sample(0);
  assert.equal(triageBacked(facts, config), false);
  assert.equal(contractResultHold(facts, config), null);
  assert.equal(
    readinessExclusion(
      {
        number: 42,
        ready: {
          at: facts.ready.time,
          actor: { kind: "user", login: "maintainer", role: "admin" },
        },
        labels: ["state:ready"],
        contractHold: null,
        subIssues: [],
        blockedBy: [],
        nativeParent: null,
      } as any,
      [],
      { ready: "state:ready", authorizedRoles: ["admin"], neverAuthorize: [] },
    ),
    null,
  );
});

function recordedSeamsFacts(): ContractFacts {
  return {
    comments: [
      {
        id: 6730346641,
        nodeId: "IC_SOURCE",
        body: "## Agent Brief",
        author: { login: "owner", bot: false },
        createdAt: "2026-11-09T01:51:48Z",
        updatedAt: "2026-11-09T01:51:48Z",
        url: "https://github.com/lutzseverino/repo-canon/issues/920#issuecomment-6730346641",
      },
      resultComment(recordedSeamsState, {
        id: 6730348269,
        body: `<!-- repo-canon:issue-contract-feedback -->\n${recordedSeamsLine}`,
        updatedAt: "2026-11-12T18:57:18Z",
      }),
    ],
    ready: {
      id: 35526739175,
      label: "state:ready",
      action: "added",
      actor: { login: "owner", bot: false },
      time: "2026-11-09T01:53:39Z",
    },
    labelChanges: [],
    bodyEditTime: null,
    latestDeletion: null,
  };
}

test("the public Canon v3 base-v1 approval counts and prepared publication accepts it", () => {
  const facts = recordedSeamsFacts();
  assert.equal(contractResultHold(facts, contractConfiguration), null);
  assert.ok(requirePreparedProtocol(facts.comments, contractConfiguration));
  facts.latestDeletion = "2026-11-12T18:57:19Z";
  assert.equal(contractResultHold(facts, contractConfiguration)?.waiting, true);
});

test("v3 base-v2 decisions retain all literal Canon approval and factory-proof meanings", () => {
  for (let i = 0; i < canonical.cases.length; i++) {
    const s = sample(i);
    const approval = contractResultHold(s.facts, s.config);
    const backed = triageBacked(s.facts, s.config);
    Object.assign(s.state, seamsState(s.state));
    s.refresh();
    assert.deepEqual(
      contractResultHold(s.facts, s.config),
      approval,
      s.fixture.name,
    );
    assert.equal(triageBacked(s.facts, s.config), backed, s.fixture.name);
  }
});

test("v3 base-v2 waits for an exact observation and refuses a cutoff mismatch", () => {
  const s = sample();
  Object.assign(s.state, seamsState(s.state));
  s.refresh();
  assert.equal(contractResultHold(s.facts, s.config), null);
  s.state.observation = `sha256:${"0".repeat(64)}`;
  s.refresh();
  assert.equal(contractResultHold(s.facts, s.config)?.waiting, true);
  s.state.selection.cutoff.id = "c".repeat(40);
  s.refresh();
  assert.match(contractResultHold(s.facts, s.config)!.reason, /mode\/cutoff/);
});

test("historical v3 exemption approval never authorizes the current event", () => {
  for (const fields of [
    {
      status: "awaiting-review",
      label: null,
      reviewer: null,
      reviewEventId: null,
    },
    { reviewEventId: "other-event" },
    {
      status: "needs-attention",
      revision: null,
      source: null,
      label: null,
      reviewer: null,
      reviewEventId: null,
    },
  ]) {
    const facts = recordedSeamsFacts();
    const state = { ...structuredClone(recordedSeamsState), ...fields };
    facts.comments[1].body = resultComment(state).body;
    assert.match(
      contractResultHold(facts, contractConfiguration)!.reason,
      /does not approve the current/,
    );
  }
  const s = sample();
  Object.assign(s.state, seamsState(s.state), { reviewEventId: "other-event" });
  s.state.seamsExemption.reviewEventId = String(s.facts.ready.id);
  s.refresh();
  assert.match(
    contractResultHold(s.facts, s.config)!.reason,
    /does not approve the current/,
  );
  Object.assign(s.state, {
    status: "needs-attention",
    revision: null,
    source: null,
    factoryTriage: null,
  });
  s.state.selection.state = "held";
  s.refresh();
  assert.match(contractResultHold(s.facts, s.config)!.reason, /mode\/cutoff/);
  assert.equal(triageBacked(s.facts, s.config), false);
});

test("malformed v3 wrappers and invalid base fields refuse as unreadable", () => {
  const corruptions: [string, (state: any) => void][] = [
    [
      "missing exemption",
      (s) => {
        delete s.seamsExemption;
      },
    ],
    [
      "null exemption",
      (s) => {
        s.seamsExemption = null;
      },
    ],
    [
      "invalid exemption label",
      (s) => {
        s.seamsExemption.label = "factory:running";
      },
    ],
    [
      "invalid boundary",
      (s) => {
        s.seamsExemption.boundary.commit = "invalid";
      },
    ],
    [
      "review after boundary",
      (s) => {
        s.seamsExemption.reviewedAt = "2026-11-12T00:00:00Z";
      },
    ],
    [
      "revision mismatch",
      (s) => {
        s.seamsExemption.revision = `sha256:${"0".repeat(64)}`;
      },
    ],
    [
      "source mismatch",
      (s) => {
        s.seamsExemption.source.id = "99";
      },
    ],
    [
      "missing base",
      (s) => {
        delete s.baseFormat;
      },
    ],
    [
      "unknown base",
      (s) => {
        s.baseFormat = "repo-canon/issue-contract-state/v4";
      },
    ],
    [
      "invalid status",
      (s) => {
        s.status = "invalid";
      },
    ],
    [
      "missing base field",
      (s) => {
        delete s.event;
      },
    ],
  ];
  for (const [name, corrupt] of corruptions) {
    const facts = recordedSeamsFacts();
    const state = structuredClone(recordedSeamsState);
    corrupt(state);
    facts.comments[1].body = resultComment(state).body;
    assert.match(
      contractResultHold(facts, contractConfiguration)!.reason,
      /unreadable/,
      name,
    );
    assert.throws(
      () => requirePreparedProtocol(facts.comments, contractConfiguration),
      /unreadable/,
      name,
    );
  }
  const s = sample();
  Object.assign(s.state, seamsState(s.state), { observation: "invalid" });
  s.refresh();
  assert.match(contractResultHold(s.facts, s.config)!.reason, /unreadable/);
});

test("v3 validity must belong to the same comment and state the configuration selects", () => {
  for (const mismatch of [
    "missing feedback marker",
    "different author",
    "different state marker",
    "newer Canon comment",
  ]) {
    const facts = recordedSeamsFacts();
    const config = structuredClone(contractConfiguration);
    const feedback = facts.comments[1];
    if (mismatch === "missing feedback marker")
      feedback.body = recordedSeamsLine;
    if (mismatch === "different author") {
      feedback.author!.login = "other-validator[bot]";
      config.contractResult.author = feedback.author!.login;
    }
    if (mismatch === "different state marker") {
      config.contractResult.marker = "other:state";
      feedback.body += `\n${recordedSeamsLine.replace("repo-canon:issue-contract-state", "other:state").replace('"status":"approved"', '"status":"awaiting-review"')}`;
    }
    if (mismatch === "newer Canon comment") {
      facts.comments.push(
        resultComment(recordedSeamsState, {
          id: feedback.id + 1,
          body: "<!-- repo-canon:issue-contract-feedback -->",
        }),
      );
    }
    assert.match(
      contractResultHold(facts, config)!.reason,
      /unreadable/,
      mismatch,
    );
  }
});

test("factory triage proof on v3 base-v1 retains the comment identity and single run marker checks", () => {
  const facts = recordedSeamsFacts();
  const config = structuredClone(contractConfiguration);
  facts.ready.actor = { login: "factory[bot]", bot: true };
  facts.comments[0].author = facts.ready.actor;
  facts.comments[0].body += '\n<!-- scriptorium:run {"run":"triage-7"} -->';
  assert.equal(contractResultHold(facts, config), null);
  assert.equal(triageBacked(facts, config), true);
  facts.comments[0].body += '\n<!-- scriptorium:run {"run":"triage-8"} -->';
  assert.equal(triageBacked(facts, config), false);
});
