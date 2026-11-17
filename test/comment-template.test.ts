import assert from "node:assert/strict";
import { test } from "node:test";
import { renderComment } from "../src/comment-template.ts";
import type { Labels } from "../src/label-roles.ts";
import { stopAction } from "../src/run-comment.ts";

test("comment templates substitute facts and conditionally render scalar sections", () => {
  const template =
    "{provider}: {reason}{#reset}, resets {reset}{/reset}{#attempt} attempt {attempt}{/attempt}; {model}";
  assert.equal(
    renderComment("run", template, {
      provider: "codex",
      reason: "usage limit",
      reset: "17:00 UTC",
    }),
    "codex: usage limit, resets 17:00 UTC; ",
  );
  assert.equal(
    renderComment("run", template, {
      provider: "codex",
      reason: "pause threshold",
      reset: null,
      attempt: 0,
    }),
    "codex: pause threshold attempt 0; ",
  );
});

test("list sections repeat with the current item and retain surrounding scalar facts", () => {
  const template =
    "{#attempt}{attempt} paths:\n{#unpushable}{#state}{state}: {/state}{unpushable}\n{/unpushable}Deliver once.{/attempt}";
  assert.equal(
    renderComment("run", template, {
      unpushable: ["a.yml", "b.yml"],
      attempt: 2,
      state: "failed",
    }),
    "2 paths:\nfailed: a.yml\nfailed: b.yml\nDeliver once.",
  );
  assert.equal(renderComment("run", template, { unpushable: [] }), "");
  assert.equal(
    renderComment("close", "{#tickets}- {tickets}\n{/tickets}", {
      tickets: [],
    }),
    "",
  );
  assert.equal(
    renderComment("close", "{tickets}", { tickets: ["#2", "acme/other#3"] }),
    "#2\nacme/other#3",
  );
});

test("other braces are literal, and neither a placeholder nor an escape is required", () => {
  assert.equal(
    renderComment("run", '{ "a": 1 } {} {model_name} {model2} { model }', {}),
    '{ "a": 1 } {} {model_name} {model2} { model }',
  );
  assert.equal(
    renderComment("run", "{{provider}} \\{provider}", { provider: "codex" }),
    "{codex} \\codex",
  );
  assert.equal(
    renderComment("action", "A fixed comment.", {}),
    "A fixed comment.",
  );
});

test("unknown names and unbalanced sections are invalid even inside an empty section", () => {
  for (const template of [
    "{failed}",
    "{#tickets}x{/tickets}",
    "{#reset}{unknown}{/reset}",
    "{/reset}",
    "{#reset}",
    "{#reset}{#model}{/reset}{/model}",
  ])
    assert.throws(
      () => renderComment("run", template, {}),
      /unknown name|unbalanced section/,
    );
  assert.throws(
    () => renderComment("action", "{provider}", {}),
    /unknown name \{provider\} in action comment template/,
  );
});

test("an object's section renders once with its facts in scope, and inserts nothing directly", () => {
  const template =
    "{status}:{#implement} [{check}] {state}{#provider} {provider}{/provider}{/implement}{#review} review{/review}{implement}";
  assert.equal(
    renderComment("run", template, {
      status: "paused",
      implement: { check: " ", state: "paused", provider: "codex" },
    }),
    "paused: [ ] paused codex",
  );
  assert.equal(
    renderComment("run", template, {
      status: "merged",
      implement: { check: "x", state: "done" },
      review: { check: " " },
    }),
    "merged: [x] done review",
  );
});

test("the default run comment shows each phase's line and the latest result in a details block", () => {
  assert.equal(
    renderComment("run", undefined, {
      status: "paused",
      triage: {
        check: "x",
        state: "done",
        provider: "codex",
        model: "gpt-5.5",
        effort: "high",
        attempt: 1,
        link: "https://platform.test/c/1",
      },
      implement: {
        check: " ",
        state: "paused",
        reason: "usage limit",
        reset: "15:00 UTC",
        provider: "claude-code",
        model: "claude-opus-5-5",
        effort: "high",
        attempt: 2,
        round: 2,
      },
      merge: {
        check: " ",
        state: "failed",
        reason: "unpushable paths",
        unpushable: ["a.yml", "b.yml"],
      },
      result: "The brief.",
    }),
    [
      "**Factory run: paused**",
      "",
      "- [x] Triage: done · `codex/gpt-5.5@high`, attempt 1 · [result](https://platform.test/c/1)",
      "- [ ] Implement: paused (usage limit, resets 15:00 UTC) · `claude-code/claude-opus-5-5@high`, attempt 2, round 2",
      "- [ ] Merge: failed (unpushable paths)",
      "  - Unpushable: `a.yml`",
      "  - Unpushable: `b.yml`",
      "",
      "<details>",
      "<summary>Latest run result</summary>",
      "",
      "The brief.",
      "",
      "</details>",
      "",
    ].join("\n"),
  );
  assert.equal(
    renderComment("run", undefined, {
      status: "in progress",
      implement: { check: " " },
      merge: { check: " " },
    }),
    "**Factory run: in progress**\n\n- [ ] Implement\n- [ ] Merge\n",
  );
});

test("the default action comment names its occasion's label in one line linking the run comment", () => {
  const link = "https://platform.test/c/9";
  assert.equal(
    renderComment("action", undefined, {
      failed: "broken",
      reason: "the run ended without an open pull request",
      link,
    }),
    "The factory run failed: the run ended without an open pull request. Remove `broken` to run it again. See [the run comment](https://platform.test/c/9).",
  );
  assert.equal(
    renderComment("action", undefined, {
      failed: "broken",
      reason: "its branch changes paths the factory can't push",
      unpushable: "`a.yml`, `b.yml`",
      link,
    }),
    "The factory run failed: its branch changes paths the factory can't push. A person with permission to push `a.yml`, `b.yml` must deliver the change. Remove `broken` to run it again. See [the run comment](https://platform.test/c/9).",
  );
  assert.equal(
    renderComment("action", undefined, { stopped: "state:owner", link }),
    "The factory waits in `state:owner` for an answer. See [the run comment](https://platform.test/c/9).",
  );
  assert.equal(
    renderComment("action", undefined, { gate: "gate:owner-review", link }),
    "Review stopped at a gate (gate:owner-review); remove it from the issue and its pull request to merge. See [the run comment](https://platform.test/c/9).",
  );
});

test("every default stop comment names the states that answer it", () => {
  const link = "https://platform.test/c/9";
  const labels = {
    ready: "state:ready",
    running: "factory:running",
    failed: "factory:failed",
    paused: "factory:paused",
    triage: "state:triage",
    reporter: "state:reporter",
    grill: "state:grill",
    owner: "state:owner",
    carried: "state:carried",
  };
  const stop = (
    stopped: string,
    options: Parameters<typeof stopAction>[3],
    configured: Labels = labels,
  ) => {
    const { key, ...values } = stopAction(
      "stop:a",
      stopped,
      configured,
      options,
    );
    assert.equal(key, "stop:a");
    return renderComment("action", undefined, { ...values, link });
  };
  // An owner stop of implement or review work resumes on readiness.
  for (const resume of ["implement", "review"] as const)
    assert.equal(
      stop("state:owner", { triage: true, resume }),
      `The factory waits in \`state:owner\` for an answer. To answer, apply \`state:ready\` at the unchanged approved contract to resume the stopped ${resume} run, \`state:triage\` to triage it again, \`state:carried\` to hold the request, or close the issue. A comment alone starts nothing. See [the run comment](https://platform.test/c/9).`,
    );
  // A triage run's owner stop leaves no work to resume.
  assert.equal(
    stop("state:owner", { triage: true }),
    "The factory waits in `state:owner` for an answer. To answer, apply `state:triage` to triage it again, `state:carried` to hold the request, or close the issue. A comment alone starts nothing. See [the run comment](https://platform.test/c/9).",
  );
  // Without triage or a carried state, neither is named.
  const { carried: _, ...uncarried } = labels;
  assert.equal(
    stop("state:owner", { triage: false, resume: "implement" }, uncarried),
    "The factory waits in `state:owner` for an answer. To answer, apply `state:ready` at the unchanged approved contract to resume the stopped implement run, or close the issue. A comment alone starts nothing. See [the run comment](https://platform.test/c/9).",
  );
  assert.equal(
    stop("state:reporter", { triage: true, resume: "implement" }),
    "The factory waits in `state:reporter` for an answer. The reporter answers by replying here. A person may instead apply `state:triage` to triage it again, or close the issue. See [the run comment](https://platform.test/c/9).",
  );
  assert.equal(
    stop("state:grill", { triage: true }),
    "The factory waits in `state:grill` for an answer. Once the grill settles the request, a person applies `state:triage` to triage it again, `state:ready` at a revised ticket's accepted revision, or closes the issue. A comment alone starts nothing. See [the run comment](https://platform.test/c/9).",
  );
  assert.equal(
    stop("state:grill", { triage: false }),
    "The factory waits in `state:grill` for an answer. Once the grill settles the request, a person applies `state:ready` at a revised ticket's accepted revision, or closes the issue. A comment alone starts nothing. See [the run comment](https://platform.test/c/9).",
  );
});

test("the default close comment preserves local and cross-repository ticket references", () => {
  assert.equal(
    renderComment("close", undefined, { tickets: ["#4", "acme/other#8"] }),
    "All sub-issues are closed. Closing this parent.\n\n- #4\n- acme/other#8",
  );
});
