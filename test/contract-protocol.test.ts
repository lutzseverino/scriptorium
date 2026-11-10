import assert from "node:assert/strict";
import { test } from "node:test";
import type { Comment, Issue, LabelChange } from "@lutzseverino/postern";
import {
  contractResultHold,
  triageBacked,
  type ContractFacts,
} from "../src/contract-result.ts";
import {
  bodyRevision,
  contractObservation,
  digest,
} from "../src/contract-protocol.ts";
import { readinessExclusion } from "../src/readiness.ts";
import { canonical, contractConfiguration } from "./contract-fixture.ts";

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
        s.state.format = "repo-canon/issue-contract-state/v3";
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
