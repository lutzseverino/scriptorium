// The factory's deterministic issue-comment language and its own wording.
const names = {
  pause: [
    "provider",
    "model",
    "effort",
    "attempt",
    "cause",
    "reset",
    "threshold",
    "label",
  ],
  failure: [
    "failure",
    "provider",
    "model",
    "effort",
    "attempt",
    "log",
    "unpushable",
    "unpushableCount",
    "label",
  ],
  close: ["tickets"],
  awaitingMerge: ["provider", "model", "effort", "attempt", "log", "label"],
} as const;

type Comment = keyof typeof names;
type Values = Record<string, string | number | string[] | null | undefined>;
type Part = string | { name: string; section?: Part[] };

const defaults = {
  awaitingMerge:
    "The factory agent run has ended, but its pull request remains open.\n\n{#provider}- Model: `{provider}/{model}@{effort}`, attempt {attempt}\n{/provider}{#log}- Log: `{log}` on the factory host\n{/log}{#provider}\n{/provider}The factory retains this issue's claim without a live agent. The owner must resolve the pull request by merging or closing it; the factory will continue observing the outcome under its existing rules. Removing `{label}` alone does not resume the run, and merging the pull request does not always close the issue.",
  pause:
    "The factory paused this run: {provider} {cause}{#reset}, resets {reset}{/reset}.\n\n- Model: `{provider}/{model}@{effort}`, attempt {attempt}\n\nThe factory resumes the run by itself and removes `{label}` when it does; nobody needs to act.",
  failure:
    "The factory run failed: {failure}.\n\n{#provider}- Model: `{provider}/{model}@{effort}`, attempt {attempt}\n{/provider}{#log}- Log: `{log}` on the factory host\n{/log}{#provider}\n{/provider}{#unpushable}- Unpushable: `{unpushable}`\n{/unpushable}{#unpushableCount}\nA person with permission to push these paths must deliver the change.\n\n{/unpushableCount}Remove `{label}` to let the factory pick this issue up again.",
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
          return Array.isArray(value) ? value.join("\n") : String(value ?? "");
        if (value === undefined || value === null || value === "") return "";
        return Array.isArray(value)
          ? value
              .map((item) =>
                render(part.section!, { ...facts, [part.name]: item }),
              )
              .join("")
          : render(part.section, facts);
      })
      .join("");
  }
  return render(parse(comment, template ?? defaults[comment]), values);
}
