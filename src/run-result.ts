// The run result: the file a run's agent leaves for the host at exit, holding
// its outcome, the labels it asks for and the text the host posts on the
// issue in the factory's frame. The host, not the agent, posts that comment
// and applies those labels, so the two always agree. Its completion signal
// stays separate loop control.
import { readFileSync } from "node:fs";
import type { IssueTracker } from "@lutzseverino/postern";
import type {
  FactoryConfiguration,
  RunKindName,
} from "./factory-configuration.ts";
import { configured, stopLabels } from "./label-roles.ts";

export type RunResult = {
  outcome: "done" | "stop" | "failed";
  // Triage's readiness when it is done, or whoever must answer a stop.
  state?: string;
  // Other labels, from the families the kind may request.
  labels?: string[];
  // Markdown, contained so that it holds no HTML comment and so no marker.
  body: string;
  // One line on why the run ended; a failed result always has one.
  reason?: string;
};

// A result the host could not accept, which fails a normally exited run.
export type ReadResult = RunResult | { invalid: string };

// Where the agent writes its result: a writable directory the host mounts
// into the sandbox, beside the read-only token directory.
export const sandboxResultDirectory = "/run/factory/result";
export const resultFile = "result.json";

// The frame's own marker, unless a triage result names the factory's triage
// result marker, which the issue-contract validator recognises.
export const resultMarker = "scriptorium:run-result";

// GitHub keeps a comment's body within 65,536 characters, frame included.
const bodyLimit = 60_000;
const reasonLimit = 300;

// Model text cannot open an HTML comment, so no marker it writes is read as
// the factory's or the validator's.
const contain = (text: string) => text.replaceAll("<!--", "&lt;!--");

// The label families the configuration lists for the kind's results: a
// requested label must start with one of them.
export function resultFamilies(
  configuration: FactoryConfiguration,
  kind: RunKindName,
): string[] {
  return configuration.version === 3
    ? (configuration.runKinds[kind]?.resultLabels ?? [])
    : [];
}

// The states a stop may ask for: every stop but triage's own.
function stopStates(configuration: FactoryConfiguration): string[] {
  const { labels } = configuration;
  return stopLabels(labels).filter((label) => label !== labels.triage);
}

// Reads the result the run left at `path`, validated for its kind.
export function readRunResult(
  path: string,
  configuration: FactoryConfiguration,
  kind: RunKindName,
): ReadResult {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return {
      invalid:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? `the run left no run result at ${sandboxResultDirectory}/${resultFile}`
          : "its run result could not be read",
    };
  }
  return parseRunResult(text, configuration, kind);
}

// Validates a result's text for its kind, containing its model text.
export function parseRunResult(
  text: string,
  configuration: FactoryConfiguration,
  kind: RunKindName,
): ReadResult {
  const invalid = (problem: string) => ({
    invalid: `its run result ${problem}`,
  });
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid("is not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalid("is not a JSON object");
  if (
    Object.keys(value).some(
      (name) =>
        !["outcome", "state", "labels", "body", "reason"].includes(name),
    )
  )
    return invalid("has a field the run-result interface does not name");
  const { outcome, state, labels = [], body, reason } = value;
  if (!["done", "stop", "failed"].includes(outcome))
    return invalid("has no outcome of done, stop or failed");
  if (typeof body !== "string" || body.trim() === "")
    return invalid("has no body");
  if (contain(body).length > bodyLimit)
    return invalid(`has a body over ${bodyLimit} characters`);
  if (
    reason !== undefined &&
    (typeof reason !== "string" ||
      reason.trim() === "" ||
      /[\r\n]/.test(reason) ||
      reason.length > reasonLimit)
  )
    return invalid(
      `has a reason that is not one line of at most ${reasonLimit} characters`,
    );
  if (outcome === "failed" && reason === undefined)
    return invalid("fails without a reason");
  const states =
    outcome === "stop"
      ? stopStates(configuration)
      : outcome === "done" && kind === "triage"
        ? [configuration.labels.ready]
        : [];
  if (outcome === "stop" && states.length === 0)
    return invalid("stops, and the configuration names no state to stop in");
  if (states.length ? !states.includes(state) : state !== undefined)
    return invalid(
      states.length
        ? `asks for no state of ${states.join(", ")}`
        : `asks for a state, which a ${outcome} ${kind} result has none of`,
    );
  if (
    !Array.isArray(labels) ||
    labels.some(
      (label) =>
        typeof label !== "string" || label.trim() !== label || label === "",
    ) ||
    new Set(labels.map((label: string) => label.toLowerCase())).size !==
      labels.length
  )
    return invalid("has labels that are not distinct label names");
  if (outcome === "failed" && labels.length)
    return invalid("asks for labels, which a failed result has none of");
  const families = resultFamilies(configuration, kind).map((family) =>
    family.toLowerCase(),
  );
  const mechanics = configured(
    configuration.labels,
    (role) => !role.requestable,
  ).map((label) => label.toLowerCase());
  const refused = (labels as string[]).find(
    (label) =>
      mechanics.includes(label.toLowerCase()) ||
      !families.some((family) => label.toLowerCase().startsWith(family)),
  );
  if (refused !== undefined)
    return invalid(
      `asks for the label ${contain(JSON.stringify(refused))}, outside the families the ${kind} run kind may request`,
    );
  return {
    outcome,
    ...(state !== undefined && { state }),
    ...(labels.length && { labels }),
    body: contain(body),
    ...(reason !== undefined && {
      reason: contain(reason.trim().replace(/\.+$/, "")),
    }),
  };
}

// The facts of the run that left a result, and the run ID the host issued it.
type RunFacts = {
  id: string;
  kind: RunKindName;
  provider: string;
  model: string;
  effort: string;
  attempt: number;
};

// The comment the host posts for a result, its marker line, and the labels
// it writes with it: the requested ones before the state, and a triage run's
// own triage label removed.
export type ResultPost = {
  comment: string;
  marker: string;
  add: string[];
  remove: string[];
  triage?: { run: string; brief: string; disclaimer: string; author: string };
};

// The factory's frame: the configured disclaimer, the body, the run's facts
// and a marker naming the run, which a triage result's brief needs exactly
// once to back the readiness it applies.
export function resultPost(
  result: RunResult,
  run: RunFacts,
  configuration: FactoryConfiguration,
): ResultPost {
  const { comments, labels } = configuration;
  const triage = run.kind === "triage";
  const disclaimer = triage
    ? (comments?.triageDisclaimer ??
      "> *This was generated by AI during triage.*")
    : (comments?.disclaimer ?? "> _This was generated by AI._");
  const name =
    (triage &&
      configuration.version === 3 &&
      configuration.triageResult?.marker) ||
    resultMarker;
  const marker = `<!-- ${name} ${JSON.stringify({
    run: run.id,
    outcome: result.outcome,
  })} -->`;
  return {
    comment: [
      disclaimer,
      "",
      result.body,
      "",
      `Run: ${run.kind}, \`${run.provider}/${run.model}@${run.effort}\`, attempt ${run.attempt}, ${result.outcome}${result.reason ? `: ${result.reason}` : ""}.`,
      marker,
    ].join("\n"),
    marker,
    add: [...(result.labels ?? []), ...(result.state ? [result.state] : [])],
    remove: triage && labels.triage ? [labels.triage] : [],
    ...(triage &&
      result.outcome === "done" && {
        triage: {
          run: run.id,
          brief: `${disclaimer}\n\n${result.body}`,
          disclaimer,
          author:
            configuration.version === 3
              ? (configuration.triageResult?.author ?? "")
              : "",
        },
      }),
  };
}

// An issue's labels once a result's labels are written.
export function postedLabels(labels: string[], post: ResultPost): string[] {
  return [
    ...new Set([
      ...labels.filter((label) => !post.remove.includes(label)),
      ...post.add,
    ]),
  ];
}

// Posts a result's comment once, resolving its link: a retry after a failed
// label write finds the comment by its marker line and leaves it as it is.
export async function postResultComment(
  tracker: IssueTracker,
  issue: number,
  {
    comment,
    marker,
    triage,
  }: Pick<ResultPost, "comment" | "marker" | "triage">,
): Promise<string> {
  const matches = (await tracker.comments(issue)).filter((existing) =>
    existing.body.includes(marker),
  );
  if (
    matches.length > 1 ||
    matches.some(
      (existing) =>
        existing.body !== comment ||
        (triage &&
          ((triage.author && existing.author?.login !== triage.author) ||
            existing.createdAt !== existing.updatedAt)),
    )
  )
    throw new Error(
      "Result evidence conflicts with its immutable issue/run identity; restore fresh applicable review instead of adopting an edited marker",
    );
  const posted = matches[0];
  return (posted ?? (await tracker.createComment(issue, comment))).url;
}

// The run-result interface as the run's prompt states it.
export function resultGuidance(
  configuration: FactoryConfiguration,
  kind: RunKindName,
): string {
  const stops = stopStates(configuration).map((label) => JSON.stringify(label));
  const families = resultFamilies(configuration, kind).map((family) =>
    JSON.stringify(family),
  );
  return [
    `Run result: before you end, write your run result to ${sandboxResultDirectory}/${resultFile} as one JSON object.`,
    `"outcome" is "done", "stop" or "failed".`,
    ...(kind === "triage"
      ? [
          `A done result asks for "state" ${JSON.stringify(configuration.labels.ready)}, the readiness the brief carries.`,
        ]
      : []),
    ...(stops.length
      ? [
          `A stop asks for "state", the label of whoever must answer: ${stops.join(", ")}.`,
        ]
      : []),
    families.length
      ? `"labels" lists any other labels to apply, each starting with ${families.join(", ")}.`
      : `Ask for no other labels.`,
    `"body" is the Markdown the factory posts on the issue in its frame, without a disclaimer: ${kind === "triage" ? "the complete Agent Brief with its seven required fields, applicable Seams and triage notes, or the question that stops it. Do not include Original request: the host preserves the authenticated original separately" : "what the run delivered, or the question or stop note"}.`,
    `"reason" is one line on why the run ended, required when it failed.`,
    "The factory posts the body and applies those labels; do not post that comment or apply those labels yourself. Comments on pull requests and review-thread replies stay yours to post.",
  ].join(" ");
}
