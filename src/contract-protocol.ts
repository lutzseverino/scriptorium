// Repo Canon's public body-contract wire interface. This module handles exact
// platform identities and storage, never contract Markdown or authorization.
// Protocol: repo-canon commit 94484be, docs/development/issue-contract-v2.md.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  PlatformError,
  type ConnectionWithLinkAdditions,
  type Comment,
  type Issue,
  type LabelChange,
} from "@lutzseverino/postern";

export const bodyResultFormat = "repo-canon/issue-contract-state/v2";
export const attestationFormat = "repo-canon/triage-attestation/v1";
export const ledgerBranch = "repo-canon/issue-contracts";
export const digest = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const same = isDeepStrictEqual;
export type Edit = { id: string; editedAt: string | null };
export type BodySource = {
  type: "issue-body";
  editedAt: string | null;
  editId: string;
};
export type Intake = {
  original: string;
  author: string;
  writerRun: string | null;
  writerProof?: WriterProof | null;
  sourceEdit?: Edit;
};
export type WriterProof = {
  repository: string;
  issue: string;
  run: string;
  sourceEdit: Edit;
};
export type Attestation = {
  format: typeof attestationFormat;
  repository: string;
  issue: string;
  run: string;
  outcome: "success";
  revision: string;
  source: BodySource;
  intake: Pick<Intake, "author" | "writerRun">;
};
export type Association = Omit<
  Attestation,
  "format" | "repository" | "issue" | "outcome"
> & {
  attestation: { id: string; revision: string; edit: Edit };
};
export type SourceRecord = {
  issue: string;
  cutoff: string;
  migrated: boolean;
  retired: boolean;
  intake?: Intake;
  publication?: {
    payload: Attestation;
    attestation: Association["attestation"];
    noticedAt?: string;
  };
  [key: string]: unknown;
};
export type Receipt = {
  format: "repo-canon/issue-contract-cutoff/v1";
  repository: string;
  complete: true;
  publicationFrozen: true;
  release: string;
  sha: string;
  epoch: string;
  issues: {
    issue: string;
    number: number;
    legacy: null | {
      revision: string;
      source: { type: "comment"; id: string; editedAt: string | null };
      edit: Edit;
    };
  }[];
};
export type ContractMode =
  { mode: "prepared" } | { mode: "body"; cutoff: string; receipt: Receipt };
type Connection = ConnectionWithLinkAdditions;
export const hash = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
export const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && value.trim() === value;
const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const time = (value: unknown): value is string | null =>
  value === null ||
  (typeof value === "string" && Number.isFinite(Date.parse(value)));
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const validEdit = (value: unknown): value is Edit =>
  object(value) && text(value.id) && time(value.editedAt);
export const validBodySource = (value: unknown): value is BodySource =>
  object(value) &&
  value.type === "issue-body" &&
  time(value.editedAt) &&
  text(value.editId);

export class ContractPublicationHold extends Error {}
export const hold = (reason: string): never => {
  throw new ContractPublicationHold(
    `${reason}; restore trusted contract facts and retry, or obtain a fresh triage/review of the current revision`,
  );
};

export async function request(
  connection: Connection,
  input: Parameters<Connection["access"]["request"]>[0],
): Promise<unknown> {
  return (await connection.access.request(input)).data;
}
const base = (connection: Connection) => `/repos/${connection.repository.path}`;

export async function contractFile<T>(
  connection: Connection,
  path: string,
  ref: string,
): Promise<{ value: T; sha: string } | null> {
  try {
    const data = await request(connection, {
      path: `${base(connection)}/contents/${path}?ref=${encodeURIComponent(ref)}`,
    });
    if (
      !object(data) ||
      data.type !== "file" ||
      data.encoding !== "base64" ||
      !text(data.sha) ||
      typeof data.content !== "string"
    )
      return hold(`Unreadable contract storage ${path}`);
    const bytes = Buffer.from(data.content, "base64");
    if (bytes.length !== data.size)
      return hold(`Truncated contract storage ${path}`);
    return { value: JSON.parse(bytes.toString("utf8")) as T, sha: data.sha };
  } catch (error) {
    if (error instanceof PlatformError && error.reason === "notFound")
      return null;
    throw error;
  }
}

// Pin the destination default branch. A verified absent configuration means
// prepared, including old validators; failures never imply legacy mode.
export async function readContractMode(
  connection: Connection,
): Promise<ContractMode> {
  const repo = await request(connection, { path: base(connection) });
  if (!object(repo) || !text(repo.default_branch))
    return hold("Repository default branch is unavailable");
  const ref = await request(connection, {
    path: `${base(connection)}/git/ref/heads/${repo.default_branch}`,
  });
  if (!object(ref) || !object(ref.object) || !sha(ref.object.sha))
    return hold("Repository default revision is unavailable");
  const file = await contractFile<Record<string, unknown>>(
    connection,
    ".github/issue-contracts.json",
    ref.object.sha,
  );
  if (
    !file ||
    (object(file.value) &&
      file.value.mode === "prepared" &&
      Object.keys(file.value).length === 1)
  )
    return { mode: "prepared" };
  if (
    !object(file.value) ||
    file.value.mode !== "body" ||
    !sha(file.value.cutoff) ||
    Object.keys(file.value).sort().join() !== "cutoff,mode"
  )
    return hold("Unknown or conflicting issue-contract mode/cutoff");
  const receipt = (
    await contractFile<Receipt>(connection, "cutoff.json", file.value.cutoff)
  )?.value;
  if (
    !receipt ||
    receipt.format !== "repo-canon/issue-contract-cutoff/v1" ||
    receipt.repository !== connection.repository.path ||
    receipt.complete !== true ||
    receipt.publicationFrozen !== true ||
    !text(receipt.release) ||
    !sha(receipt.sha) ||
    !time(receipt.epoch) ||
    receipt.epoch === null ||
    !Array.isArray(receipt.issues) ||
    new Set(receipt.issues.map((e) => e.issue)).size !==
      receipt.issues.length ||
    receipt.issues.some(
      (e) =>
        !text(e.issue) ||
        !Number.isSafeInteger(e.number) ||
        (e.legacy &&
          (!hash(e.legacy.revision) ||
            e.legacy.source?.type !== "comment" ||
            !/^\d+$/.test(e.legacy.source.id) ||
            !validEdit(e.legacy.edit))),
    )
  )
    return hold("Trusted complete cutoff receipt is unavailable");
  return { mode: "body", cutoff: file.value.cutoff, receipt };
}

export async function sourceEdits(
  connection: Connection,
  ids: (string | null)[],
): Promise<Record<string, Edit>> {
  if (ids.some((id) => !id))
    return hold("Exact source node identity is unavailable");
  const unique = [...new Set(ids as string[])],
    edits: Record<string, Edit> = {};
  for (let offset = 0; offset < unique.length; offset += 50) {
    const batch = unique.slice(offset, offset + 50);
    const response = await request(connection, {
      method: "POST",
      path: "/graphql",
      body: {
        query: `query ContractSourceEdits($ids:[ID!]!) { nodes(ids:$ids) { ... on Issue { id lastEditedAt userContentEdits(first:1) { nodes { id editedAt deletedAt } } } ... on IssueComment { id lastEditedAt userContentEdits(first:1) { nodes { id editedAt deletedAt } } } } }`,
        variables: { ids: batch },
      },
    });
    if (
      !object(response) ||
      response.errors ||
      !object(response.data) ||
      !Array.isArray(response.data.nodes) ||
      response.data.nodes.length !== batch.length
    )
      return hold("Source edit history is unavailable");
    for (const node of response.data.nodes) {
      if (
        !object(node) ||
        !text(node.id) ||
        !batch.includes(node.id) ||
        !time(node.lastEditedAt) ||
        !object(node.userContentEdits) ||
        !Array.isArray(node.userContentEdits.nodes)
      )
        return hold("Source edit history is incomplete");
      const edit = node.userContentEdits.nodes[0];
      if (
        node.lastEditedAt &&
        (!object(edit) ||
          !text(edit.id) ||
          edit.deletedAt ||
          edit.editedAt !== node.lastEditedAt)
      )
        return hold("Source edit identity is unavailable");
      edits[node.id] = {
        id: node.lastEditedAt ? edit.id : `created:${node.id}`,
        editedAt: node.lastEditedAt,
      };
    }
    if (batch.some((id) => !edits[id]))
      return hold("Source edit history has conflicting identities");
  }
  return edits;
}

export async function commentDeletionIdentity(
  connection: Connection,
  number: number,
): Promise<string | null> {
  const [owner, name] = connection.repository.path.split("/");
  const response = await request(connection, {
    method: "POST",
    path: "/graphql",
    body: {
      query: `query ContractEvidenceDeletions($owner:String!,$name:String!,$number:Int!) { repository(owner:$owner,name:$name) { issue(number:$number) { timelineItems(last:1,itemTypes:[COMMENT_DELETED_EVENT]) { nodes { ... on CommentDeletedEvent { id } } } } } }`,
      variables: { owner, name, number },
    },
  });
  const data = object(response) && object(response.data) ? response.data : null;
  const repo = data && object(data.repository) ? data.repository : null;
  const issue = repo && object(repo.issue) ? repo.issue : null;
  const timeline =
    issue && object(issue.timelineItems) ? issue.timelineItems : null;
  const nodes =
    timeline && Array.isArray(timeline.nodes) ? timeline.nodes : null;
  if (
    !nodes ||
    nodes.length > 1 ||
    (nodes.length === 1 && (!object(nodes[0]) || !text(nodes[0].id)))
  )
    return hold(
      "Exact comment deletion history is unavailable during evidence publication",
    );
  return nodes.length ? (nodes[0].id as string) : null;
}

// Canon's canonical observation serialization (public v2). Reporting changes
// its digest, but not the selected source, acceptance or immutable proof.
export function contractObservation(
  issue: Issue,
  comments: Comment[],
  changes: LabelChange[],
  edits: Record<string, Edit>,
  readyLabel = "state:ready",
): string {
  const observed = changes.findLast(
    (c) =>
      (c.label === readyLabel ||
        (readyLabel === "ready-for-agent" && c.label === "ready-for-human")) &&
      !(c.action === "removed" && c.actor?.login === "github-actions[bot]"),
  );
  return digest(
    JSON.stringify({
      issue: issue.nodeId,
      body: issue.body,
      bodyEdit: edits[issue.nodeId!] ?? null,
      labels: [...issue.labels].sort(),
      comments: observationComments(comments)
        .map((c) => ({
          id: String(c.id),
          body: c.body,
          author: c.author?.login,
          editedAt: c.updatedAt ?? null,
          edit: edits[c.nodeId!] ?? null,
        }))
        .sort((a, b) =>
          BigInt(a.id) < BigInt(b.id)
            ? -1
            : BigInt(a.id) > BigInt(b.id)
              ? 1
              : 0,
        ),
      observedEventId: observed ? String(observed.id) : null,
    }),
  );
}
export const observationComments = (comments: Comment[]) =>
  comments.filter(
    (c) =>
      !(
        c.author?.login === "github-actions[bot]" &&
        c.body.includes("<!-- repo-canon:issue-contract-feedback -->")
      ),
  );
export function bodyRevision(
  issue: Issue,
  edit: Edit,
): { revision: string; source: BodySource } {
  const source: BodySource = {
    type: "issue-body",
    editedAt: issue.bodyEditTime,
    editId: edit.id,
  };
  return {
    source,
    revision: digest(
      JSON.stringify({
        format: "repo-canon/issue-contract-revision/v1",
        kind: "triaged Agent Brief",
        source: {
          type: "issue-body",
          id: issue.nodeId,
          editedAt: source.editedAt,
          editId: source.editId,
        },
        body: issue.body,
      }),
    ),
  };
}

// A body mutation has no API compare-and-swap. If its response/checkpoint was
// lost, authenticate the host's one edit and its exact predecessor, rather
// than adopting equal bytes or overwriting a human edit. Incomplete history
// deliberately cannot recover a publication.
export async function verifyBodyWrite(
  connection: Connection,
  issue: Issue,
  edit: Edit,
  original: { issue: string; edit: Edit; createdAt: string },
  intended: string,
  author: string,
): Promise<void> {
  const response = await request(connection, {
    method: "POST",
    path: "/graphql",
    body: {
      query: `query ContractBodyPublication($id:ID!) { node(id:$id) { ... on Issue { id body lastEditedAt includesCreatedEdit userContentEdits(first:2) { totalCount nodes { id editedAt deletedAt editor { __typename login } } } } } }`,
      variables: { id: original.issue },
    },
  });
  const data =
    object(response) && object(response.data) ? response.data.node : null;
  const history =
    object(data) && object(data.userContentEdits)
      ? data.userContentEdits
      : null;
  const nodes = history && Array.isArray(history.nodes) ? history.nodes : [];
  const latest = nodes[0],
    previous = nodes[1];
  const predecessor =
    original.edit.id === `created:${original.issue}`
      ? (history?.totalCount === 1 && nodes.length === 1) ||
        (history?.totalCount === 2 &&
          object(data) &&
          data.includesCreatedEdit === true &&
          object(previous) &&
          !previous.deletedAt &&
          previous.editedAt === original.createdAt)
      : object(previous) &&
        !previous.deletedAt &&
        previous.id === original.edit.id &&
        previous.editedAt === original.edit.editedAt;
  const editor = object(latest) && object(latest.editor) ? latest.editor : null;
  const editorLogin =
    editor && typeof editor.login === "string"
      ? editor.__typename === "Bot"
        ? `${editor.login.replace(/\[bot\]$/i, "")}[bot]`
        : editor.__typename === "User"
          ? editor.login
          : null
      : null;
  if (
    !object(data) ||
    data.id !== issue.nodeId ||
    data.body !== intended ||
    data.lastEditedAt !== issue.bodyEditTime ||
    !object(latest) ||
    latest.id !== edit.id ||
    latest.editedAt !== edit.editedAt ||
    latest.deletedAt ||
    editorLogin?.toLowerCase() !== author.toLowerCase() ||
    !predecessor
  )
    return hold(
      "Body write cannot be authenticated against its recorded host intent and exact predecessor; preserve concurrent edits or recover complete authenticated publication history",
    );
}
export function markedRun(markdown: string, marker: string): string | null {
  const lines = markdown
    .split(/\r\n?|\n/)
    .filter((line) => line.includes(`<!-- ${marker}`));
  const prefix = `<!-- ${marker} `;
  if (
    lines.length !== 1 ||
    !lines[0].startsWith(prefix) ||
    !lines[0].endsWith(" -->")
  )
    return null;
  try {
    const value = JSON.parse(lines[0].slice(prefix.length, -4));
    return text(value?.run) ? value.run : null;
  } catch {
    return null;
  }
}
export function readAttestation(comment: Comment): Attestation | null {
  const prefix = "<!-- repo-canon:triage-attestation ";
  const lines = comment.body
    .split(/\r\n?|\n/)
    .filter((line) => line.includes("<!-- repo-canon:triage-attestation"));
  if (
    lines.length !== 1 ||
    !lines[0].startsWith(prefix) ||
    !lines[0].endsWith(" -->")
  )
    return null;
  try {
    const value = JSON.parse(lines[0].slice(prefix.length, -4));
    return value?.format === attestationFormat &&
      text(value.repository) &&
      text(value.issue) &&
      text(value.run) &&
      value.outcome === "success" &&
      hash(value.revision) &&
      validBodySource(value.source) &&
      text(value.intake?.author) &&
      (value.intake.writerRun === null || text(value.intake.writerRun))
      ? value
      : null;
  } catch {
    return null;
  }
}

// Reporting never upserts an identity the validator names as immutable proof,
// even if someone edits that record to resemble a report. No authority is
// inferred here: this set only narrows mutable reporting targets.
export function contractEvidenceIds(
  comments: Comment[],
  result: { marker: string; author: string },
): Set<string> {
  const ids = new Set<string>();
  const prefix = `<!-- ${result.marker} `;
  for (const comment of comments) {
    if (comment.author?.login.toLowerCase() !== result.author.toLowerCase())
      continue;
    for (const line of comment.body.split(/\r\n?|\n/)) {
      if (!line.startsWith(prefix) || !line.endsWith(" -->")) continue;
      try {
        const state = JSON.parse(line.slice(prefix.length, -4));
        if (state?.source?.type === "comment" && text(state.source.id))
          ids.add(state.source.id);
        if (text(state?.factoryTriage?.attestation?.id))
          ids.add(state.factoryTriage.attestation.id);
      } catch {
        /* Malformed feedback cannot select a reporting target. */
      }
    }
  }
  return ids;
}
