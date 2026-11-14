import type { Comment } from "@lutzseverino/postern";

// The configuration a Repo Canon adopter names its validator's result with.
export const contractResult = {
  marker: "repo-canon:issue-contract-state",
  author: "github-actions[bot]",
};

// A state line the issue-contract validator of Repo Canon v0.21.0 published
// on lutzseverino/repo-canon#797, copied byte for byte: a complete Agent Brief
// awaiting review. It is a recorded fixture, not built by the factory's code.
export const recordedLine =
  '<!-- repo-canon:issue-contract-state {"format":"repo-canon/issue-contract-state/v1","status":"awaiting-review","kind":"triaged Agent Brief","revision":"sha256:f51bae97d50e3d221ff33ea4ce545274e061a54eab0f9a655bc80824ddcc5781","source":{"type":"comment","id":"6550827964","editedAt":"2026-11-01T02:47:41Z"},"label":null,"reviewer":null,"reviewEventId":null,"event":{"kind":"commentCreated","actor":"lutzseverino","label":null,"commentId":"6555737750"},"evaluatedAt":"2026-11-01T08:50:39Z","observedEventId":null,"sourceInvalidation":null,"publishedAt":"2026-11-01T02:47:50Z","rejectionReason":null,"rejectedCreationLabel":null} -->';

// The Agent Brief comment a result names, as the platform reports it.
export const briefComment: Comment = {
  id: 10,
  nodeId: "IC_10",
  url: "https://github.com/acme/widgets/issues/1#issuecomment-10",
  author: { login: "owner", bot: false },
  createdAt: "2026-10-02T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  body: "## Agent Brief\n\n**Category:** bug\n",
};

// The recorded line's state with `fields` replaced, by default approving the
// owner's ready-for-agent event 42 for the Agent Brief above.
export function resultState(fields: Record<string, unknown> = {}) {
  return {
    ...JSON.parse(
      recordedLine.slice(
        "<!-- repo-canon:issue-contract-state ".length,
        -" -->".length,
      ),
    ),
    status: "approved",
    source: { type: "comment", id: "10", editedAt: briefComment.updatedAt },
    label: "ready-for-agent",
    reviewer: "owner",
    reviewEventId: "42",
    ...fields,
  };
}

// The validator's feedback comment holding `state`, posted just after the
// ready-for-agent event of October 5.
export function resultComment(
  state: unknown = resultState(),
  details: Partial<Comment> = {},
): Comment {
  return {
    id: 11,
    nodeId: "IC_11",
    url: "https://github.com/acme/widgets/issues/1#issuecomment-11",
    author: { login: "github-actions[bot]", bot: true },
    createdAt: "2026-10-03T00:00:00Z",
    updatedAt: "2026-10-05T00:00:01Z",
    body: `<!-- repo-canon:issue-contract-feedback -->\n<!-- repo-canon:issue-contract-state ${typeof state === "string" ? state : JSON.stringify(state)} -->\n## Issue contract readiness recorded\n\nThe contract is bound to \`ready-for-agent\`.`,
    ...details,
  };
}

// Public v3 result on repo-canon#920, comment 6730348269, copied byte for byte.
export const recordedSeamsLine =
  '<!-- repo-canon:issue-contract-state {"format":"repo-canon/issue-contract-state/v3","baseFormat":"repo-canon/issue-contract-state/v1","seamsExemption":{"boundary":{"tag":"v0.26.0","commit":"59969a4dc26ad7e2343d27e72983197e2ec5b4a9","publishedAt":"2026-11-11T05:09:33Z"},"revision":"sha256:73042ff32233cb56d7de7c3f15c59c22ce00270816294174385f9af1660c8a49","source":{"type":"comment","id":"6730346641","editedAt":"2026-11-09T01:51:48Z"},"evaluatedAt":"2026-11-09T01:53:49Z","publishedAt":"2026-11-09T01:51:57Z","reviewedAt":"2026-11-09T01:53:39Z","reviewer":"lutzseverino","reviewEventId":"35526739175","label":"state:ready"},"status":"approved","kind":"triaged Agent Brief","revision":"sha256:73042ff32233cb56d7de7c3f15c59c22ce00270816294174385f9af1660c8a49","source":{"type":"comment","id":"6730346641","editedAt":"2026-11-09T01:51:48Z"},"label":"state:ready","reviewer":"lutzseverino","reviewEventId":"35526739175","event":{"kind":"commentCreated","actor":"lutzseverino","label":null,"commentId":"6833006765"},"evaluatedAt":"2026-11-12T18:57:17Z","observedEventId":"35526739175","sourceInvalidation":null,"publishedAt":"2026-11-09T01:51:57Z","rejectionReason":null,"rejectedCreationLabel":null} -->';

export const recordedSeamsState = JSON.parse(
  recordedSeamsLine.slice("<!-- repo-canon:issue-contract-state ".length, -4),
);

// Derive exemptions from the recorded proof while varying only the base decision.
export function seamsState(state: Record<string, any>) {
  return {
    ...state,
    format: "repo-canon/issue-contract-state/v3",
    baseFormat: state.format,
    seamsExemption: {
      ...structuredClone(recordedSeamsState.seamsExemption),
      revision: state.revision ?? recordedSeamsState.revision,
      source: state.source ?? recordedSeamsState.source,
    },
  };
}
