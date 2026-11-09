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
import { renderComment } from "./comment-template.ts";
import type { PlatformConventions } from "./factory-configuration.ts";
import type { IssueId } from "./factory.ts";
import { isHoldComment, upsert } from "./hold-comments.ts";
import type { InputResume } from "./platform.ts";
import type { RunResult } from "./run-result.ts";
import { reference } from "./readiness.ts";

const phases = ["triage", "implement", "review", "merge"] as const;
export type Phase = (typeof phases)[number];

// Each phase state: the pass's status while its latest write leaves a phase
// in it, and whether a later phase's start finishes it.
const states = {
  running: { status: "in progress", unfinished: true },
  done: { status: "in progress" },
  paused: { status: "paused", unfinished: true },
  stopped: { status: "waiting for an answer", unfinished: true },
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
  attempt?: number;
  round?: number;
  link?: string;
  unpushable?: string[];
};

// One write: facts merged into one phase's, whose run facts and link stay
// until replaced or cleared by an undefined fact, while its reason, reset and
// unpushable paths describe only its new state; a run result just posted,
// whose body the comment shows; whether the pass ends; and a released stop's
// continuation.
export type RunUpdate = {
  phase: Phase;
  facts: PhaseFacts;
  result?: Pick<RunResult, "body">;
  final?: true;
  resume?: InputResume;
};

// An occasion a person must act on: its key, unique within its pass, the
// label that names it, and for a failure why and which paths a person with
// permission must push.
export type Action = {
  key: string;
  failed?: string;
  stopped?: string;
  gate?: string;
  reason?: string;
  unpushable?: string;
};

type State = {
  phases: Partial<Record<Phase, PhaseFacts>>;
  final?: true;
  resume?: InputResume;
};

const runMarker = /^<!-- scriptorium:run (\{.*\}) -->$/;
const actionMarker = /^<!-- scriptorium:action \{.*\} -->$/;
// Run result bodies are contained, so no body closes these.
const bodyStart = "<!-- scriptorium:run-body -->\n";
const bodyEnd = "\n<!-- /scriptorium:run-body -->";
const lastLine = (comment: Comment) =>
  comment.body.split(/\r\n?|\n/).at(-1) ?? "";
// JSON whose text cannot close the HTML comment holding it.
const encode = (value: unknown) =>
  JSON.stringify(value).replace(/[<>]/g, (character) =>
    character === "<" ? "\\u003c" : "\\u003e",
  );

// A run comment the factory's account wrote, with the state its marker holds.
function runState(comment: Comment): State | null {
  const match = comment.author?.bot && runMarker.exec(lastLine(comment));
  if (!match) return null;
  try {
    const state = JSON.parse(match[1]);
    return typeof state?.phases === "object" && state.phases !== null
      ? state
      : null;
  } catch {
    return null;
  }
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
export function passContinuation(comments: Comment[]): InputResume | undefined {
  const pass = latestPass(comments);
  return pass?.state.final ? undefined : pass?.state.resume;
}

// Whether the comment is one of the factory's hold, run or action comments,
// none of which the issue-contract validator's decision reads.
export function isFactoryComment(comment: Comment): boolean {
  return (
    isHoldComment(comment.body) ||
    runState(comment) !== null ||
    (comment.author?.bot === true && actionMarker.test(lastLine(comment)))
  );
}

// The one writer of an issue's run, action and close comments, worded by the
// repository's comment templates.
export function issueComments(
  tracker: IssueTracker,
  configuration: PlatformConventions,
) {
  const templates = configuration.comments;
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
          return [name, { ...facts, check: done ? "x" : " " }];
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
    ): Promise<void> {
      const comments = await tracker.comments(issue);
      const latest = latestPass(comments);
      const pass =
        latest && (!latest.state.final || update.final) ? latest : undefined;
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
