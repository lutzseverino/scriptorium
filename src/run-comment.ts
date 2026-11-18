// The factory's issue comments other than its holds, through one writer. A
// run comment covers one pass through the pipeline, from its first launch to
// merge or failure, and is edited in place: its marker line holds each
// phase's facts, so each write merges into what the issue was already told,
// including after a host restart. A write after a final one starts the next
// pass's comment, unless it is final too and so retries that pass's write. An
// action comment tells a person to act, once per occasion, and links the run
// comment. A released stop's continuation lives in the run comment until the
// next write, so the work resumes on the same PRs. A parent's close comment
// is posted fresh.
import type { Comment, IssueTracker } from "@lutzseverino/postern";
import { lastCommentLine, renderComment } from "./comment-template.ts";
import type { PlatformConventions } from "./factory-configuration.ts";
import { standInReason, type IssueId, type StandIn } from "./factory.ts";
import { isHoldComment, upsert } from "./hold-comments.ts";
import { roleNames, type Labels, type RoleName } from "./label-roles.ts";
import type { InputResume } from "./platform.ts";
import {
  parseTerminalResult,
  type RunResult,
  type TerminalResult,
} from "./run-result.ts";
import { reference } from "./readiness.ts";
import { contractEvidenceIds } from "./contract-protocol.ts";

const phases = ["triage", "implement", "review", "merge"] as const;
export type Phase = (typeof phases)[number];

// Each phase state: the pass's status while its latest write leaves a phase
// in it, and whether a later phase's start finishes it.
const states = {
  running: { status: "in progress", unfinished: true },
  done: { status: "in progress" },
  paused: { status: "paused", unfinished: true },
  stopped: { status: "waiting for an answer", unfinished: true },
  carried: { status: "carried", unfinished: true },
  "awaiting merge": { status: "awaiting merge" },
  merged: { status: "merged" },
  failed: { status: "failed" },
};

export type PhaseFacts = {
  state?: keyof typeof states;
  reason?: string;
  reset?: string | null;
  provider?: string;
  model?: string;
  effort?: string;
  standIn?: StandIn;
  attempt?: number;
  round?: number;
  link?: string;
  unpushable?: string[];
};

function standInText(facts: PhaseFacts): string | undefined {
  if (!facts.standIn) return undefined;
  const { chosen, reason } = facts.standIn;
  return `chosen \`${chosen}\`; ran \`${facts.provider}/${facts.model}\` as a stand-in: ${standInReason(reason)}`;
}

// One write: facts merged into one phase's, whose run facts and link stay
// until replaced or cleared by an undefined fact, while its reason, reset and
// unpushable paths describe only its new state; a run result just posted,
// whose body the comment shows; whether the pass ends; and a released stop's
// continuation.
export type RunUpdate = {
  phase: Phase;
  facts: PhaseFacts;
  result?: Pick<RunResult, "body"> & {
    terminal?: TerminalResult;
    withdrawn?: string;
  };
  final?: true;
  resume?: InputResume;
};

// An occasion a person must act on: its key, unique within its pass, the
// label that names it, for a stop the labels of its asked and answering
// roles under their role names and the work readiness resumes, and for a
// failure why and which paths a person with permission must push.
export type Action = {
  key: string;
  failed?: string;
  stopped?: string;
  gate?: string;
  reason?: string;
  unpushable?: string;
  resume?: "implement" | "review";
} & Partial<Record<RoleName, string>>;

// A stop's action, which names the role it asks and each label that answers
// it. A person answers by applying the issue's next state or closing it:
// readiness resumes the stopped implement or review work, and the triage
// state answers only where a triage run picks it up.
export function stopAction(
  key: string,
  stopped: string,
  labels: Labels,
  { triage, resume }: { triage: boolean; resume?: "implement" | "review" },
): Action {
  return {
    key,
    stopped,
    ...Object.fromEntries(
      roleNames((role) => role.asks).flatMap((name) =>
        labels[name] === stopped ? [[name, stopped]] : [],
      ),
    ),
    ...Object.fromEntries(
      roleNames((role) => role.answers).flatMap((name) => {
        const label = labels[name];
        return label !== undefined && (name !== "triage" || triage)
          ? [[name, label]]
          : [];
      }),
    ),
    ...(resume && { resume }),
  };
}

type State = {
  phases: Partial<Record<Phase, PhaseFacts>>;
  results?: TerminalResult[];
  withdrawnResults?: string[];
  final?: true;
  resume?: InputResume;
};

const runMarker = /^<!-- scriptorium:run (\{.*\}) -->$/;
const actionMarker = /^<!-- scriptorium:action \{.*\} -->$/;
// Run result bodies are contained, so no body closes these.
const bodyStart = "<!-- scriptorium:run-body -->\n";
const bodyEnd = "\n<!-- /scriptorium:run-body -->";
const lastLine = (comment: Comment) => lastCommentLine(comment.body);
// JSON whose text cannot close the HTML comment holding it.
const encode = (value: unknown) =>
  JSON.stringify(value).replace(/[<>]/g, (character) =>
    character === "<" ? "\\u003c" : "\\u003e",
  );

// The run comment's owned state, independent of transport author selection.
function readState(body: string): State | null {
  if (body.includes("<!-- repo-canon:triage-attestation ")) return null;
  const match = runMarker.exec(lastCommentLine(body));
  if (!match) return null;
  try {
    const state = JSON.parse(match[1]);
    return typeof state?.phases === "object" &&
      state.phases !== null &&
      !Object.hasOwn(state, "run") &&
      !Object.hasOwn(state, "outcome")
      ? state
      : null;
  } catch {
    return null;
  }
}

function runState(comment: Comment): State | null {
  return comment.author?.bot ? readState(comment.body) : null;
}

// Internal access for the supported reader: it validates the retained facts
// after selecting the caller's trusted author, independently of bot marking.
export function runCommentResults(
  body: string,
): { results: TerminalResult[]; withdrawn: string[] } | undefined {
  const state = readState(body);
  if (!state) return undefined;
  const { results = [], withdrawnResults = [] } = state;
  if (
    !Array.isArray(results) ||
    !Array.isArray(withdrawnResults) ||
    withdrawnResults.some((run) => typeof run !== "string" || run.trim() === "")
  )
    throw new Error("Invalid published terminal result data");
  return {
    results: results.map(parseTerminalResult),
    withdrawn: withdrawnResults,
  };
}

// The mutable report role, without exposing its encoded state to the platform.
export function isRunComment(comment: Comment): boolean {
  return runState(comment) !== null;
}

// The latest run comment of the issue's comments, with its state.
function latestPass(comments: Comment[]) {
  return comments
    .flatMap((comment) => {
      const state = runState(comment);
      return state ? [{ comment, state }] : [];
    })
    .sort((left, right) => left.comment.id - right.comment.id)
    .at(-1);
}

// The continuation of a stop the issue's unfinished pass released.
export function passContinuation(
  comments: Comment[],
  configuration?: Pick<PlatformConventions, "contractResult">,
  retainedEvidence?: Set<string>,
): InputResume | undefined {
  const evidence =
    retainedEvidence ??
    (configuration &&
      contractEvidenceIds(comments, configuration.contractResult));
  const pass = latestPass(
    evidence ? comments.filter((c) => !evidence.has(String(c.id))) : comments,
  );
  return pass?.state.final ? undefined : pass?.state.resume;
}

// Whether the comment is one of the factory's hold, run or action comments,
// none of which the issue-contract validator's decision reads.
export function isFactoryComment(comment: Comment): boolean {
  return (
    isHoldComment(comment.body) ||
    isRunComment(comment) ||
    (comment.author?.bot === true && actionMarker.test(lastLine(comment)))
  );
}

// The one writer of an issue's run, action and close comments, worded by the
// repository's comment templates.
export function issueComments(
  tracker: IssueTracker,
  configuration: PlatformConventions,
  evidenceIds?: (issue: number, comments: Comment[]) => Promise<Set<string>>,
) {
  const templates = configuration.comments;
  // Quota pauses can write the current run notice without another platform
  // read. These facts came from this writer's last successful observation.
  const remembered = new Map<
    number,
    { comments: Comment[]; evidence: Set<string> }
  >();
  // Implement and merge always show, review once it is on, and triage once
  // it ran in the pass.
  function render(state: State, phase: Phase, result: string | undefined) {
    const shown = phases.filter(
      (name) =>
        state.phases[name] ||
        name === "implement" ||
        name === "merge" ||
        (name === "review" && configuration.runKinds?.review),
    );
    return renderComment("run", templates?.run, {
      status: states[state.phases[phase]?.state ?? "running"].status,
      ...Object.fromEntries(
        shown.map((name) => {
          const facts = state.phases[name];
          const done = facts?.state === "done" || facts?.state === "merged";
          return [
            name,
            {
              ...facts,
              standIn: facts && standInText(facts),
              check: done ? "x" : " ",
            },
          ];
        }),
      ),
      result: result && `${bodyStart}${result}${bodyEnd}`,
    });
  }

  return {
    async write(
      issue: number,
      update: RunUpdate,
      action?: Action,
      options?: { cached: true },
    ): Promise<void> {
      const cached = options?.cached ? remembered.get(issue) : undefined;
      if (options?.cached && !cached)
        throw new Error("the run comment has no cached observation");
      const comments = cached?.comments ?? (await tracker.comments(issue));
      const evidence =
        cached?.evidence ??
        (evidenceIds
          ? await evidenceIds(issue, comments)
          : contractEvidenceIds(comments, configuration.contractResult));
      const latest = latestPass(
        comments.filter((comment) => !evidence.has(String(comment.id))),
      );
      const pass =
        latest && (!latest.state.final || update.final) ? latest : undefined;
      const results = [...(pass?.state.results ?? [])];
      const withdrawn = new Set(pass?.state.withdrawnResults ?? []);
      if (update.result?.withdrawn) withdrawn.add(update.result.withdrawn);
      const terminal = update.result?.terminal;
      if (terminal && !results.some((entry) => entry.run === terminal.run))
        results.push(terminal);
      const state: State = {
        phases: {
          ...pass?.state.phases,
          [update.phase]: {
            ...pass?.state.phases[update.phase],
            reason: undefined,
            reset: undefined,
            unpushable: undefined,
            ...update.facts,
          },
        },
        ...(results.length && {
          results: results.filter((entry) => !withdrawn.has(entry.run)),
        }),
        ...(withdrawn.size && { withdrawnResults: [...withdrawn] }),
        ...(update.final && { final: true }),
        ...(update.resume && { resume: update.resume }),
      };
      // A phase that starts, or a merge, finishes the earlier phases.
      if (update.facts.state === "running" || update.facts.state === "merged")
        for (const name of phases.slice(0, phases.indexOf(update.phase))) {
          const facts = state.phases[name];
          if (facts?.state && "unfinished" in states[facts.state])
            state.phases[name] = {
              ...facts,
              state: "done",
              reason: undefined,
              reset: undefined,
            };
        }
      const previous = pass?.comment.body;
      const start = previous?.indexOf(bodyStart) ?? -1;
      const end = previous?.indexOf(bodyEnd, start) ?? -1;
      const result =
        update.result?.body ??
        (start !== -1 && end !== -1
          ? previous!.slice(start + bodyStart.length, end)
          : undefined);
      const run = await upsert(
        tracker,
        issue,
        pass?.comment,
        `${render(state, update.phase, result)}\n<!-- scriptorium:run ${encode(state)} -->`,
      );
      remembered.set(issue, {
        comments: [...comments.filter((comment) => comment.id !== run.id), run],
        evidence,
      });
      if (!action) return;
      const { key, ...values } = action;
      const marker = `<!-- scriptorium:action ${encode({ run: run.id, occasion: key })} -->`;
      if (
        comments.some(
          (comment) => comment.author?.bot && lastLine(comment) === marker,
        )
      )
        return;
      await tracker.createComment(
        issue,
        `${renderComment("action", templates?.action, { ...values, link: run.url })}\n${marker}`,
      );
    },

    async close(issue: number, tickets: IssueId[]): Promise<void> {
      await tracker.createComment(
        issue,
        renderComment("close", templates?.close, {
          tickets: tickets.map(reference),
        }),
      );
    },
  };
}
