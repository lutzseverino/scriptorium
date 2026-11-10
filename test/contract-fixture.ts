// Stateful platform/validator fixture for the public v2 publication handshake.
// Literal positive and negative Canon decisions live beside it; this fake
// supplies automatic evaluation timing, not an alternative policy interpreter.
import { readFileSync } from "node:fs";
import {
  PlatformError,
  type ConnectionWithLinkAdditions,
  type Issue,
  type Comment,
  type LabelChange,
} from "@lutzseverino/postern";
import {
  bodyRevision,
  contractObservation,
  digest,
  same,
  type Edit,
  type SourceRecord,
  type Receipt,
  type ContractMode,
} from "../src/contract-protocol.ts";
import type { FactoryConfiguration } from "../src/factory-configuration.ts";

export const canonical = JSON.parse(
  readFileSync(
    new URL("./fixtures/issue-contract-v2.json", import.meta.url),
    "utf8",
  ),
);
export const contractConfiguration: Extract<
  FactoryConfiguration,
  { version: 3 }
> = {
  version: 3,
  labels: {
    ready: "state:ready",
    triage: "state:triage",
    running: "factory:running",
    paused: "factory:paused",
    failed: "factory:failed",
    owner: "state:owner",
  },
  contractResult: {
    marker: "repo-canon:issue-contract-state",
    author: "github-actions[bot]",
  },
  triageResult: { marker: "scriptorium:run", author: "factory[bot]" },
  modelLabelPrefix: "model:",
  runKinds: {
    triage: {
      skill: "triage",
      arguments: "#{issue}",
      resultLabels: ["model:", "type:"],
    },
    implement: { skill: "implement", arguments: "#{issue}" },
    review: { skill: "review", arguments: "#{issue}" },
  },
};
export const brief = canonical.cases[2].snapshot.issue.body
  .split("\n\n## Original request")[0]
  .replace(/^>.*\n\n/, "");
export function contractFixture(number = 4, repository = "acme/widgets") {
  const author = { login: "factory[bot]", bot: true };
  const issue: Issue = {
    number,
    id: number,
    nodeId: `I_${number}`,
    state: "open",
    title: "Search",
    body: "Search is slow.\n\nKeep these bytes.\n",
    author: { login: "owner", bot: false },
    labels: ["state:triage"],
    createdAt: "2026-10-04T00:00:00Z",
    bodyEditTime: null,
    parent: null,
    subIssues: [],
    blockedBy: [],
    linkTime: null,
    url: `https://github.com/${repository}/issues/${number}`,
  };
  const receipt: Receipt = {
    format: "repo-canon/issue-contract-cutoff/v1",
    repository,
    complete: true,
    publicationFrozen: true,
    release: "v0.24.0",
    sha: "b".repeat(40),
    epoch: "2026-10-08T00:00:00Z",
    issues: [],
  };
  const mode: ContractMode = { mode: "body", cutoff: "a".repeat(40), receipt };
  const comments: Comment[] = [];
  const changes: LabelChange[] = [
    {
      id: 1,
      action: "added",
      label: "state:triage",
      actor: { login: "owner", bot: false },
      time: issue.createdAt,
    },
  ];
  const edits: Record<string, Edit> = {
    [issue.nodeId!]: { id: `created:${issue.nodeId}`, editedAt: null },
  };
  const writes: string[] = [];
  let record: SourceRecord | undefined,
    version = 0,
    clock = 0;
  let state: Record<string, any> | null = null;
  const controls = {
    evaluation: true,
    format: undefined as string | undefined,
    mode: "body",
    fail: "",
    bodyEditor: "factory[bot]",
    missingResult: false,
    deletion: null as string | null,
    before: undefined as (() => void) | undefined,
  };
  const at = () =>
    `2026-10-08T01:${String(Math.floor(clock++ / 60)).padStart(2, "0")}:${String(clock % 60).padStart(2, "0")}Z`;
  const fail = (stage: string) => {
    if (controls.fail === stage) {
      controls.fail = "";
      throw new Error(`interrupted ${stage}`);
    }
  };
  const feedback = () =>
    !controls.missingResult &&
    state &&
    ({
      id: 99999,
      nodeId: "FEEDBACK",
      author: { login: "github-actions[bot]", bot: true },
      body: `<!-- repo-canon:issue-contract-feedback -->\n<!-- repo-canon:issue-contract-state ${JSON.stringify(state)} -->`,
      createdAt: "2026-10-08T01:00:00Z",
      updatedAt: "2026-10-08T02:00:00Z",
      url: "https://github.com/feedback",
    } satisfies Comment);
  const evaluate = () => {
    if (!controls.evaluation) return;
    const categories = issue.labels.filter((label) =>
      ["type:bug", "type:enhancement"].includes(label),
    );
    const bodySelected = categories.length === 1 && issue.bodyEditTime !== null;
    const selected = bodySelected
      ? bodyRevision(issue, edits[issue.nodeId!])
      : {
          revision: null,
          source: { type: "issue-body", editedAt: issue.bodyEditTime },
        };
    const proof = record?.publication;
    const evidence =
      proof && comments.find((c) => String(c.id) === proof.attestation.id);
    const association =
      bodySelected &&
      proof &&
      evidence &&
      digest(evidence.body) === proof.attestation.revision &&
      same(edits[evidence.nodeId!], proof.attestation.edit) &&
      same(proof.payload.source, selected.source)
        ? {
            run: proof.payload.run,
            ...selected,
            attestation: proof.attestation,
            intake: proof.payload.intake,
          }
        : null;
    if (association && proof && !proof.noticedAt) {
      proof.noticedAt = at();
      version++;
    }
    const ready = changes.findLast((c) => c.label === "state:ready");
    state = {
      ...canonical.cases[2].state,
      format:
        controls.format ??
        (controls.mode === "prepared"
          ? "repo-canon/issue-contract-state/v1"
          : "repo-canon/issue-contract-state/v2"),
      status:
        ready?.action === "added" &&
        issue.labels.includes("state:ready") &&
        association
          ? "approved"
          : bodySelected
            ? "awaiting-review"
            : "needs-attention",
      ...selected,
      label: ready?.action === "added" ? "state:ready" : null,
      reviewEventId: ready ? String(ready.id) : null,
      publishedAt: "2026-10-08T00:59:00Z",
      selection: {
        mode: "body",
        cutoff: {
          id: mode.cutoff,
          release: receipt.release,
          sha: receipt.sha,
          epoch: receipt.epoch,
        },
        state: bodySelected ? "migrated" : "native",
        reason: null,
      },
      factoryTriage: association,
      observation: contractObservation(issue, comments, changes, edits),
    };
  };
  const wrap = (
    fallback: ConnectionWithLinkAdditions,
  ): ConnectionWithLinkAdditions => ({
    ...fallback,
    issueTracker: {
      ...fallback.issueTracker,
      async issue() {
        return structuredClone(issue);
      },
      async issues(filter = {}) {
        return filter.state === "closed" ||
          (filter.label && !issue.labels.includes(filter.label))
          ? []
          : [structuredClone(issue)];
      },
      async comments() {
        evaluate();
        const f = feedback();
        return structuredClone([...comments, ...(f ? [f] : [])]);
      },
      async labelChanges() {
        return structuredClone(changes);
      },
      async addLabels(_number, labels) {
        fail("labels");
        for (const label of labels) {
          if (issue.labels.includes(label)) continue;
          writes.push(`label ${label}`);
          issue.labels.push(label);
          changes.push({
            id: changes.length + 1,
            action: "added",
            label,
            actor: author,
            time: at(),
          });
        }
        evaluate();
      },
      async removeLabel(_number, label) {
        if (issue.labels.includes(label)) {
          writes.push(`remove ${label}`);
          issue.labels = issue.labels.filter((l) => l !== label);
          changes.push({
            id: changes.length + 1,
            action: "removed",
            label,
            actor: author,
            time: at(),
          });
        }
        evaluate();
      },
      async createComment(_number, body) {
        fail("comment");
        const time = at();
        const c: Comment = {
          id: comments.length + 100,
          nodeId: `C_${comments.length + 100}`,
          body,
          author,
          createdAt: time,
          updatedAt: time,
          url: `https://github.com/comment/${comments.length + 100}`,
        };
        writes.push(
          body.includes("triage-attestation") ? "attestation" : "report",
        );
        comments.push(c);
        edits[c.nodeId!] = { id: `created:${c.nodeId}`, editedAt: null };
        evaluate();
        fail("after-comment");
        return structuredClone(c);
      },
      async updateComment(id, body) {
        const c = comments.find((c) => c.id === id)!;
        c.body = body;
        c.updatedAt = at();
        edits[c.nodeId!] = { id: `edit:${clock}`, editedAt: c.updatedAt };
        writes.push("update report");
        evaluate();
        fail("after-comment");
        return structuredClone(c);
      },
    },
    access: {
      ...fallback.access,
      async request(input) {
        const path = input.path,
          body = input.body as any;
        const data = (data: unknown) => ({ status: 200, headers: {}, data });
        if (path === `/repos/${repository}`)
          return data({ default_branch: "main" });
        if (path === `/repos/${repository}/git/ref/heads/main`)
          return data({ object: { sha: "c".repeat(40) } });
        if (path.includes("/contents/")) {
          if (input.method === "PUT") {
            fail("ledger");
            if (body.sha !== (version ? String(version) : undefined))
              throw new Error("CAS conflict");
            record = JSON.parse(Buffer.from(body.content, "base64").toString());
            version++;
            writes.push("ledger");
            return data({ content: { sha: String(version) } });
          }
          let value: unknown;
          if (path.includes(".github/issue-contracts.json")) {
            if (controls.mode === "prepared")
              throw new PlatformError("notFound", "No mode file");
            value = { mode: controls.mode, cutoff: mode.cutoff };
          } else if (path.includes("cutoff.json")) value = receipt;
          else value = record;
          if (!value) throw new PlatformError("notFound", "No record");
          const bytes = Buffer.from(JSON.stringify(value));
          return data({
            type: "file",
            encoding: "base64",
            content: bytes.toString("base64"),
            size: bytes.length,
            sha: String(version),
          });
        }
        if (input.method === "PATCH") {
          fail("body");
          controls.before?.();
          issue.body = body.body;
          issue.bodyEditTime = at();
          edits[issue.nodeId!] = {
            id: `BODY_${clock}`,
            editedAt: issue.bodyEditTime,
          };
          writes.push("body");
          evaluate();
          fail("after-body");
          return data({});
        }
        if (path.endsWith("/dispatches")) {
          fail("dispatch");
          writes.push("dispatch");
          evaluate();
          return data({});
        }
        if (
          path === "/graphql" &&
          body.query.includes("ContractBodyPublication")
        ) {
          const edit = edits[issue.nodeId!];
          return data({
            data: {
              node: {
                id: issue.nodeId,
                body: issue.body,
                lastEditedAt: issue.bodyEditTime,
                includesCreatedEdit: false,
                userContentEdits: {
                  totalCount: 1,
                  nodes: [
                    {
                      ...edit,
                      deletedAt: null,
                      editor: {
                        __typename: controls.bodyEditor.endsWith("[bot]")
                          ? "Bot"
                          : "User",
                        login: controls.bodyEditor.replace(/\[bot\]$/, ""),
                      },
                    },
                  ],
                },
              },
            },
          });
        }
        if (
          path === "/graphql" &&
          body.query.includes("ContractEvidenceDeletions")
        )
          return data({
            data: {
              repository: {
                issue: {
                  timelineItems: {
                    nodes: controls.deletion ? [{ id: controls.deletion }] : [],
                  },
                },
              },
            },
          });
        if (path === "/graphql" && body.query.includes("ContractSourceEdits")) {
          fail("edits");
          return data({
            data: {
              nodes: body.variables.ids.map((id: string) => {
                const edit = edits[id];
                return edit
                  ? {
                      id,
                      lastEditedAt: edit.editedAt,
                      userContentEdits: {
                        nodes: edit.editedAt
                          ? [{ ...edit, deletedAt: null }]
                          : [],
                      },
                    }
                  : null;
              }),
            },
          });
        }
        if (
          path === "/graphql" &&
          body.query.includes("FactoryCommentDeletions")
        )
          return data({
            data: { repository: { issue: { timelineItems: { nodes: [] } } } },
          });
        return fallback.access.request(input);
      },
    },
  });
  return {
    wrap,
    issue,
    comments,
    edits,
    changes,
    writes,
    controls,
    mode,
    receipt,
    evaluate,
    get record() {
      return record;
    },
    set record(value) {
      record = value;
      version++;
    },
    get result() {
      return state;
    },
  };
}
