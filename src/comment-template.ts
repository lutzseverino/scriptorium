// The factory's deterministic issue-comment language and its own wording.
import { roleNames } from "./label-roles.ts";

// The names within a run comment phase, which outside a phase are the
// written phase's.
export const lineNames = [
  "icon",
  "check",
  "state",
  "reason",
  "reset",
  "provider",
  "model",
  "effort",
  "standIn",
  "attempt",
  "round",
  "link",
  "summary",
  "outcome",
  "unpushable",
] as const;
const names = {
  run: [
    "status",
    "failure",
    "updated",
    "triage",
    "implement",
    "review",
    "merge",
    ...lineNames,
    "result",
  ],
  // A stop names the role it asks and each role whose label answers it.
  action: [
    "failed",
    "stopped",
    ...roleNames((role) => role.asks || role.answers),
    "resume",
    "gate",
    "reason",
    "unpushable",
    "link",
  ],
  close: ["tickets"],
};

type Comment = keyof typeof names;
type Values = {
  [name: string]: string | number | string[] | Values | null | undefined;
};
type Part = string | { name: string; section?: Part[] };

// The run comment's outcome line for the phase `name`.
const outcome = (name: string, title: string) =>
  `{#${name}}{#outcome}\n**${title}:** {outcome}{#link} · [result]({link}){/link}\n{/outcome}{/${name}}`;

const defaults = {
  run: `### {icon} {status}{#reset}: {reason}, resumes at {reset}{/reset}\n{#failure}\n> [!CAUTION]\n> {failure}\n{#unpushable}> - Unpushable: \`{unpushable}\`\n{/unpushable}{/failure}\n{#triage}{icon} Triage → {/triage}{#implement}{icon} Implement{/implement}{#review} → {icon} Review{/review} → {#merge}{icon} Merge{/merge}\n${outcome("triage", "Triage")}${outcome("implement", "Implement")}${outcome("review", "Review")}${outcome("merge", "Merge")}\n<sub>Factory run, edited in place{#provider} · \`{provider}/{model}@{effort}\`{#standIn}, {standIn}{/standIn}, attempt {attempt}{#round}, round {round}{/round}{/provider} · updated {updated}</sub>`,
  action:
    "{#failed}The factory run failed: {reason}.{#unpushable} A person with permission to push {unpushable} must deliver the change.{/unpushable} Remove `{failed}` to run it again.{/failed}{#stopped}The factory waits in `{stopped}` for an answer.{#owner} To answer, apply {#resume}`{ready}` at the unchanged approved contract to resume the stopped {resume} run, {/resume}{#triage}`{triage}` to triage it again, {/triage}{#carried}`{carried}` to hold the request, {/carried}or close the issue. A comment alone starts nothing.{/owner}{#reporter} The reporter answers by replying here. A person may instead {#triage}apply `{triage}` to triage it again, or {/triage}close the issue.{/reporter}{#grill} Once the grill settles the request, a person applies {#triage}`{triage}` to triage it again, {/triage}`{ready}` at a revised ticket's accepted revision, or closes the issue. A comment alone starts nothing.{/grill}{/stopped}{#gate}Review stopped at a gate ({gate}); remove it from the issue and its pull request to merge.{/gate} See [the run comment]({link}).",
  close:
    "All sub-issues are closed. Closing this parent.\n{#tickets}\n- {tickets}{/tickets}",
};

function parse(comment: Comment, template: string): Part[] {
  const root: Part[] = [];
  const stack = [{ name: "", section: root }];
  let end = 0;
  for (const match of template.matchAll(/\{([#/]?)([a-zA-Z]+)\}/g)) {
    const current = stack.at(-1)!;
    current.section.push(template.slice(end, match.index));
    const [, form, name] = match;
    if (!(names[comment] as readonly string[]).includes(name))
      throw new Error(`unknown name {${name}} in ${comment} comment template`);
    if (form === "/") {
      if (stack.length === 1 || current.name !== name)
        throw new Error(
          `unbalanced section {/${name}} in ${comment} comment template`,
        );
      stack.pop();
    } else if (form === "#") {
      const section = { name, section: [] as Part[] };
      current.section.push(section);
      stack.push(section);
    } else current.section.push({ name });
    end = match.index + match[0].length;
  }
  stack.at(-1)!.section.push(template.slice(end));
  if (stack.length !== 1)
    throw new Error(
      `unbalanced section {#${stack.at(-1)!.name}} in ${comment} comment template`,
    );
  return root;
}

export function validateCommentTemplate(
  comment: Comment,
  template: string,
): void {
  parse(comment, template);
}

export function renderComment(
  comment: Comment,
  template: string | undefined,
  values: Values,
): string {
  function render(parts: Part[], facts: Values): string {
    return parts
      .map((part) => {
        if (typeof part === "string") return part;
        const value = facts[part.name];
        if (!part.section)
          return Array.isArray(value)
            ? value.join("\n")
            : typeof value === "object"
              ? ""
              : String(value ?? "");
        if (value === undefined || value === null || value === "") return "";
        return Array.isArray(value)
          ? value
              .map((item) =>
                render(part.section!, { ...facts, [part.name]: item }),
              )
              .join("")
          : // An object's section renders once, with its facts in scope.
            render(
              part.section,
              typeof value === "object" ? { ...facts, ...value } : facts,
            );
      })
      .join("");
  }
  return render(parse(comment, template ?? defaults[comment]), values);
}

// Marker readers share the definition of a comment's final line.
export const lastCommentLine = (body: string): string =>
  body.split(/\r\n?|\n/).at(-1) ?? "";
