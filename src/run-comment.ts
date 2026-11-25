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
import {
  lastCommentLine,
  lineNames,
  renderComment,
} from "./comment-template.ts";
import type { PlatformConventions } from "./factory-configuration.ts";
import { standInReason, type IssueId, type StandIn } from "./factory.ts";
import { isHoldComment, upsert } from "./hold-comments.ts";
import { roleNames, type Labels, type RoleName } from "./label-roles.ts";
import type { InputResume } from "./platform.ts";
import {
  contain,
  parseTerminalResult,
  type RunResult,
  type TerminalResult,
} from "./run-result.ts";
import { reference } from "./readiness.ts";
import { contractEvidenceIds } from "./contract-protocol.ts";

const phases = ["triage", "implement", "review", "merge"] as const;
export type Phase = (typeof phases)[number];

// Each phase state, and whether a later phase's start finishes it.
const states = {
  running: { unfinished: true },
  done: {},
  paused: { unfinished: true },
  stopped: { unfinished: true },
  carried: { unfinished: true },
  "awaiting merge": {},
  merged: {},
  failed: {},
};

// Each phase's status words while it runs and once it is done. A merge
// relaunch that is done leaves its pull request awaiting merge.
const words = {
  triage: { running: "Triaging", done: "Triaged" },
  implement: { running: "Implementing", done: "Implemented" },
  review: { running: "Reviewing", done: "Reviewed" },
  merge: { running: "Merging", done: "Awaiting merge" },
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
  summary?: string;
  waits?: string;
  unpushable?: string[];
};

function standInText(facts: PhaseFacts): string | undefined {
  if (!facts.standIn) return undefined;
  const { chosen, reason } = facts.standIn;
  return `stand-in for \`${chosen}\`: ${standInReason(reason)}`;
}

// A run result's lead line: the first line with text once a heading's
// markers, opening and closing, are removed, cut to 100 characters.
export function summaryLine(body: string): string | undefined {
  const line = contain(body)
    .split(/\r\n?|\n/)
    .map((text) => {
      const trimmed = text.trim();
      const heading = /^#{1,6}(?:\s+|$)/.exec(trimmed);
      return heading
        ? trimmed
            .slice(heading[0].length)
            .replace(/(?:^|\s+)#+$/, "")
            .trim()
        : trimmed;
    })
    .find((text) => text !== "");
  if (line === undefined) return undefined;
  const characters = [...line];
  return characters.length > 100
    ? `${characters.slice(0, 99).join("")}…`
    : line;
}

// A phase's status marker and the pass's status word while that phase is
// the latest written. A stop shows who it waits on: a person, triage, or
// nobody once carried. A phase whose round an earlier phase passed was
// handed back.
function look(
  phase: Phase,
  facts: PhaseFacts | undefined,
  labels: Labels,
  handedBack: boolean,
): { icon: string; status: string } {
  const shown = (icon: string, status: string) => ({
    icon: handedBack && facts?.state !== "running" ? "🔁" : icon,
    status,
  });
  switch (facts?.state) {
    case undefined:
      return shown("⬜", words[phase].running);
    case "running":
      return shown("🔄", words[phase].running);
    case "done":
      return phase === "merge"
        ? shown("👤", words.merge.done)
        : shown("✅", words[phase].done);
    case "paused":
      return shown("⏸️", "Paused");
    case "stopped":
      return facts.waits !== undefined && facts.waits === labels.triage
        ? shown("⬜", "Waiting for triage")
        : facts.waits !== undefined && facts.waits === labels.carried
          ? shown("↗️", "Carried")
          : shown("👤", "Waiting for an answer");
    case "carried":
      return shown("↗️", "Carried");
    case "awaiting merge":
      return shown("👤", "Awaiting merge");
    case "merged":
      return shown("✅", "Merged");
    case "failed":
      return shown("❌", "Failed");
  }
}

// A run result comment's body without the factory's frame: its footer, or
// before footers its leading disclaimer and closing `Run:` line. Either
// disclaimer may span lines, and marker lines, such as an accepted triage
// result's review attestation, follow the frame.
function resultBody(comment: string): string | undefined {
  const lines = comment.split(/\r\n?|\n/);
  let end = lines.length;
  while (end > 0 && /^<!-- .* -->$/.test(lines[end - 1]!)) end--;
  if (end === lines.length || end === 0) return undefined;
  if (lines[end - 1]!.endsWith("</sub>")) {
    const footer = lines.findLastIndex(
      (line, index) => index < end && line.startsWith("<sub>"),
    );
    return footer > 0 && lines[footer - 1] === ""
      ? lines.slice(0, footer - 1).join("\n")
      : undefined;
  }
  const disclaimer = lines.indexOf("");
  if (
    lines[end - 1]!.startsWith("Run: ") &&
    lines[end - 2] === "" &&
    disclaimer > 0 &&
    disclaimer < end - 2
  )
    return lines.slice(disclaimer + 1, end - 2).join("\n");
  return undefined;
}

// The time of day a write shows, in UTC.
const timeOfDay = (date: Date) => `${date.toISOString().slice(11, 16)}Z`;

// One write: facts merged into one phase's, whose run facts and link stay
// until replaced or cleared by an undefined fact, while its reason, reset and
// unpushable paths and the stop label it waits in describe only its new
// state; a run result just posted, whose lead line the comment shows and
// whose body a template may insert; whether the pass ends; and a released
// stop's continuation.
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
  updated?: string;
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
  now: () => Date = () => new Date(),
) {
  const templates = configuration.comments;
  // Quota pauses can write the current run notice without another platform
  // read. These facts came from this writer's last successful observation.
  const remembered = new Map<
    number,
    { comments: Comment[]; evidence: Set<string> }
  >();
  // Implement and merge always show, review once it is on, and triage once
  // it ran in the pass. Outside a phase, the facts are the written phase's.
  function render(
    state: State,
    phase: Phase,
    result: string | undefined,
    updated: string,
  ) {
    const shown = phases.filter(
      (name) =>
        state.phases[name] ||
        name === "implement" ||
        name === "merge" ||
        (name === "review" && configuration.runKinds?.review),
    );
    // A phase's section names all its facts, so none it lacks is read from
    // the written phase's outside it.
    const unset = Object.fromEntries(
      lineNames.map((name) => [name, undefined]),
    );
    const values = (name: Phase) => {
      const facts = state.phases[name];
      const done = facts?.state === "done" || facts?.state === "merged";
      const round = facts?.round;
      const handedBack =
        round !== undefined &&
        phases
          .slice(0, phases.indexOf(name))
          .some((earlier) => (state.phases[earlier]?.round ?? 0) > round);
      const outcome = [facts?.summary, facts?.reason]
        .filter((text) => text !== undefined && text !== "")
        .join(" · ");
      return {
        ...unset,
        ...facts,
        icon: look(name, facts, configuration.labels, handedBack).icon,
        standIn: facts && standInText(facts),
        outcome: outcome || undefined,
        check: done ? "x" : " ",
      };
    };
    const current = state.phases[phase];
    return renderComment("run", templates?.run, {
      ...values(phase),
      ...look(phase, current, configuration.labels, false),
      failure: current?.state === "failed" ? current.reason : undefined,
      pause:
        current?.state === "paused"
          ? [current.reason, current.reset && `resumes at ${current.reset}`]
              .filter(Boolean)
              .join(", ") || undefined
          : undefined,
      updated,
      ...Object.fromEntries(shown.map((name) => [name, values(name)])),
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
      // A phase whose result was linked before summaries were kept reads its
      // summary from that result's comment.
      const phasesBefore = Object.fromEntries(
        Object.entries(pass?.state.phases ?? {}).map(([name, facts]) => {
          if (facts.link === undefined || facts.summary !== undefined)
            return [name, facts];
          const linked = comments.find((comment) => comment.url === facts.link);
          const body = linked && resultBody(linked.body);
          return [name, { ...facts, summary: body && summaryLine(body) }];
        }),
      );
      const terminal = update.result?.terminal;
      if (terminal && !results.some((entry) => entry.run === terminal.run))
        results.push(terminal);
      const state: State = {
        phases: {
          ...phasesBefore,
          [update.phase]: {
            ...phasesBefore[update.phase],
            reason: undefined,
            reset: undefined,
            waits: undefined,
            unpushable: undefined,
            ...(update.result && { summary: summaryLine(update.result.body) }),
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
              waits: undefined,
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
      // A write that changes nothing keeps the time the comment was updated.
      const body = (updated: string) =>
        `${render(state, update.phase, result, updated)}\n<!-- scriptorium:run ${encode({ ...state, updated })} -->`;
      const kept = pass?.state.updated && body(pass.state.updated);
      const run = await upsert(
        tracker,
        issue,
        pass?.comment,
        kept && kept === pass.comment.body ? kept : body(timeOfDay(now())),
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
