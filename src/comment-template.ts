// The factory's deterministic issue-comment language and its own wording.
// The names within a run comment phase, which renders as one line.
const lineNames = [
  "check",
  "state",
  "reason",
  "reset",
  "provider",
  "model",
  "effort",
  "attempt",
  "round",
  "link",
  "unpushable",
] as const;
const names = {
  run: [
    "status",
    "triage",
    "implement",
    "review",
    "merge",
    ...lineNames,
    "result",
  ],
  action: ["failed", "stopped", "gate", "reason", "unpushable", "link"],
  close: ["tickets"],
} as const;

type Comment = keyof typeof names;
type Values = {
  [name: string]: string | number | string[] | Values | null | undefined;
};
type Part = string | { name: string; section?: Part[] };

// One checklist line of the run comment, for the phase `name`.
const phase = (name: string, title: string) =>
  `{#${name}}- [{check}] ${title}{#state}: {state}{/state}{#reason} ({reason}{#reset}, resets {reset}{/reset}){/reason}{#provider} · \`{provider}/{model}@{effort}\`, attempt {attempt}{#round}, round {round}{/round}{/provider}{#link} · [result]({link}){/link}\n{#unpushable}  - Unpushable: \`{unpushable}\`\n{/unpushable}{/${name}}`;

const defaults = {
  run: `**Factory run: {status}**\n\n${phase("triage", "Triage")}${phase("implement", "Implement")}${phase("review", "Review")}${phase("merge", "Merge")}{#result}\n<details>\n<summary>Latest run result</summary>\n\n{result}\n\n</details>\n{/result}`,
  action:
    "{#failed}The factory run failed: {reason}.{#unpushable} A person with permission to push {unpushable} must deliver the change.{/unpushable} Remove `{failed}` to run it again.{/failed}{#stopped}The factory waits in `{stopped}` for an answer.{/stopped}{#gate}Review stopped at a gate ({gate}); remove it from the issue and its pull request to merge.{/gate} See [the run comment]({link}).",
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
