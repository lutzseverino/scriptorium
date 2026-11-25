import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

// The published defaults, as the docs list them.
const guide = readFileSync(
  new URL("../docs/usage/factory-configuration.md", import.meta.url),
  "utf8",
);
const publishedRun = JSON.parse(
  /\nRun:\n\n```json\n(".*")\n```/.exec(guide)![1],
);
const publishedAction = JSON.parse(
  /\nAction:\n\n```json\n(".*")\n```/.exec(guide)![1],
);

test("the default run comment is the published one: lead line, pipeline line, outcome lines and footer", () => {
  const values = {
    icon: "🔄",
    status: "Implementing",
    provider: "codex",
    model: "gpt-6.1-sol",
    effort: "high",
    attempt: 1,
    updated: "13:19Z",
    triage: {
      icon: "✅",
      outcome: "Ready. Point the installed rules at the two issue forms",
      link: "https://platform.test/c/1",
    },
    implement: { icon: "🔄" },
    review: { icon: "⬜" },
    merge: { icon: "⬜" },
    result: "The brief.",
  };
  const rendered = [
    "### 🔄 Implementing",
    "",
    "✅ Triage → 🔄 Implement → ⬜ Review → ⬜ Merge",
    "",
    "**Triage:** Ready. Point the installed rules at the two issue forms · [result](https://platform.test/c/1)",
    "",
    "<sub>Factory run, edited in place · `codex/gpt-6.1-sol@high`, attempt 1 · updated 13:19Z</sub>",
  ].join("\n");
  assert.equal(renderComment("run", undefined, values), rendered);
  assert.equal(renderComment("run", publishedRun, values), rendered);
  // A paused pass gives its pause; a failure adds a caution alert.
  assert.equal(
    renderComment("run", undefined, {
      icon: "❌",
      status: "Failed",
      failure: "unpushable paths",
      unpushable: ["a.yml", "b.yml"],
      updated: "13:19Z",
      implement: { icon: "❌", outcome: "unpushable paths" },
      merge: { icon: "⬜" },
    }),
    [
      "### ❌ Failed",
      "",
      "> [!CAUTION]",
      "> unpushable paths",
      "> - Unpushable: `a.yml`",
      "> - Unpushable: `b.yml`",
      "",
      "❌ Implement → ⬜ Merge",
      "",
      "**Implement:** unpushable paths",
      "",
      "<sub>Factory run, edited in place · updated 13:19Z</sub>",
    ].join("\n"),
  );
  for (const pause of ["usage limit, resumes at 18:00Z", "pause threshold"])
    assert.equal(
      renderComment("run", publishedRun, {
        icon: "⏸️",
        status: "Paused",
        pause,
        implement: { icon: "⏸️" },
        merge: { icon: "⬜" },
      }).split("\n")[0],
      `### ⏸️ Paused: ${pause}`,
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
    "❌ The factory run failed: the run ended without an open pull request. Remove `broken` to run it again. See [the run comment](https://platform.test/c/9).",
  );
  assert.equal(
    renderComment("action", undefined, {
      failed: "broken",
      reason: "its branch changes paths the factory can't push",
      unpushable: "`a.yml`, `b.yml`",
      link,
    }),
    "❌ The factory run failed: its branch changes paths the factory can't push. A person with permission to push `a.yml`, `b.yml` must deliver the change. Remove `broken` to run it again. See [the run comment](https://platform.test/c/9).",
  );
  // A failed triage run's trigger is consumed, so it names the triage state.
  assert.equal(
    renderComment("action", undefined, {
      failed: "broken",
      reason: "the run left no run result",
      triage: "state:triage",
      link,
    }),
    "❌ The factory run failed: the run left no run result. Remove `broken` and apply `state:triage` again, removing it first if the issue carries it, to run it again. See [the run comment](https://platform.test/c/9).",
  );
  assert.equal(
    renderComment("action", undefined, { stopped: "state:owner", link }),
    "👤 The factory waits in `state:owner` for an answer. See [the run comment](https://platform.test/c/9).",
  );
  assert.equal(
    renderComment("action", undefined, { gate: "gate:owner-review", link }),
    "👤 Review stopped at a gate (gate:owner-review); remove it from the issue and its pull request to merge. See [the run comment](https://platform.test/c/9).",
  );
});

test("the default comments address whoever must act: run comment lead line and alert, action lead", () => {
  const phases = { implement: { icon: "👤" }, merge: { icon: "⬜" } };
  const waiting = {
    icon: "👤",
    status: "Waiting for an answer",
    summary: "Publish a patch now, or in the next release?",
    updated: "13:19Z",
    ...phases,
  };
  const mentioned = renderComment("run", publishedRun, {
    ...waiting,
    mention: "@owner",
  });
  assert.equal(
    renderComment("run", undefined, { ...waiting, mention: "@owner" }),
    mentioned,
  );
  assert.deepEqual(mentioned.split("\n").slice(0, 6), [
    "### 👤 Waiting for an answer · @owner must act",
    "",
    "> [!IMPORTANT]",
    "> @owner: Publish a patch now, or in the next release?",
    "",
    "👤 Implement → ⬜ Merge",
  ]);
  // Nobody to mention: no mention and no alert.
  assert.deepEqual(
    renderComment("run", undefined, waiting).split("\n").slice(0, 3),
    ["### 👤 Waiting for an answer", "", "👤 Implement → ⬜ Merge"],
  );
  // A failure keeps its caution alert apart from the important one.
  assert.deepEqual(
    renderComment("run", undefined, {
      icon: "❌",
      status: "Failed",
      failure: "unpushable paths",
      unpushable: ["a.yml"],
      mention: "@alice, @bob",
      summary: "The workflow edit needs a person.",
      ...phases,
    })
      .split("\n")
      .slice(0, 9),
    [
      "### ❌ Failed · @alice, @bob must act",
      "",
      "> [!CAUTION]",
      "> unpushable paths",
      "> - Unpushable: `a.yml`",
      "",
      "> [!IMPORTANT]",
      "> @alice, @bob: The workflow edit needs a person.",
      "",
    ],
  );

  const link = "https://platform.test/c/9";
  const asked = {
    stopped: "state:owner",
    owner: "state:owner",
    mention: "@owner",
    summary: "Approved",
    link,
  };
  assert.equal(
    renderComment("action", publishedAction, asked),
    renderComment("action", undefined, asked),
  );
  assert.equal(
    renderComment("action", undefined, {
      stopped: "state:owner",
      owner: "state:owner",
      triage: "state:triage",
      mention: "@owner",
      summary: "Publish a patch now, or in the next release?",
      link,
    }),
    "👤 **@owner, Publish a patch now, or in the next release?** The factory waits in `state:owner` for an answer. To answer, apply `state:triage` to triage it again, or close the issue. A comment alone starts nothing. See [the run comment](https://platform.test/c/9).",
  );
  assert.equal(
    renderComment("action", undefined, {
      failed: "broken",
      reason: "its branch changes paths the factory can't push",
      unpushable: "`a.yml`",
      mention: "@alice, @bob",
      link,
    }),
    "❌ **@alice, @bob** The factory run failed: its branch changes paths the factory can't push. A person with permission to push `a.yml` must deliver the change. Remove `broken` to run it again. See [the run comment](https://platform.test/c/9).",
  );
  assert.equal(
    renderComment("action", undefined, {
      gate: "gate:owner-review",
      mention: "@owner",
      summary: "Approved",
      link,
    }),
    "👤 **@owner, Approved** Review stopped at a gate (gate:owner-review); remove it from the issue and its pull request to merge. See [the run comment](https://platform.test/c/9).",
  );
  // Without a mention, the summary is left to the run comment.
  assert.equal(
    renderComment("action", undefined, {
      stopped: "state:owner",
      summary: "Publish a patch now, or in the next release?",
      link,
    }),
    "👤 The factory waits in `state:owner` for an answer. See [the run comment](https://platform.test/c/9).",
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
      `👤 The factory waits in \`state:owner\` for an answer. To answer, apply \`state:ready\` at the unchanged approved contract to resume the stopped ${resume} run, \`state:triage\` to triage it again, \`state:carried\` to hold the request, or close the issue. A comment alone starts nothing. See [the run comment](https://platform.test/c/9).`,
    );
  // A triage run's owner stop leaves no work to resume.
  assert.equal(
    stop("state:owner", { triage: true }),
    "👤 The factory waits in `state:owner` for an answer. To answer, apply `state:triage` to triage it again, `state:carried` to hold the request, or close the issue. A comment alone starts nothing. See [the run comment](https://platform.test/c/9).",
  );
  // Without triage or a carried state, neither is named.
  const { carried: _, ...uncarried } = labels;
  assert.equal(
    stop("state:owner", { triage: false, resume: "implement" }, uncarried),
    "👤 The factory waits in `state:owner` for an answer. To answer, apply `state:ready` at the unchanged approved contract to resume the stopped implement run, or close the issue. A comment alone starts nothing. See [the run comment](https://platform.test/c/9).",
  );
  assert.equal(
    stop("state:reporter", { triage: true, resume: "implement" }),
    "👤 The factory waits in `state:reporter` for an answer. The reporter answers by replying here. A person may instead apply `state:triage` to triage it again, or close the issue. See [the run comment](https://platform.test/c/9).",
  );
  assert.equal(
    stop("state:grill", { triage: true }),
    "👤 The factory waits in `state:grill` for an answer. Once the grill settles the request, a person applies `state:triage` to triage it again, `state:ready` at a revised ticket's accepted revision, or closes the issue. A comment alone starts nothing. See [the run comment](https://platform.test/c/9).",
  );
  // A triage-state stop no trusted trigger answers names its re-application.
  assert.equal(
    stop("state:triage", {
      triage: true,
      reason: "no new trusted triage trigger",
    }),
    "👤 The factory waits in `state:triage` for an answer. With no new trusted triage trigger, a person must remove and re-apply `state:triage` to triage it again. An edit or a comment alone starts nothing. See [the run comment](https://platform.test/c/9).",
  );
  assert.equal(
    stop("state:triage", { triage: true }),
    "👤 The factory waits in `state:triage` for an answer. See [the run comment](https://platform.test/c/9).",
  );
  assert.equal(
    stop("state:grill", { triage: false }),
    "👤 The factory waits in `state:grill` for an answer. Once the grill settles the request, a person applies `state:ready` at a revised ticket's accepted revision, or closes the issue. A comment alone starts nothing. See [the run comment](https://platform.test/c/9).",
  );
});

test("the default close comment preserves local and cross-repository ticket references", () => {
  assert.equal(
    renderComment("close", undefined, { tickets: ["#4", "acme/other#8"] }),
    "All sub-issues are closed. Closing this parent.\n\n- #4\n- acme/other#8",
  );
});
