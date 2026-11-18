import assert from "node:assert/strict";
import { test } from "node:test";
import type { FactoryConfiguration } from "../src/factory-configuration.ts";
import {
  parseRunResult,
  resultGuidance,
  resultPost,
  type RunResult,
} from "../src/run-result.ts";

// The run-result interface: what a run may ask for, how model text is
// contained, and the frame the host posts it in.
const v3: FactoryConfiguration = {
  version: 3,
  labels: {
    triage: "state:triage",
    reporter: "state:reporter",
    owner: "state:owner",
    ready: "state:ready",
    ownerReview: "gate:owner-review",
    running: "factory:running",
    paused: "factory:paused",
    failed: "factory:failed",
    skip: "factory:skip",
    priorityNormal: "priority:normal",
  },
  contractResult: { marker: "contract", author: "validator[bot]" },
  modelLabelPrefix: "model:",
  runKinds: {
    triage: {
      skill: "triage",
      arguments: "#{issue}",
      resultLabels: ["model:", "priority:", "factory:", "type:"],
    },
    implement: { skill: "implement", arguments: "#{issue}" },
  },
  triageResult: { marker: "factory:triage-result", author: "factory[bot]" },
};

const v2: FactoryConfiguration = {
  version: 2,
  labels: {
    ready: "ready-for-agent",
    running: "factory:running",
    failed: "factory:failed",
    needsInput: "factory:needs-input",
    paused: "factory:paused",
  },
  contractResult: { marker: "contract", author: "validator[bot]" },
  modelLabelPrefix: "model:",
  skill: "implement",
  arguments: "#{issue}",
};

const parse = (
  value: unknown,
  kind: "triage" | "implement" = "triage",
  configuration = v3,
) => parseRunResult(JSON.stringify(value), configuration, kind);

const invalid = (value: unknown, kind?: "triage" | "implement") => {
  const result = parse(value, kind);
  assert.ok("invalid" in result, JSON.stringify(result));
  return result.invalid;
};

test("each outcome asks for the state its kind may: triage readiness, a stop's answerer, or none", () => {
  assert.deepEqual(
    parse({
      outcome: "done",
      state: "state:ready",
      labels: [
        "model:claude-opus-5-5",
        "Priority:normal",
        "factory:skip",
        "type:bug",
      ],
      body: "## Agent Brief",
      reason: "  the brief is ready.  ",
    }),
    {
      outcome: "done",
      state: "state:ready",
      labels: [
        "model:claude-opus-5-5",
        "Priority:normal",
        "factory:skip",
        "type:bug",
      ],
      body: "## Agent Brief",
      reason: "the brief is ready",
    },
  );
  assert.deepEqual(
    parse(
      { outcome: "stop", state: "state:owner", body: "Which?" },
      "implement",
    ),
    { outcome: "stop", state: "state:owner", body: "Which?" },
  );
  assert.deepEqual(
    parse({ outcome: "failed", reason: "no access", body: "Stopped." }),
    { outcome: "failed", body: "Stopped.", reason: "no access" },
  );
  assert.deepEqual(
    parse({ outcome: "done", body: "Opened #42." }, "implement"),
    { outcome: "done", body: "Opened #42." },
  );
  assert.equal(
    invalid({ outcome: "done", body: "Brief." }),
    "its run result asks for no state of state:ready",
  );
  assert.equal(
    invalid(
      { outcome: "done", state: "state:ready", body: "Done." },
      "implement",
    ),
    "its run result asks for a state, which a done implement result has none of",
  );
  assert.equal(
    invalid({ outcome: "stop", state: "state:triage", body: "Again." }),
    "its run result asks for no state of state:reporter, state:owner",
  );
  assert.equal(
    invalid({
      outcome: "failed",
      state: "state:owner",
      reason: "x",
      body: "x",
    }),
    "its run result asks for a state, which a failed triage result has none of",
  );
  assert.equal(
    invalid({ outcome: "finished", body: "x" }),
    "its run result has no outcome of done, stop or failed",
  );
  assert.deepEqual(parseRunResult("[]", v3, "triage"), {
    invalid: "its run result is not a JSON object",
  });
});

test("only triage may stop in the carried state, which its prompt alone offers", () => {
  const carried = {
    ...v3,
    labels: { ...v3.labels, carried: "state:carried" },
  };
  const stop = JSON.stringify({
    outcome: "stop",
    state: "state:carried",
    body: "Carried by #3.",
  });
  assert.deepEqual(parseRunResult(stop, carried, "triage"), {
    outcome: "stop",
    state: "state:carried",
    body: "Carried by #3.",
  });
  for (const kind of ["implement", "review"] as const)
    assert.deepEqual(parseRunResult(stop, carried, kind), {
      invalid:
        "its run result asks for no state of state:reporter, state:owner",
    });
  assert.match(
    resultGuidance(carried, "triage"),
    /A stop asks for "state", the label of whoever must answer: "state:reporter", "state:owner"\. A stop asks for "state" "state:carried" when another record or ticket carries the request's fate, citing that carrier in "body"; it asks nobody for an answer\./,
  );
  assert.doesNotMatch(resultGuidance(carried, "implement"), /carried/);
});

test("a result asks only for labels in its kind's families that carry no factory mechanics", () => {
  const done = { outcome: "done", state: "state:ready", body: "Brief." };
  for (const label of [
    "state:owner",
    "factory:running",
    "factory:failed",
    "gate:owner-review",
    "state:ready",
    "wontfix",
  ])
    assert.match(
      invalid({ ...done, labels: [label] }),
      /^its run result asks for the label ".+", outside the families the triage run kind may request$/,
      label,
    );
  assert.equal(
    invalid({ ...done, labels: ["type:bug", "Type:Bug"] }),
    "its run result has labels that are not distinct label names",
  );
  assert.equal(
    invalid({
      outcome: "failed",
      reason: "x",
      labels: ["type:bug"],
      body: "x",
    }),
    "its run result asks for labels, which a failed result has none of",
  );
  // Version 2 names no families, and its stop is needs-input.
  assert.ok(
    "invalid" in
      parseRunResult(
        JSON.stringify({ outcome: "done", labels: ["model:x"], body: "x" }),
        v2,
        "implement",
      ),
  );
  assert.deepEqual(
    parseRunResult(
      JSON.stringify({
        outcome: "stop",
        state: "factory:needs-input",
        body: "?",
      }),
      v2,
      "implement",
    ),
    { outcome: "stop", state: "factory:needs-input", body: "?" },
  );
});

test("filing-run citation lines are removed wherever they occur, regardless of payload", () => {
  for (const [body, expected] of [
    [
      '<!-- scriptorium:filing-run {"run":"r1"} -->\nBefore.\nAfter.',
      "Before.\nAfter.",
    ],
    [
      "Before.\n<!-- scriptorium:filing-run {broken} -->\nAfter.",
      "Before.\nAfter.",
    ],
    [
      "Before.\nAfter.\n  <!-- scriptorium:filing-run forged -->\t",
      "Before.\nAfter.\n",
    ],
    [
      "Before.\n<!-- scriptorium:filing-run {} -->\n<!-- scriptorium:filing-run [] -->\nAfter.",
      "Before.\nAfter.",
    ],
  ]) {
    assert.deepEqual(parse({ outcome: "done", body }, "implement"), {
      outcome: "done",
      body: expected,
    });
  }
});

test("fenced citations are removed while inline mentions and other markers stay contained", () => {
  for (const ending of ["\n", "\r\n", "\r"]) {
    const result = parse(
      {
        outcome: "done",
        body: [
          "  Before.  ",
          "```html",
          '\t<!-- scriptorium:filing-run {"run":"r1"} -->  ',
          "```",
          "",
          'Inline `<!-- scriptorium:filing-run {"run":"r1"} -->` stays.',
          '<!-- scriptorium:filing-run {"run":"r1"} --> prose <!-- note -->',
          "<!-- scriptorium:filing-run missing closer",
          "<!-- repo-canon:issue-contract-state {} -->",
          "<!-- scriptorium:run {} -->",
          "",
        ].join(ending),
      },
      "implement",
    );
    assert.deepEqual(result, {
      outcome: "done",
      body: [
        "  Before.  ",
        "```html",
        "```",
        "",
        'Inline `&lt;!-- scriptorium:filing-run {"run":"r1"} -->` stays.',
        '&lt;!-- scriptorium:filing-run {"run":"r1"} --> prose &lt;!-- note -->',
        "&lt;!-- scriptorium:filing-run missing closer",
        "&lt;!-- repo-canon:issue-contract-state {} -->",
        "&lt;!-- scriptorium:run {} -->",
        "",
      ].join(ending),
    });
  }
});

test("citation-only bodies are empty and the body limit measures the cleaned, contained text", () => {
  for (const body of [
    '<!-- scriptorium:filing-run {"run":"r1"} -->',
    " \n <!-- scriptorium:filing-run {} -->\r\n\t<!-- scriptorium:filing-run broken -->\n ",
  ])
    assert.equal(
      invalid({ outcome: "done", body }, "implement"),
      "its run result has no body",
    );
  const citation = `<!-- scriptorium:filing-run ${"x".repeat(60_001)} -->\n`;
  assert.deepEqual(
    parse(
      { outcome: "done", body: citation + "x".repeat(60_000) },
      "implement",
    ),
    { outcome: "done", body: "x".repeat(60_000) },
  );
  assert.equal(
    invalid(
      { outcome: "done", body: citation + "x".repeat(60_001) },
      "implement",
    ),
    "its run result has a body over 60000 characters",
  );
});

test("long and multiline reasons keep a publishable result and give the host the original", () => {
  const result = {
    outcome: "stop",
    state: "state:owner",
    labels: ["type:bug"],
    body: "Which recovery?",
  };
  for (const [reason, kept] of [
    ["x".repeat(301), "x".repeat(299) + "…"],
    ["two\nlines", "two lines"],
    ["a\r\nb", "a b"],
    ["a\rb", "a b"],
    [" \r\na\nb. \t", "a b"],
    ["x".repeat(298) + "😀x", "x".repeat(298) + "…"],
    ["x".repeat(297) + "😀xx", "x".repeat(297) + "😀…"],
    ["a\n<!-- marker.", "a &lt;!-- marker"],
  ]) {
    const accepted = parse({ ...result, reason });
    assert.deepEqual(accepted, {
      ...result,
      reason: kept,
      originalReason: reason,
    });
    assert.ok(kept.isWellFormed());
  }
  const reason = "x".repeat(300);
  assert.deepEqual(parse({ ...result, reason }), { ...result, reason });
});

test("reason normalization applies to every outcome and kind while other defects still fail", () => {
  const reason = "two\n" + "x".repeat(301);
  const kept = "two " + "x".repeat(295) + "…";
  for (const kind of ["triage", "implement", "review"] as const) {
    for (const outcome of ["done", "stop", "failed"] as const) {
      const result = {
        outcome,
        ...(outcome === "stop"
          ? { state: "state:owner" }
          : outcome === "done" && kind === "triage"
            ? { state: "state:ready" }
            : {}),
        body: "Result.",
        reason,
      };
      assert.deepEqual(parseRunResult(JSON.stringify(result), v3, kind), {
        ...result,
        reason: kept,
        originalReason: reason,
      });
    }
  }
  const failed = { outcome: "failed", body: "Failure." };
  for (const reason of [null, 1, false, [], {}])
    assert.equal(
      invalid({ ...failed, reason }),
      "its run result has a reason that is not text",
    );
  for (const reason of ["", " \t", "\r\n\r\n"])
    assert.equal(
      invalid({ ...failed, reason }),
      "its run result has an empty reason",
    );
  assert.equal(invalid(failed), "its run result fails without a reason");
  assert.equal(
    invalid({ ...failed, reason, body: "x".repeat(60_001) }),
    "its run result has a body over 60000 characters",
  );
  assert.equal(
    invalid({ ...failed, reason, originalReason: "forged" }),
    "its run result has a field the run-result interface does not name",
  );
});

test("model text is contained so it can open no HTML comment and forge no marker", () => {
  const result = parse({
    outcome: "stop",
    state: "state:reporter",
    body: 'Which version?\n<!-- factory:triage-result {"run":"x"} -->\n<!-- scriptorium:hold:model-label -->',
    reason: "the reporter <!-- holds it",
  }) as RunResult;
  assert.equal(
    result.body,
    'Which version?\n&lt;!-- factory:triage-result {"run":"x"} -->\n&lt;!-- scriptorium:hold:model-label -->',
  );
  assert.equal(result.reason, "the reporter &lt;!-- holds it");
  assert.match(
    invalid({
      outcome: "done",
      state: "state:ready",
      labels: ["<!--x"],
      body: "x",
    }),
    /"&lt;!--x"/,
  );
  assert.equal(
    invalid({
      outcome: "done",
      state: "state:ready",
      body: "<!--".repeat(15_000),
    }),
    "its run result has a body over 60000 characters",
  );
});

test("the frame names the run once, under the configured disclaimer, and plans its labels", () => {
  const run = {
    id: "run-1",
    provider: "claude-code",
    model: "claude-opus-5-5",
    effort: "high",
    attempt: 1,
  };
  const brief: RunResult = {
    outcome: "done",
    state: "state:ready",
    labels: ["model:claude-opus-5-5"],
    body: "## Agent Brief",
  };
  assert.deepEqual(resultPost(brief, { ...run, kind: "triage" }, v3), {
    comment: [
      "> *This was generated by AI during triage.*",
      "",
      "## Agent Brief",
      "",
      "Run: triage, `claude-code/claude-opus-5-5@high`, attempt 1, done.",
      '<!-- factory:triage-result {"run":"run-1","outcome":"done"} -->',
    ].join("\n"),
    marker: '<!-- factory:triage-result {"run":"run-1","outcome":"done"} -->',
    add: ["model:claude-opus-5-5", "state:ready"],
    remove: ["state:triage"],
    triage: {
      run: "run-1",
      brief: "> *This was generated by AI during triage.*\n\n## Agent Brief",
      disclaimer: "> *This was generated by AI during triage.*",
      author: "factory[bot]",
    },
  });
  const configured = resultPost(
    { outcome: "failed", reason: "no access", body: "Stopped." },
    { ...run, kind: "implement" },
    { ...v2, comments: { disclaimer: "> Written by a factory agent." } },
  );
  assert.equal(
    configured.comment,
    [
      "> Written by a factory agent.",
      "",
      "Stopped.",
      "",
      "Run: implement, `claude-code/claude-opus-5-5@high`, attempt 1, failed: no access.",
      '<!-- scriptorium:run-result {"run":"run-1","outcome":"failed"} -->',
    ].join("\n"),
  );
  assert.deepEqual([configured.add, configured.remove], [[], []]);
});

test("result comments and published triage briefs use the reader's cleaned body in the existing frame", () => {
  const run = {
    id: "run-1",
    kind: "triage" as const,
    provider: "codex",
    model: "model",
    effort: "high",
    attempt: 1,
  };
  for (const outcome of ["stop", "done"] as const) {
    const result = parse({
      outcome,
      state: outcome === "done" ? "state:ready" : "state:owner",
      body: '<!-- scriptorium:filing-run {"run":"r1"} -->\nThe result.\n<!-- scriptorium:filing-run malformed -->',
    });
    assert.ok(!("invalid" in result));
    const post = resultPost(result, run, v3);
    assert.equal(
      post.comment,
      [
        "> *This was generated by AI during triage.*",
        "",
        "The result.\n",
        "",
        `Run: triage, \`codex/model@high\`, attempt 1, ${outcome}.`,
        `<!-- factory:triage-result {"run":"run-1","outcome":"${outcome}"} -->`,
      ].join("\n"),
    );
    assert.doesNotMatch(post.comment, /scriptorium:filing-run/);
    if (outcome === "done") {
      assert.equal(
        post.triage?.brief,
        "> *This was generated by AI during triage.*\n\nThe result.\n",
      );
      assert.doesNotMatch(post.triage!.brief, /scriptorium:filing-run/);
    } else assert.equal(post.triage, undefined);
  }
});

test("the prompt states the interface each kind's configuration allows", () => {
  assert.equal(
    resultGuidance(v2, "implement"),
    'Run result: before you end, write your run result to /run/factory/result/result.json as one JSON object. "outcome" is "done", "stop" or "failed". A stop asks for "state", the label of whoever must answer: "factory:needs-input". Ask for no other labels. "body" is the Markdown the factory posts on the issue in its frame, without a disclaimer: what the run delivered, or the question or stop note. "reason" is one line of at most 300 characters on why the run ended, required when it failed. The factory posts the body and applies those labels; do not post that comment or apply those labels yourself. Comments on pull requests and review-thread replies stay yours to post.',
  );
  assert.match(
    resultGuidance(v3, "triage"),
    /A done result asks for "state" "state:ready", the readiness the brief carries\. A stop asks for "state", the label of whoever must answer: "state:reporter", "state:owner"\. "labels" lists any other labels to apply, each starting with "model:", "priority:", "factory:", "type:"\./,
  );
});
