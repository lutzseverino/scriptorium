import assert from "node:assert/strict";
import { test } from "node:test";
import { renderComment } from "../src/comment-template.ts";

test("comment templates substitute facts and conditionally render scalar sections", () => {
  const template =
    "{provider}: {cause}{#reset}, resets {reset}{/reset}{#threshold} at {threshold}%{/threshold}; {model}";
  assert.equal(
    renderComment("pause", template, {
      provider: "codex",
      cause: "usage limit",
      reset: "17:00 UTC",
    }),
    "codex: usage limit, resets 17:00 UTC; ",
  );
  assert.equal(
    renderComment("pause", template, {
      provider: "codex",
      cause: "pause threshold",
      reset: null,
      threshold: 0,
    }),
    "codex: pause threshold at 0%; ",
  );
});

test("list sections repeat with the current item and retain surrounding scalar facts", () => {
  const template =
    "{#unpushableCount}{unpushableCount} paths:\n{#unpushable}{#label}{label}: {/label}{unpushable}\n{/unpushable}Deliver once.{/unpushableCount}";
  assert.equal(
    renderComment("failure", template, {
      unpushable: ["a.yml", "b.yml"],
      unpushableCount: 2,
      label: "broken",
    }),
    "2 paths:\nbroken: a.yml\nbroken: b.yml\nDeliver once.",
  );
  assert.equal(renderComment("failure", template, { unpushable: [] }), "");
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
    renderComment("pause", '{ "a": 1 } {} {model_name} {model2} { model }', {}),
    '{ "a": 1 } {} {model_name} {model2} { model }',
  );
  assert.equal(
    renderComment("pause", "{{provider}} \\{provider}", { provider: "codex" }),
    "{codex} \\codex",
  );
  assert.equal(
    renderComment("pause", "A fixed comment.", {}),
    "A fixed comment.",
  );
});

test("unknown names and unbalanced sections are invalid even inside an empty section", () => {
  for (const template of [
    "{failure}",
    "{#tickets}x{/tickets}",
    "{#reset}{unknown}{/reset}",
    "{/reset}",
    "{#reset}",
    "{#reset}{#model}{/reset}{/model}",
  ])
    assert.throws(
      () => renderComment("pause", template, {}),
      /unknown name|unbalanced section/,
    );
});

test("the default failure comment preserves its wording with and without available details", () => {
  assert.equal(
    renderComment("failure", undefined, { failure: "no run", label: "broken" }),
    "The factory run failed: no run.\n\nRemove `broken` to let the factory pick this issue up again.",
  );
  assert.equal(
    renderComment("failure", undefined, {
      failure: "stopped",
      label: "broken",
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
      attempt: 2,
      log: "/host/run.log",
      unpushable: ["a.yml", "b.yml"],
      unpushableCount: 2,
    }),
    "The factory run failed: stopped.\n\n- Model: `codex/gpt-5.5@high`, attempt 2\n- Log: `/host/run.log` on the factory host\n\n- Unpushable: `a.yml`\n- Unpushable: `b.yml`\n\nA person with permission to push these paths must deliver the change.\n\nRemove `broken` to let the factory pick this issue up again.",
  );
  assert.equal(
    renderComment("failure", undefined, {
      failure: "stopped",
      label: "broken",
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
      attempt: 1,
    }),
    "The factory run failed: stopped.\n\n- Model: `codex/gpt-5.5@high`, attempt 1\n\nRemove `broken` to let the factory pick this issue up again.",
  );
});

test("default pause comments preserve both causes and omit absent resets", () => {
  const facts = {
    provider: "codex",
    model: "gpt-5.5",
    effort: "high",
    attempt: 1,
    label: "waiting",
  };
  assert.equal(
    renderComment("pause", undefined, {
      ...facts,
      cause: "usage limit",
      reset: null,
    }),
    "The factory paused this run: codex usage limit.\n\n- Model: `codex/gpt-5.5@high`, attempt 1\n\nThe factory resumes the run by itself and removes `waiting` when it does; nobody needs to act.",
  );
  assert.equal(
    renderComment("pause", undefined, {
      ...facts,
      cause: "pause threshold",
      reset: "15:00 UTC",
      threshold: 95,
    }),
    "The factory paused this run: codex pause threshold, resets 15:00 UTC.\n\n- Model: `codex/gpt-5.5@high`, attempt 1\n\nThe factory resumes the run by itself and removes `waiting` when it does; nobody needs to act.",
  );
});

test("the default close comment preserves local and cross-repository ticket references", () => {
  assert.equal(
    renderComment("close", undefined, { tickets: ["#4", "acme/other#8"] }),
    "All sub-issues are closed. Closing this parent.\n\n- #4\n- acme/other#8",
  );
});
