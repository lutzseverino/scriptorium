// The host's recoverable contract publication, called only by platform.postResult.
// Checkpoints are saved before mutations. Reports never enter this state.
import type { ConnectionWithLinkAdditions, Issue } from "@lutzseverino/postern";
import type { PlatformConventions } from "./factory-configuration.ts";
import { postResultComment, type ResultPost } from "./run-result.ts";
import {
  attestationFormat,
  bodyRevision,
  contractFile,
  commentDeletionIdentity,
  digest,
  hold,
  ledgerBranch,
  readAttestation,
  readContractMode,
  request,
  same,
  sameLogin,
  sourceEdits,
  verifyBodyWrite,
  type Attestation,
  type Edit,
  type Intake,
  type SourceRecord,
  type WriterProof,
} from "./contract-protocol.ts";
import {
  currentBodyDecision,
  preparedContractNotice,
  requirePreparedProtocol,
} from "./contract-result.ts";

export type Publication = {
  mode: "prepared" | "body";
  cutoff?: string;
  original?: { body: string; edit: Edit; issue: string; createdAt: string };
  body?: string;
  published?: { revision: string; source: Attestation["source"] };
  evidence?: {
    id: number;
    nodeId: string;
    body: string;
    edit: Edit;
    url: string;
  };
  evidenceIntent?: { body: string; after: number; deletion: string | null };
  readyRequested?: true;
};
export type PublicationProgress = {
  state?: Publication;
  // Only independently authenticated issue-filing provenance may supply this.
  writerProof?: WriterProof;
  now?(): Date;
  save(state: Publication): void;
};

export async function publishContract(
  connection: ConnectionWithLinkAdditions,
  configuration: PlatformConventions,
  number: number,
  post: ResultPost,
  progress: PublicationProgress,
): Promise<string | null | undefined> {
  if (!post.triage) return undefined;
  const mode = await readContractMode(connection);
  let state = progress.state;
  if (
    state &&
    (state.mode !== mode.mode ||
      (mode.mode === "body" && state.cutoff !== mode.cutoff))
  )
    return hold(
      "Publication mode changed while this triage result was in flight; keep publication frozen and re-triage in the current mode",
    );
  const save = () => {
    progress.state = state;
    progress.save(state!);
  };
  if (!state) {
    state = {
      mode: mode.mode,
      ...(mode.mode === "body" && { cutoff: mode.cutoff }),
    };
    save();
  }
  if (mode.mode === "prepared") {
    const tracker = connection.issueTracker;
    requirePreparedProtocol(await tracker.comments(number), configuration);
    const ready = configuration.labels.ready;
    const ordinary = post.add.filter((label) => label !== ready);
    if (ordinary.length) await tracker.addLabels(number, ordinary);
    await evidenceComment(
      connection,
      number,
      state,
      save,
      post.comment,
      post.marker,
      post.triage.author,
      configuration.contractResult.author,
    );
    if (!same(await readContractMode(connection), mode))
      return hold(
        "Cutoff changed before legacy readiness; hold and re-triage in body mode",
      );
    const comments = await tracker.comments(number);
    const evidence = comments.find((c) => c.id === state!.evidence!.id);
    if (
      !evidence ||
      evidence.body !== state.evidence!.body ||
      !sameLogin(evidence.author?.login, post.triage.author) ||
      !same(
        (await sourceEdits(connection, [evidence.nodeId]))[evidence.nodeId!],
        state.evidence!.edit,
      )
    )
      return hold("Legacy evidence was deleted or edited before readiness");
    const notice = preparedContractNotice(comments, configuration, evidence);
    if (!notice) return null;
    if (!state.readyRequested) {
      const issue = await tracker.issue(number);
      if (issue.labels.includes(ready)) {
        const applied = (await tracker.labelChanges(number)).findLast(
          (c) => c.label === ready,
        );
        if (
          !applied ||
          applied.action !== "added" ||
          !sameLogin(applied.actor?.login, post.triage.author) ||
          Date.parse(applied.time) <=
            Math.max(
              Date.parse(notice.result.publishedAt as string),
              Date.parse(evidence.createdAt),
            )
        )
          return hold(
            "Readiness predates the matching prepared notice or belongs to another reviewer",
          );
      } else {
        if (
          Math.floor((progress.now?.() ?? new Date()).getTime() / 1000) *
            1000 <=
          Date.parse(notice.result.publishedAt as string)
        )
          return null;
        if (post.add.includes(ready)) await tracker.addLabels(number, [ready]);
      }
      state.readyRequested = true;
      save();
    }
    for (const label of post.remove)
      if ((await tracker.issue(number)).labels.includes(label))
        await tracker.removeLabel(number, label);
    return state.evidence!.url;
  }
  const triage = configuration.triageResult;
  if (!triage || !configuration.runKinds?.triage)
    return hold(
      "Body publication requires configured triage author and run kind",
    );
  const tracker = connection.issueTracker;
  const base = `/repos/${connection.repository.path}`;
  const file = await contractFile<SourceRecord>(
    connection,
    `issues/${number}.json`,
    ledgerBranch,
  );
  let record = file?.value;
  let recordSha = file?.sha;
  let issue = await tracker.issue(number);
  const editOf = async (current: Issue) =>
    (await sourceEdits(connection, [current.nodeId]))[current.nodeId!];
  let edit = await editOf(issue);
  if (!issue.nodeId || !issue.author)
    return hold("Issue intake identity or original author is unavailable");
  if (
    record &&
    (record.issue !== issue.nodeId || record.cutoff !== mode.cutoff)
  )
    return hold("Durable source record conflicts with this issue/cutoff");
  if (!record && mode.receipt.issues.some((entry) => entry.number === number))
    return hold(
      "Inventoried original/source history is missing; recover the authenticated ledger history",
    );
  const persist = async (next: SourceRecord) => {
    const response = (await request(connection, {
      method: "PUT",
      path: `${base}/contents/issues/${number}.json`,
      body: {
        message: `chore: record issue contract facts for issues/${number}.json`,
        branch: ledgerBranch,
        content: Buffer.from(`${JSON.stringify(next, null, 2)}\n`).toString(
          "base64",
        ),
        ...(recordSha && { sha: recordSha }),
      },
    })) as { content?: { sha?: string } };
    if (!response?.content?.sha)
      return hold(
        "Contract ledger write did not return its compare-and-swap identity",
      );
    record = next;
    recordSha = response.content.sha;
  };
  if (!record?.intake) {
    // A possible previous Brief is not authenticated original intake. This is
    // conservative containment, not a competing Markdown contract selector.
    if (hasSection(issue.body, "agent brief"))
      return hold(
        "Original request is unavailable or ambiguous; recover authenticated intake",
      );
    const intake: Intake = {
      original: issue.body,
      author: issue.author.login,
      writerRun: null,
      writerProof: null,
      sourceEdit: edit,
    };
    await persist({
      ...record,
      issue: issue.nodeId,
      cutoff: mode.cutoff,
      migrated: record?.migrated ?? false,
      retired: record?.retired ?? false,
      intake,
    });
  }
  let intake = record!.intake!;
  if (progress.writerProof) {
    const proof = progress.writerProof;
    if (
      !sameLogin(intake.author, triage.author) ||
      proof.repository !== connection.repository.path ||
      proof.issue !== issue.nodeId ||
      !same(proof.sourceEdit, intake.sourceEdit) ||
      !proof.run.trim() ||
      (intake.writerRun && intake.writerRun !== proof.run)
    )
      return hold(
        "Authenticated intake writer proof conflicts with preserved intake",
      );
    if (!intake.writerRun) {
      intake = { ...intake, writerRun: proof.run, writerProof: proof };
      await persist({ ...record!, intake });
    }
  }
  if (
    sameLogin(intake.author, triage.author) &&
    (!intake.writerRun ||
      intake.writerRun === post.triage.run ||
      !intake.writerProof ||
      intake.writerProof.run !== intake.writerRun ||
      intake.writerProof.issue !== issue.nodeId ||
      intake.writerProof.repository !== connection.repository.path ||
      !same(intake.writerProof.sourceEdit, intake.sourceEdit))
  )
    return hold(
      "Factory-authored intake has the same or unknown writer run; obtain independent person review or recover authenticated writer provenance",
    );
  if (typeof intake.original !== "string" || typeof intake.author !== "string")
    return hold("Preserved original intake is unreadable");
  if (
    !state.published &&
    !(await currentBodyDecision(connection, configuration, number, mode, true))
  ) {
    await request(connection, {
      method: "POST",
      path: `${base}/dispatches`,
      body: {
        event_type: "repo-canon-issue-contract",
        client_payload: { issue: number },
      },
    });
    return null;
  }
  if (!state.original) {
    if (hasSection(post.triage.brief, "original request"))
      return hold(
        "The model result includes Original request; re-triage with intake supplied only by the host",
      );
    state.original = {
      body: issue.body,
      issue: issue.nodeId,
      edit,
      createdAt: issue.createdAt,
    };
    state.body = `${post.triage.brief.trimEnd()}\n\n## Original request\n\n${intake.original}`;
    if (state.body.length > 65_536)
      return hold(
        "Body brief with preserved original exceeds the platform body limit",
      );
    save();
  }
  if (!state.published) {
    const ordinary = post.add.filter(
      (label) =>
        label !== configuration.labels.ready && !issue.labels.includes(label),
    );
    if (ordinary.length) await tracker.addLabels(number, ordinary);
    if (issue.body === state.body && !same(edit, state.original.edit)) {
      await verifyBodyWrite(
        connection,
        issue,
        edit,
        state.original,
        state.body!,
        triage.author,
      );
      state.published = bodyRevision(issue, edit);
      save();
    } else if (
      issue.body !== state.original.body ||
      !same(edit, state.original.edit)
    )
      return hold(
        "Issue changed before body publication; preserve the concurrent edit",
      );
  }
  if (!state.published) {
    // Refetch mode and source immediately before replacing intake. GitHub has
    // no body compare-and-swap; the serialized publisher must retain the freeze.
    if (!same(await readContractMode(connection), mode))
      return hold("Contract mode changed before body write");
    issue = await tracker.issue(number);
    edit = await editOf(issue);
    if (issue.body !== state.original.body || !same(edit, state.original.edit))
      return hold("Issue changed at the body publication boundary");
    await request(connection, {
      method: "PATCH",
      path: `${base}/issues/${number}`,
      body: { body: state.body },
    });
    issue = await tracker.issue(number);
    edit = await editOf(issue);
    if (issue.body !== state.body)
      return hold("Published body was concurrently changed");
    await verifyBodyWrite(
      connection,
      issue,
      edit,
      state.original,
      state.body!,
      triage.author,
    );
    state.published = bodyRevision(issue, edit);
    save();
  }
  if (
    issue.body !== state.body ||
    !same(bodyRevision(issue, edit), state.published)
  )
    return hold(
      "Body revision changed during publication; the old acceptance cannot be replayed",
    );
  const decide = () =>
    currentBodyDecision(connection, configuration, number, mode);
  const unchanged = async () => {
    const current = await tracker.issue(number);
    if (
      current.body !== state!.body ||
      !same(bodyRevision(current, await editOf(current)), state!.published)
    )
      return hold("Body changed at a publication recovery boundary");
  };
  // The first validator notice must identify the actual published body before
  // evidence is minted. Waiting returns to the same host result-first path.
  const noticed = await decide();
  if (
    !noticed ||
    noticed.result.revision !== state.published.revision ||
    !same(noticed.result.source, state.published.source)
  )
    return null;
  if (!state.evidence) {
    await unchanged();
    const payload: Attestation = {
      format: attestationFormat,
      repository: connection.repository.path,
      issue: state.original.issue,
      run: post.triage.run,
      outcome: "success",
      ...state.published,
      intake: { author: intake.author, writerRun: intake.writerRun },
    };
    const evidenceBody = `${post.triage.disclaimer}\n\nTriage evidence for the exact body revision.\n<!-- ${triage.marker} ${JSON.stringify({ run: post.triage.run })} -->\n<!-- repo-canon:triage-attestation ${JSON.stringify(payload)} -->`;
    await evidenceComment(
      connection,
      number,
      state,
      save,
      evidenceBody,
      `<!-- ${triage.marker} ${JSON.stringify({ run: post.triage.run })} -->`,
      triage.author,
      configuration.contractResult.author,
    );
  }
  const evidence = (await tracker.comments(number)).find(
    (c) => c.id === state.evidence!.id,
  );
  if (
    !evidence ||
    evidence.body !== state.evidence!.body ||
    !sameLogin(evidence.author?.login, triage.author) ||
    !same(
      (await sourceEdits(connection, [evidence.nodeId]))[evidence.nodeId!],
      state.evidence!.edit,
    )
  )
    return hold(
      "Exact body attestation is missing or edited; recover fresh applicable proof/acceptance",
    );
  const publication = {
    payload: readAttestation(evidence)!,
    attestation: {
      id: String(evidence.id),
      revision: digest(evidence.body),
      edit: state.evidence!.edit,
    },
  };
  await unchanged();
  if (
    record!.publication &&
    record!.publication.attestation.id === publication.attestation.id &&
    (!same(record!.publication.payload, publication.payload) ||
      !same(record!.publication.attestation, publication.attestation))
  )
    return hold(
      "Stored body publication evidence conflicts with its immutable identity",
    );
  if (
    !same(record!.publication?.payload, publication.payload) ||
    !same(record!.publication?.attestation, publication.attestation)
  )
    await persist({ ...record!, migrated: true, retired: true, publication });
  // Dispatch on retries too: persistence may have succeeded after the evidence
  // comment's workflow already ran. No polling delay or synthetic approval.
  await request(connection, {
    method: "POST",
    path: `${base}/dispatches`,
    body: {
      event_type: "repo-canon-issue-contract",
      client_payload: { issue: number },
    },
  });
  const proofNotice = await decide();
  const association = proofNotice?.result.factoryTriage;
  if (
    !proofNotice ||
    !["awaiting-review", "approved"].includes(proofNotice.result.status) ||
    !same(association, {
      run: post.triage.run,
      ...state.published,
      attestation: publication.attestation,
      intake: publication.payload.intake,
    })
  )
    return null;
  const durable = await contractFile<SourceRecord>(
    connection,
    `issues/${number}.json`,
    ledgerBranch,
  );
  const proofNoticedAt = durable?.value.publication?.noticedAt;
  if (!proofNoticedAt || !Number.isFinite(Date.parse(proofNoticedAt)))
    return null;
  const ready = configuration.labels.ready;
  const changes = await tracker.labelChanges(number);
  const applied = changes.findLast((c) => c.label === ready);
  issue = await tracker.issue(number);
  if (!state.readyRequested) {
    // An interrupted readiness write can be recovered only from our actor's
    // event after the matching proof notice. Never duplicate a carried event.
    if (issue.labels.includes(ready)) {
      if (
        !applied ||
        applied.action !== "added" ||
        !sameLogin(applied.actor?.login, triage.author) ||
        Date.parse(applied.time) <=
          Math.max(
            Date.parse(proofNoticedAt),
            Date.parse(proofNotice.result.publishedAt!),
          )
      )
        return hold(
          "Readiness predates the matching body/proof notice or belongs to another reviewer",
        );
    } else {
      // Canon rejects same-second notice/acceptance. A later host pass retries.
      if (
        Math.floor((progress.now?.() ?? new Date()).getTime() / 1000) * 1000 <=
        Math.max(
          Date.parse(proofNoticedAt),
          Date.parse(proofNotice.result.publishedAt!),
        )
      )
        return null;
      await unchanged();
      const ordinary = post.add.filter((label) => label !== ready);
      if (ordinary.length) await tracker.addLabels(number, ordinary);
      await tracker.addLabels(number, [ready]);
    }
    state.readyRequested = true;
    save();
  }
  const approved = await decide();
  if (
    !approved ||
    approved.result.status !== "approved" ||
    approved.result.label !== ready ||
    approved.result.reviewEventId !==
      String(
        applied?.id ??
          (await tracker.labelChanges(number)).findLast(
            (c) => c.label === ready,
          )?.id,
      ) ||
    approved.result.factoryTriage?.run !== post.triage.run
  )
    return null;
  for (const label of post.remove) {
    if ((await tracker.issue(number)).labels.includes(label))
      await tracker.removeLabel(number, label);
  }
  return state.evidence!.url;
}

// This is only a duplicate-preservation guard, not contract selection or
// structure validation. Prose may discuss these names freely. Ambiguous
// existing section syntax holds for authenticated intake recovery; Canon
// remains the sole interpreter of the completed brief.
function hasSection(markdown: string, name: string): boolean {
  const normalized = markdown.replace(/[*_`]/g, "").replace(/\r\n?/g, "\n");
  return normalized.split("\n").some((line, index, lines) => {
    const heading = line
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/\s+#+\s*$/, "")
      .trim()
      .toLowerCase();
    return (
      (heading === name &&
        (/^\s{0,3}#{1,6}\s+/.test(line) ||
          /^\s*(?:=+|-+)\s*$/.test(lines[index + 1] ?? ""))) ||
      new RegExp(
        `^\\s*<h[1-6](?:\\s[^>]*)?>\\s*${name}\\s*</h[1-6]>\\s*$`,
        "i",
      ).test(line)
    );
  });
}

// The same immutable evidence path serves legacy briefs and body attestations.
// Save the complete publication intent and discussion/deletion frontier before
// posting, so a lost response can recover one unchanged record by identity.
async function evidenceComment(
  connection: ConnectionWithLinkAdditions,
  number: number,
  state: Publication,
  save: () => void,
  body: string,
  marker: string,
  author: string,
  validatorAuthor: string,
): Promise<void> {
  const tracker = connection.issueTracker;
  let comments = await tracker.comments(number);
  if (!state.evidenceIntent) {
    const existing = comments.filter((c) => c.body.includes(marker));
    state.evidenceIntent = {
      body,
      after: existing.length
        ? Math.min(...existing.map((c) => c.id)) - 1
        : Math.max(
            0,
            ...comments
              .filter((c) =>
                author
                  ? sameLogin(c.author?.login, author)
                  : !sameLogin(c.author?.login, validatorAuthor),
              )
              .map((c) => c.id),
          ),
      deletion: await commentDeletionIdentity(connection, number),
    };
    save();
  }
  if (
    state.evidenceIntent.body !== body ||
    (!state.evidence &&
      state.evidenceIntent.deletion !==
        (await commentDeletionIdentity(connection, number)))
  )
    return hold(
      "Evidence publication intent or deletion history changed; do not reconstruct missing evidence",
    );
  if (!state.evidence) {
    let candidates = comments.filter(
      (c) =>
        c.id > state.evidenceIntent!.after &&
        (author
          ? sameLogin(c.author?.login, author)
          : !sameLogin(c.author?.login, validatorAuthor)),
    );
    if (candidates.length > 1 || candidates.some((c) => c.body !== body))
      return hold(
        "Evidence publication has conflicting or edited records after its saved frontier",
      );
    if (!candidates.length) {
      await postResultComment(tracker, number, { comment: body, marker });
      comments = await tracker.comments(number);
      candidates = comments.filter(
        (c) =>
          c.id > state.evidenceIntent!.after &&
          c.body === body &&
          (author
            ? sameLogin(c.author?.login, author)
            : !sameLogin(c.author?.login, validatorAuthor)),
      );
    }
    if (candidates.length !== 1)
      return hold(
        "Evidence publication has no unique configured-author identity",
      );
    const evidence = candidates[0];
    const edit = (await sourceEdits(connection, [evidence.nodeId]))[
      evidence.nodeId!
    ];
    if (edit.id !== `created:${evidence.nodeId}`)
      return hold(
        "Existing evidence was edited before its exact publication checkpoint",
      );
    state.evidence = {
      id: evidence.id,
      nodeId: evidence.nodeId!,
      body: evidence.body,
      edit,
      url: evidence.url,
    };
    save();
  }
  const evidence = comments.find((c) => c.id === state.evidence!.id);
  if (
    !evidence ||
    evidence.body !== state.evidence!.body ||
    (author && !sameLogin(evidence.author?.login, author)) ||
    !same(
      (await sourceEdits(connection, [evidence.nodeId]))[evidence.nodeId!],
      state.evidence!.edit,
    )
  )
    return hold(
      "Legacy evidence was deleted or edited; never reconstruct it from a report",
    );
}
