// The repository's issue-contract validator decides whether readiness is bound
// to an issue's implementation contract, and posts that decision on the issue.
// This module reads the posted result and checks it against platform facts;
// it interprets no contract and parses no Markdown. Exact observation reads
// arrive through Postern; the same reader serves publication and admission.
import type {
  Comment,
  LabelChange,
  ConnectionWithLinkAdditions,
  Issue,
} from "@lutzseverino/postern";
import {
  bodyResultFormat,
  bodyRevision,
  hold,
  contractObservation,
  digest,
  hash,
  markedRun,
  observationComments,
  readAttestation,
  readContractMode,
  same,
  sameLogin,
  sourceEdits,
  text,
  validBodySource,
  validEdit,
  type Association,
  type BodySource,
  type ContractMode,
  type Edit,
} from "./contract-protocol.ts";
import type {
  FactoryConfiguration,
  PlatformConventions,
} from "./factory-configuration.ts";
import { configured } from "./label-roles.ts";
import type { ReadinessHold } from "./readiness.ts";
import { isFactoryComment } from "./run-comment.ts";

// The legacy result format; bodyResultFormat names the supported v2 wire.
// Any other format, including a line without one, holds the issue.
export const resultFormat = "repo-canon/issue-contract-state/v1";

// One issue's platform facts. A time the platform does not report is
// undefined, which differs from null: never edited, or never deleted.
export type ContractFacts = {
  comments: Comment[];
  labelChanges: LabelChange[];
  // The latest event that applied the ready label.
  ready: LabelChange;
  bodyEditTime: string | null | undefined;
  latestDeletion: string | null | undefined;
  body?: {
    issue: Issue;
    mode: ContractMode;
    observation: string;
    edits: Record<string, Edit>;
  };
};

// A result's fields the factory reads; any may be missing or malformed.
type Result = {
  format?: unknown;
  status?: unknown;
  source?: unknown;
  label?: unknown;
  reviewEventId?: unknown;
  revision?: unknown;
};

export type BodyResult = {
  format: typeof bodyResultFormat;
  status: "approved" | "awaiting-review" | "needs-attention" | "no-contract";
  kind: string;
  revision: string | null;
  source:
    | BodySource
    | { type: "issue-body"; editedAt: string | null }
    | { type: "comment"; id: string; editedAt: string | null }
    | null;
  label: string | null;
  reviewEventId: string | null;
  publishedAt: string | null;
  selection: {
    mode: "body";
    cutoff: { id: string; release: string; sha: string; epoch: string } | null;
    state: "eligible" | "migrated" | "held" | "native";
    reason: string | null;
  };
  factoryTriage: Association | null;
  observation: string;
};

const nullableText = (value: unknown) =>
  value === null || typeof value === "string";

export function requirePreparedProtocol(
  comments: Comment[],
  configuration: PlatformConventions,
) {
  const posted = latestResult(comments, configuration.contractResult);
  // Prepared intake deliberately has no result until a contract is published.
  if (!posted) return null;
  let result;
  try {
    result = JSON.parse(posted.line);
  } catch {
    return hold("Prepared validator protocol evidence is unreadable");
  }
  if (!record(result) || result.format !== resultFormat)
    return hold(
      "Prepared publication requires the supported v1 validator protocol; unknown or body-mode results must be resolved before publishing",
    );
  return { result, comment: posted.comment };
}

// Authenticate the validator's selected revision against the immutable comment,
// without selecting a contract or interpreting its Markdown.
export function preparedContractNotice(
  comments: Comment[],
  configuration: PlatformConventions,
  evidence: Comment,
) {
  const posted = requirePreparedProtocol(comments, configuration);
  if (!posted) return null;
  const { result } = posted;
  // Canon cannot know its first notice's own write time in advance.
  const publishedAt = result.publishedAt ?? posted.comment.updatedAt;
  if (
    !text(result.kind) ||
    !same(result.source, {
      type: "comment",
      id: String(evidence.id),
      editedAt: evidence.updatedAt,
    }) ||
    result.revision !== commentRevision(evidence, result.kind)
  )
    return null;
  // A completed evaluation of this exact brief that grants no review is not a
  // wait: the immutable brief cannot be corrected in place.
  if (!["awaiting-review", "approved"].includes(String(result.status)))
    return hold(
      `The configured validator's notice for the published brief is ${String(result.status)} and permits no readiness request`,
    );
  if (
    typeof publishedAt !== "string" ||
    !Number.isFinite(Date.parse(publishedAt))
  )
    return null;
  return { ...posted, publishedAt };
}

function commentRevision(comment: Comment, kind: unknown): string {
  return digest(
    JSON.stringify({
      format: "repo-canon/issue-contract-revision/v1",
      kind,
      source: {
        type: "comment",
        id: comment.nodeId,
        editedAt: comment.updatedAt,
      },
      body: comment.body,
    }),
  );
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const fields = (
  value: unknown,
  required: string[],
  optional: string[] = [],
): value is Record<string, unknown> =>
  record(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => [...required, ...optional].includes(key));
function validSource(value: unknown): boolean {
  if (value === null) return true;
  if (!record(value) || !nullableText(value.editedAt)) return false;
  return value.type === "comment"
    ? fields(value, ["type", "id", "editedAt"]) &&
        typeof value.id === "string" &&
        /^\d+$/.test(value.id)
    : value.type === "issue-body" &&
        fields(value, ["type", "editedAt"], ["editId"]) &&
        (value.editId === undefined || text(value.editId));
}
function validAssociation(
  value: unknown,
  result: Record<string, unknown>,
): boolean {
  if (value === null) return true;
  return (
    fields(value, ["run", "revision", "source", "attestation", "intake"]) &&
    text(value.run) &&
    value.revision === result.revision &&
    same(value.source, result.source) &&
    validBodySource(value.source) &&
    fields(value.attestation, ["id", "revision", "edit"]) &&
    text(value.attestation.id) &&
    hash(value.attestation.revision) &&
    validEdit(value.attestation.edit) &&
    fields(value.intake, ["author", "writerRun"]) &&
    text(value.intake.author) &&
    (value.intake.writerRun === null || text(value.intake.writerRun))
  );
}
function validBodyResult(value: unknown): value is BodyResult {
  const nullable = [
    "label",
    "reviewer",
    "reviewEventId",
    "evaluatedAt",
    "observedEventId",
    "sourceInvalidation",
    "publishedAt",
    "rejectionReason",
    "rejectedCreationLabel",
  ];
  if (
    !fields(value, [
      "format",
      "status",
      "kind",
      "revision",
      "source",
      "event",
      "selection",
      "factoryTriage",
      "observation",
      ...nullable,
    ])
  )
    return false;
  if (
    value.format !== bodyResultFormat ||
    typeof value.status !== "string" ||
    !["approved", "awaiting-review", "needs-attention", "no-contract"].includes(
      value.status,
    ) ||
    typeof value.kind !== "string" ||
    !(value.revision === null || hash(value.revision)) ||
    !validSource(value.source) ||
    !nullable.every((key) => nullableText(value[key])) ||
    !hash(value.observation)
  )
    return false;
  if (
    !fields(value.event, ["kind", "actor", "label", "commentId"]) ||
    !Object.values(value.event).every(nullableText)
  )
    return false;
  const selection = value.selection;
  if (
    !fields(selection, ["mode", "cutoff", "state", "reason"]) ||
    selection.mode !== "body" ||
    typeof selection.state !== "string" ||
    !["eligible", "migrated", "held", "native"].includes(selection.state) ||
    !nullableText(selection.reason)
  )
    return false;
  const cutoff = selection.cutoff;
  if (cutoff === null) {
    if (selection.state !== "held") return false;
  } else if (
    !fields(cutoff, ["id", "release", "sha", "epoch"]) ||
    typeof cutoff.id !== "string" ||
    !/^[a-f0-9]{40}$/.test(cutoff.id) ||
    typeof cutoff.sha !== "string" ||
    !/^[a-f0-9]{40}$/.test(cutoff.sha) ||
    !text(cutoff.release) ||
    typeof cutoff.epoch !== "string" ||
    !Number.isFinite(Date.parse(cutoff.epoch))
  )
    return false;
  if (selection.state === "migrated" && !validBodySource(value.source))
    return false;
  if (
    value.status === "approved" &&
    (!hash(value.revision) ||
      !value.source ||
      !text(value.label) ||
      !text(value.reviewer) ||
      !text(value.reviewEventId))
  )
    return false;
  return validAssociation(value.factoryTriage, value);
}

// Re-read a coherent platform snapshot. No Markdown selection takes place here.
export async function bodyContractFacts(
  connection: ConnectionWithLinkAdditions,
  number: number,
  mode: ContractMode,
  readyLabel = "state:ready",
) {
  const issue = await connection.issueTracker.issue(number);
  const comments = await connection.issueTracker.comments(number);
  const changes = await connection.issueTracker.labelChanges(number);
  const edits = await sourceEdits(connection, [
    issue.nodeId,
    ...observationComments(comments).map((c) => c.nodeId),
  ]);
  return {
    comments,
    changes,
    sourceFacts: {
      issue,
      mode,
      edits,
      observation: contractObservation(
        issue,
        comments,
        changes,
        edits,
        readyLabel,
      ),
    },
  };
}

export async function currentBodyDecision(
  connection: ConnectionWithLinkAdditions,
  configuration: PlatformConventions,
  number: number,
  mode: ContractMode,
  allowHeld = false,
) {
  if (mode.mode !== "body" || !same(await readContractMode(connection), mode))
    return null;
  const facts = await bodyContractFacts(
    connection,
    number,
    mode,
    configuration.labels.ready,
  );
  const posted = latestResult(facts.comments, configuration.contractResult);
  if (!posted) return null;
  let result: Result;
  try {
    result = JSON.parse(posted.line);
  } catch {
    return hold("The body-mode validator result is unreadable");
  }
  if (!result || result.format !== bodyResultFormat || !validBodyResult(result))
    return hold(
      "Body mode requires a supported well-formed v2 validator result; update/re-evaluate the compatible validator",
    );
  if (
    result.observation !== facts.sourceFacts.observation ||
    result.selection.cutoff?.id !== mode.cutoff ||
    (!allowHeld && result.selection.state === "held")
  )
    return null;
  return { result, comment: posted.comment, facts };
}

// Why the validator's latest result does not let the ready label count, or
// null when it does. A result older than any change to the issue waits for the
// validator's next result, since the validator evaluates every comment, edit
// and label event. The factory's own hold, run and action comments and its
// writes of the labels its configuration names, other than the ready label,
// are not changes the validator's decision on an open issue reads.
export function contractResultHold(
  facts: ContractFacts,
  configuration: Pick<FactoryConfiguration, "labels" | "contractResult">,
): ReadinessHold | null {
  const { labels, contractResult } = configuration;
  const { ready } = facts;
  const author = `@${contractResult.author}`;
  const refuse = (detail: string, action: string): ReadinessHold => ({
    reason: `is refused: ${detail}; ${action}`,
    waiting: false,
  });
  const reapply = `remove and re-apply ${labels.ready} once the issue-contract validator has evaluated the issue`;
  const unreadable = refuse(
    `the latest contract result from ${author} is unreadable`,
    reapply,
  );

  const posted = latestResult(facts.comments, contractResult);
  if (!posted)
    return refuse(
      `no contract result from ${author} was found on the issue`,
      reapply,
    );
  let result: Result;
  try {
    result = JSON.parse(posted.line);
  } catch {
    return unreadable;
  }
  if (typeof result !== "object" || result === null || Array.isArray(result))
    return unreadable;
  if (result.format !== resultFormat && result.format !== bodyResultFormat)
    return refuse(
      `the latest contract result from ${author} has ${typeof result.format === "string" ? `format ${result.format}` : "no format version"}, and this factory reads only ${resultFormat} and ${bodyResultFormat}`,
      "update the factory or the repository's issue-contract validator so they share a result format",
    );

  if (result.format === bodyResultFormat) {
    if (!validBodyResult(result)) return unreadable;
    const body = facts.body;
    if (
      !body ||
      body.mode.mode !== "body" ||
      result.selection.cutoff?.id !== body.mode.cutoff ||
      result.selection.state === "held"
    )
      return refuse(
        "the repository mode/cutoff and validator selection do not agree",
        "restore the recorded cutoff and re-evaluate with a compatible validator",
      );
    if (result.observation !== body.observation)
      return {
        reason:
          "waits: platform facts changed after the validator's v2 observation; automatic evaluation must refresh its decision",
        waiting: true,
      };
    if (
      result.status !== "approved" ||
      result.label !== labels.ready ||
      result.reviewEventId !== String(ready.id)
    )
      return refuse(
        "the validator does not approve the current readiness event",
        reapply,
      );
    const source = result.source;
    if (source?.type === "issue-body") {
      if (
        source.editedAt !== body.issue.bodyEditTime ||
        ("editId" in source &&
          source.editId !== body.edits[body.issue.nodeId!]?.id)
      )
        return refuse("the selected body edit identity changed", reapply);
      if (
        result.selection.state === "migrated" &&
        result.revision !==
          bodyRevision(body.issue, body.edits[body.issue.nodeId!]).revision
      )
        return refuse(
          "the selected body revision does not match its exact platform source",
          reapply,
        );
      return null;
    }
    if (source?.type === "comment" && result.selection.state === "eligible") {
      const brief = facts.comments.find((c) => String(c.id) === source.id);
      const legacy = body.mode.receipt.issues.find(
        (e) => e.issue === body.issue.nodeId,
      )?.legacy;
      if (
        brief &&
        legacy &&
        same(source, legacy.source) &&
        result.revision === legacy.revision &&
        same(body.edits[brief.nodeId!], legacy.edit) &&
        brief.updatedAt === source.editedAt &&
        legacy.revision === commentRevision(brief, result.kind)
      )
        return null;
    }
    return refuse(
      "the eligible exact legacy source cannot be verified",
      reapply,
    );
  }
  if (facts.body?.mode.mode === "body")
    return refuse(
      "body mode has a legacy v1 validator result",
      "re-evaluate with the compatible v2 validator; never resume legacy publication after cutoff",
    );

  if (facts.bodyEditTime === undefined || facts.latestDeletion === undefined)
    return refuse(
      "the platform reports no body edit or comment deletion times, so the validator's latest contract result cannot be shown current",
      "serve the repository from a platform that reports both",
    );
  const at = Date.parse(posted.comment.updatedAt);
  const newer = (time: string | null) => time !== null && Date.parse(time) > at;
  const factoryLabels = new Set(
    configured(labels, (role) => !role.readiness).map((label) =>
      label.toLowerCase(),
    ),
  );
  const stale =
    newer(facts.bodyEditTime) ||
    newer(facts.latestDeletion) ||
    facts.comments.some(
      (comment) =>
        comment.id !== posted.comment.id &&
        (String(comment.id) === (result.source as { id?: string })?.id ||
          !isFactoryComment(comment)) &&
        newer(comment.updatedAt),
    ) ||
    facts.labelChanges.some(
      (change) =>
        !factoryLabels.has(change.label.toLowerCase()) && newer(change.time),
    );
  const waits: ReadinessHold = {
    reason: `waits: the issue changed after the validator's latest contract result at ${posted.comment.updatedAt}; the validator's next result decides it`,
    waiting: true,
  };
  if (stale) return waits;

  if (
    result.status !== "approved" ||
    result.label !== labels.ready ||
    result.reviewEventId !== String(ready.id)
  )
    return refuse(
      `the validator's latest contract result${typeof result.status === "string" ? `, ${result.status},` : ""} does not approve the current ${labels.ready} event`,
      `review the current contract, then ${reapply}`,
    );

  // The contract source the result names must be as the validator read it.
  const source = result.source as {
    type?: unknown;
    id?: unknown;
    editedAt?: unknown;
  } | null;
  const unreadableSource = refuse(
    "the validator's latest contract result names no readable contract source",
    reapply,
  );
  const editedAt = source?.editedAt;
  if (typeof editedAt !== "string" && editedAt !== null)
    return unreadableSource;
  const sameTime = (time: string | null) =>
    time === null || editedAt === null
      ? time === editedAt
      : Date.parse(time) === Date.parse(editedAt);
  if (source?.type === "issue-body")
    return sameTime(facts.bodyEditTime) ? null : waits;
  if (source?.type === "comment" && typeof source.id === "string") {
    const comment = facts.comments.find(
      (comment) => String(comment.id) === source.id,
    );
    return comment && sameTime(comment.updatedAt) ? null : waits;
  }
  return unreadableSource;
}

// Whether the factory's triage run applied the ready label for the brief the
// validator approved: the label's latest event is by the configured triage
// result's author, and the validator's latest result names as its contract
// source a comment by that author with exactly one line naming its run.
// Approval and freshness stay `contractResultHold`'s.
export function triageBacked(
  facts: ContractFacts,
  configuration: PlatformConventions,
): boolean {
  // Without triage, readiness comes only from a person.
  if (!configuration.triageResult || !configuration.runKinds?.triage)
    return false;
  const { marker, author } = configuration.triageResult;
  const by = (login: string | undefined) =>
    login?.toLowerCase() === author.toLowerCase();
  if (!by(facts.ready.actor?.login)) return false;
  const posted = latestResult(facts.comments, configuration.contractResult);
  let source;
  let result;
  try {
    result = posted && JSON.parse(posted.line);
    source = result?.source;
  } catch {
    return false;
  }
  if (result?.format === bodyResultFormat) {
    if (
      !validBodyResult(result) ||
      contractResultHold(facts, configuration) !== null
    )
      return false;
    if (result.selection.state === "migrated") {
      const association = result.factoryTriage;
      const body = facts.body;
      if (
        !association ||
        !body ||
        body.mode.mode !== "body" ||
        !validBodySource(source)
      )
        return false;
      const evidence = facts.comments.find(
        (c) => String(c.id) === association.attestation.id,
      );
      const payload = evidence && readAttestation(evidence);
      return Boolean(
        evidence &&
        by(evidence.author?.login) &&
        payload &&
        payload.repository === body.mode.receipt?.repository &&
        payload.issue === body.issue.nodeId &&
        payload.run === association.run &&
        markedRun(evidence.body, marker) === association.run &&
        payload.revision === result.revision &&
        same(payload.source, source) &&
        same(payload.intake, association.intake) &&
        sameLogin(payload.intake.author, body.issue.author?.login) &&
        digest(evidence.body) === association.attestation.revision &&
        same(body.edits[evidence.nodeId!], association.attestation.edit) &&
        (association.intake.author.toLowerCase() !== author.toLowerCase() ||
          (association.intake.writerRun &&
            association.intake.writerRun !== association.run)),
      );
    }
    if (result.selection.state !== "eligible") return false;
  } else if (result?.format !== resultFormat) return false;
  if (source?.type !== "comment" || typeof source.id !== "string") return false;
  const brief = facts.comments.find(
    (comment) => String(comment.id) === source.id,
  );
  if (!brief || !by(brief.author?.login)) return false;
  const prefix = `<!-- ${marker} `;
  const runs = brief.body
    .split(/\r\n?|\n/)
    .filter((line) => line.startsWith(prefix) && line.endsWith(" -->"));
  if (runs.length !== 1) return false;
  try {
    const { run } = JSON.parse(runs[0].slice(prefix.length, -4)) ?? {};
    return typeof run === "string" && run.trim() !== "";
  } catch {
    return false;
  }
}

// The latest comment by the configured author carrying the configured marker's
// state line, with that line's JSON text. Platform logins ignore case.
function latestResult(
  comments: Comment[],
  { marker, author }: FactoryConfiguration["contractResult"],
): { comment: Comment; line: string } | null {
  const prefix = `<!-- ${marker} `;
  const suffix = " -->";
  let latest: { comment: Comment; line: string } | null = null;
  for (const comment of comments) {
    if (comment.author?.login.toLowerCase() !== author.toLowerCase()) continue;
    const lines = comment.body
      .split(/\r\n?|\n/)
      .filter((line) => line.startsWith(prefix) && line.endsWith(suffix));
    if (lines.length && (latest === null || comment.id > latest.comment.id))
      latest = {
        comment,
        line:
          lines.length === 1
            ? lines[0].slice(prefix.length, -suffix.length)
            : "ambiguous result lines",
      };
  }
  return latest;
}
