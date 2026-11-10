// The host's recoverable contract publication, called only by platform.postResult.
// Checkpoints are saved before mutations. Reports never enter this state.
import type { ConnectionWithLinkAdditions, Issue } from "@lutzseverino/postern";
import type { PlatformConventions } from "./factory-configuration.ts";
import { postResultComment, type ResultPost } from "./run-result.ts";
import {
  attestationFormat,
  bodyRevision,
  contractFile,
  digest,
  hold,
  ledgerBranch,
  markedRun,
  readAttestation,
  readContractMode,
  request,
  same,
  sourceEdits,
  type Attestation,
  type Edit,
  type Intake,
  type SourceRecord,
  type WriterProof,
} from "./contract-protocol.ts";
import { currentBodyDecision } from "./contract-result.ts";

export type Publication = {
  mode: "prepared" | "body";
  cutoff?: string;
  original?: { body: string; edit: Edit; issue: string };
  body?: string;
  published?: { revision: string; source: Attestation["source"] };
  evidence?: {
    id: number;
    nodeId: string;
    body: string;
    edit: Edit;
    url: string;
  };
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
    if (!state.evidence) {
      await postResultComment(tracker, number, post);
      const candidates = (await tracker.comments(number)).filter(
        (c) =>
          c.body === post.comment &&
          (!post.triage!.author || c.author?.login === post.triage!.author),
      );
      if (candidates.length !== 1)
        return hold(
          "Legacy publication has no unique immutable evidence identity",
        );
      const evidence = candidates[0];
      const edit = (await sourceEdits(connection, [evidence.nodeId]))[
        evidence.nodeId!
      ];
      if (edit.id !== `created:${evidence.nodeId}`)
        return hold(
          "Legacy publication evidence was edited before its identity was recorded",
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
    const evidence = (await tracker.comments(number)).find(
      (c) => c.id === state.evidence!.id,
    );
    if (
      !evidence ||
      evidence.body !== state.evidence.body ||
      (post.triage.author && evidence.author?.login !== post.triage.author) ||
      !same(
        (await sourceEdits(connection, [evidence.nodeId]))[evidence.nodeId!],
        state.evidence.edit,
      )
    )
      return hold(
        "Legacy evidence was deleted or edited; never reconstruct it from a report",
      );
    if (!same(await readContractMode(connection), mode))
      return hold(
        "Cutoff changed before legacy readiness; hold and re-triage in body mode",
      );
    if (post.add.length) await tracker.addLabels(number, post.add);
    for (const label of post.remove)
      if ((await tracker.issue(number)).labels.includes(label))
        await tracker.removeLabel(number, label);
    return state.evidence.url;
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
    if (/agent\s+brief|original\s+request/i.test(issue.body))
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
      intake.author !== triage.author ||
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
    intake.author === triage.author &&
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
    if (/original\s+request/i.test(post.triage.brief))
      return hold(
        "The model result includes Original request; re-triage with intake supplied only by the host",
      );
    state.original = { body: issue.body, issue: issue.nodeId, edit };
    state.body = `${post.triage.brief.trimEnd()}\n\n## Original request\n\n${intake.original}`;
    if (state.body.length > 65_536)
      return hold(
        "Body brief with preserved original exceeds the platform body limit",
      );
    save();
  }
  if (!state.published) {
    if (issue.body !== state.original.body || !same(edit, state.original.edit))
      return hold(
        "Issue changed before body publication; preserve the concurrent edit",
      );
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
    const candidates = (await tracker.comments(number)).filter(
      (c) =>
        markedRun(c.body, triage.marker) === post.triage!.run &&
        readAttestation(c),
    );
    if (
      candidates.length > 1 ||
      candidates.some(
        (c) => c.body !== evidenceBody || c.author?.login !== triage.author,
      )
    )
      return hold("Conflicting or edited body attestation exists for this run");
    const existing =
      candidates[0] ?? (await tracker.createComment(number, evidenceBody));
    const evidenceEdit = (await sourceEdits(connection, [existing.nodeId]))[
      existing.nodeId!
    ];
    if (evidenceEdit.id !== `created:${existing.nodeId}`)
      return hold(
        "Existing publication evidence was edited; do not adopt it by marker",
      );
    state.evidence = {
      id: existing.id,
      nodeId: existing.nodeId!,
      body: existing.body,
      edit: evidenceEdit,
      url: existing.url,
    };
    save();
  }
  const evidence = (await tracker.comments(number)).find(
    (c) => c.id === state.evidence!.id,
  );
  if (
    !evidence ||
    evidence.body !== state.evidence.body ||
    evidence.author?.login !== triage.author ||
    !same(
      (await sourceEdits(connection, [evidence.nodeId]))[evidence.nodeId!],
      state.evidence.edit,
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
      edit: state.evidence.edit,
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
        applied.actor?.login !== triage.author ||
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
  return state.evidence.url;
}
