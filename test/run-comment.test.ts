import assert from "node:assert/strict";
import { test } from "node:test";
import type { Account, Comment, IssueTracker } from "@lutzseverino/postern";
import {
  isFactoryComment,
  issueComments,
  passContinuation,
  summaryLine,
  type RunUpdate,
} from "../src/run-comment.ts";
import { parseRunResult } from "../src/run-result.ts";

// The run comment writer over a fake issue tracker that keeps one issue's
// comments, written by the factory's bot account, and its author, and fails
// the writes the test asks it to.
function tracker(existing: Comment[] = []) {
  const comments = [...existing];
  const writes: string[] = [];
  const failing = new Set<string>();
  const issue: { author: Account | null | Error } = {
    author: { login: "reporter", bot: false },
  };
  let next = 100;
  const fake = {
    async issue() {
      if (issue.author instanceof Error) throw issue.author;
      return { author: issue.author };
    },
    async comments() {
      return comments.map((comment) => ({ ...comment }));
    },
    async createComment(_issue: number, body: string) {
      writes.push("create");
      if (failing.has("create")) throw new Error("create failed");
      const comment: Comment = {
        id: next,
        nodeId: `IC_${next}`,
        url: `https://platform.test/c/${next++}`,
        author: { login: "factory[bot]", bot: true },
        body,
        createdAt: "2026-11-08T00:00:00Z",
        updatedAt: "2026-11-08T00:00:00Z",
      };
      comments.push(comment);
      return { ...comment };
    },
    async updateComment(id: number, body: string) {
      writes.push("update");
      if (failing.has("update")) throw new Error("update failed");
      const comment = comments.find((comment) => comment.id === id)!;
      comment.body = body;
      return { ...comment };
    },
  } as unknown as IssueTracker;
  return { tracker: fake, comments, writes, failing, issue };
}

const configuration = {
  labels: {
    ready: "ready",
    running: "running",
    paused: "paused",
    failed: "failed",
  },
  contractResult: { marker: "contract", author: "validator[bot]" },
  runKinds: { review: { skill: "review", arguments: "" } },
};
const run = (comment: Comment) =>
  comment.body.split("\n").at(-1)!.startsWith("<!-- scriptorium:run ");
const action = (comment: Comment) =>
  comment.body.split("\n").at(-1)!.startsWith("<!-- scriptorium:action ");
const facts = {
  provider: "codex",
  model: "gpt-5.5",
  effort: "high",
  attempt: 1,
};
// The default run comment's parts: its lead line, pipeline line, outcome
// lines and footer.
const lead = (body: string) => body.split("\n")[0];
const pipeline = (body: string) =>
  body.split("\n").find((line) => line.includes(" → Merge")) ??
  body.split("\n").find((line) => line.endsWith(" Merge"));
const outcomes = (body: string) =>
  body.split("\n").filter((line) => /^\*\*\w+:\*\* /.test(line));
const footer = (body: string) =>
  body.split("\n").find((line) => line.startsWith("<sub>"));

test("summaries remove emphasis outside code and preserve escaped and intraword delimiters", () => {
  for (const marked of ["*a*", "_a_", "**a**", "__a__", "***a***", "~~a~~"])
    assert.equal(summaryLine(marked), "a");
  assert.equal(summaryLine("**a _nested_ ~~sentence~~**"), "a nested sentence");
  const literal = "`*a* _a_ **a** __a__ ***a*** ~~a~~` \\*a\\* snake_case";
  assert.equal(summaryLine(literal), literal);
  assert.equal(summaryLine(`**${"x".repeat(100)}**`), "x".repeat(100));
  assert.equal(summaryLine(`**${"😀".repeat(101)}**`), `${"😀".repeat(99)}…`);
});

test("a summary drops a whole code span, link or image when its cut would split it", () => {
  for (const span of [
    "`code *and* _delimiters_`",
    "``code with ` inside``",
    "[label](https://example.test/a_(b))",
    "[label](<https://example.test/a)b>)",
    '[label](https://example.test/a "title (with parentheses)")',
    "[label][reference]",
    "[label with `]` code](https://example.test/a)",
    "<https://example.test/a_b>",
    "![image](https://example.test/picture.png)",
    "![image][reference]",
  ]) {
    // Exercise cuts in the label, destination, title and closing delimiters.
    for (let inside = 1; inside < [...span].length; inside++) {
      const before = `${"x".repeat(98 - inside)} `;
      assert.equal(
        summaryLine(`${before}${span} trailing text`),
        `${before}…`,
        span,
      );
    }
    assert.equal(summaryLine(`Before ${span}`), `Before ${span}`, span);
  }
  assert.equal(
    summaryLine(`${"x".repeat(95)} \`a\`more`),
    `${"x".repeat(95)} \`a\`…`,
  );
  assert.equal(
    summaryLine("[**bold** and `*code*`](https://example.test/a_b)"),
    "[bold and `*code*`](https://example.test/a_b)",
  );
  assert.equal(summaryLine(`before \`unclosed`), "before …");
});

// Repo Canon #1251's result lead line, as posted on 2026-11-25.
const rejectedRevision =
  "`sha256:f30c61050bdd1f48530b6298a8f7e20e147646a7d70a56982d91ffb0b9616c20`";
const rejectedLead = `**Not accepted: revision ${rejectedRevision} leaves three owner-intent questions open, so it waits on a grill.**`;

test("the reported lead line stays well formed in default run and action comments", async () => {
  const summary = `Not accepted: revision ${rejectedRevision} le…`;
  assert.equal(summaryLine(rejectedLead), summary);
  assert.equal([...summary].length, 100);
  assert.doesNotMatch(summary, /\*/);
  const fake = tracker();
  await issueComments(fake.tracker, {
    ...configuration,
    comments: { mention: ["owner"] },
  }).write(
    4,
    {
      phase: "triage",
      facts: { state: "stopped", reason: "waits in `owner`" },
      result: { body: rejectedLead },
      mention: "maintainers",
    },
    { key: "stop:a", stopped: "owner" },
  );
  const runBody = fake.comments.find(run)!.body;
  assert.deepEqual(outcomes(runBody), [
    `**Triage:** ${summary} · waits in \`owner\``,
  ]);
  assert.ok(runBody.includes(`> [!IMPORTANT]\n> @owner: ${summary}\n`));
  const actionBody = fake.comments.find(action)!.body;
  assert.equal(actionBody.match(/\*\*/g)?.length, 2);
  assert.ok(actionBody.startsWith(`👤 **@owner, ${summary}** `));
});

test("the next write normalizes every saved summary, including older partial code spans", async () => {
  for (const [stored, expected] of [
    [
      `**Not accepted: revision ${rejectedRevision} …`,
      `Not accepted: revision ${rejectedRevision} …`,
    ],
    [
      "**Not accepted: revision `sha256:f30c61050bdd1f48530b6298a8f7e20e147646a7d70a56982d91ffb0b9616c…",
      "Not accepted: revision …",
    ],
  ]) {
    const fake = tracker([
      {
        id: 1,
        nodeId: "IC_1",
        url: "https://platform.test/c/1",
        author: { login: "factory[bot]", bot: true },
        body: `Old run\n<!-- scriptorium:run ${JSON.stringify({
          phases: {
            triage: { state: "stopped", summary: stored },
            review: { state: "done", summary: "**Earlier review**" },
          },
        })} -->`,
        createdAt: "2026-11-08T00:00:00Z",
        updatedAt: "2026-11-08T00:00:00Z",
      },
    ]);
    const { write } = issueComments(fake.tracker, {
      ...configuration,
      comments: { mention: ["owner"] },
    });
    await write(
      4,
      { phase: "triage", facts: { state: "stopped" }, mention: "maintainers" },
      { key: "stop:migrated", stopped: "owner" },
    );
    const body = fake.comments.find(run)!.body;
    assert.deepEqual(outcomes(body), [
      `**Triage:** ${expected}`,
      "**Review:** Earlier review",
    ]);
    assert.ok(body.includes(`> @owner: ${expected}\n`));
    assert.ok(
      fake.comments
        .find(action)!
        .body.startsWith(`👤 **@owner, ${expected}** `),
    );
    const state = JSON.parse(
      body.split("\n").at(-1)!.slice("<!-- scriptorium:run ".length, -4),
    );
    assert.equal(state.phases.triage.summary, expected);
    assert.equal(state.phases.review.summary, "Earlier review");
    await write(4, {
      phase: "triage",
      facts: { state: "stopped" },
      mention: "maintainers",
    });
    assert.equal(fake.comments.find(run)!.body, body);
  }
});

test("a stand-in launch names the chosen model, actual model and reason in the run comment", async () => {
  const fake = tracker();
  const { write } = issueComments(fake.tracker, configuration);
  await write(4, {
    phase: "implement",
    facts: {
      ...facts,
      state: "running",
      provider: "claude-code",
      model: "claude-broad",
      standIn: {
        chosen: "codex/gpt-narrow",
        reason: { kind: "spare usage", used: 31, elapsed: 45 },
      },
    },
  });
  // The footer names the chosen model and the reason after the model that ran.
  assert.match(
    footer(fake.comments[0].body)!,
    /· `claude-code\/claude-broad@high`, stand-in for `codex\/gpt-narrow`: spare usage \(31% used, 45% elapsed\), attempt 1 ·/,
  );
  await write(4, {
    phase: "implement",
    facts: {
      standIn: {
        chosen: "codex/gpt-narrow",
        reason: {
          kind: "chosen provider cannot launch",
          reason: "codex already runs its cap of 1 agent",
        },
      },
    },
  });
  assert.match(
    footer(fake.comments[0].body)!,
    /stand-in for `codex\/gpt-narrow`: chosen provider cannot launch \(codex already runs its cap of 1 agent\)/,
  );
  // A later fresh attempt that didn't stand in clears the earlier explanation.
  await write(4, {
    phase: "implement",
    facts: { ...facts, state: "running", standIn: undefined },
  });
  assert.doesNotMatch(fake.comments[0].body, /stand-in|chosen|elapsed/);
  // A custom template still places the stand-in note and round itself.
  const custom = tracker();
  await issueComments(custom.tracker, {
    ...configuration,
    comments: { run: "{#review}{standIn}; round {round}{/review}" },
  }).write(4, {
    phase: "review",
    facts: {
      ...facts,
      state: "running",
      round: 2,
      standIn: {
        chosen: "codex/gpt-narrow",
        reason: { kind: "spare usage", used: 31, elapsed: 45 },
      },
    },
  });
  assert.match(
    custom.comments[0].body,
    /^stand-in for `codex\/gpt-narrow`: spare usage \(31% used, 45% elapsed\); round 2\n/,
  );
});

test("a pass through every phase leaves one run comment, edited in place, and acts only when a person must", async () => {
  const fake = tracker();
  const { write } = issueComments(fake.tracker, configuration);
  await write(4, { phase: "triage", facts: { ...facts, state: "running" } });
  await write(
    4,
    {
      phase: "triage",
      facts: { state: "stopped", reason: "waits in `reporter`" },
    },
    { key: "stop:a", stopped: "reporter" },
  );
  // Each pass that finds the stop again tells nobody again.
  await write(
    4,
    {
      phase: "triage",
      facts: { state: "stopped", reason: "waits in `reporter`" },
    },
    { key: "stop:a", stopped: "reporter" },
  );
  await write(4, {
    phase: "triage",
    facts: { state: "done", link: "https://platform.test/r/1" },
    result: { body: "The brief." },
  });
  await write(4, { phase: "implement", facts: { ...facts, state: "running" } });
  await write(4, {
    phase: "implement",
    facts: { state: "paused", reason: "usage limit", reset: null },
  });
  await write(4, {
    phase: "implement",
    facts: { ...facts, state: "running", reason: undefined, reset: undefined },
  });
  await write(4, { phase: "implement", facts: { state: "done" } });
  await write(4, {
    phase: "review",
    facts: { ...facts, provider: "claude-code", state: "running", round: 1 },
  });
  await write(4, { phase: "merge", facts: { state: "merged" }, final: true });
  assert.equal(fake.comments.filter(run).length, 1);
  assert.equal(fake.comments.filter(action).length, 1);
  assert.match(
    fake.comments.find(action)!.body,
    /^👤 The factory waits in `reporter` for an answer\. See \[the run comment\]\(https:\/\/platform\.test\/c\/100\)\.\n/,
  );
  const body = fake.comments.find(run)!.body;
  assert.equal(lead(body), "### ✅ Merged");
  // The merge finishes the review it ended.
  assert.equal(
    pipeline(body),
    "✅ Triage → ✅ Implement → ✅ Review → ✅ Merge",
  );
  assert.deepEqual(outcomes(body), [
    "**Triage:** The brief. · [result](https://platform.test/r/1)",
  ]);
  assert.doesNotMatch(body, /paused|usage limit|- \[[ x]\]|<details>/);
  assert.match(
    body,
    /\n<sub>Factory run, edited in place · updated \d\d:\d\dZ<\/sub>\n<!-- scriptorium:run /,
  );
});

test("a person who must act is mentioned in the run comment's lead line and alert and in the action", async () => {
  // A stop that asks the owner, after its run left a result.
  const stop = async (
    write: ReturnType<typeof issueComments>["write"],
    mention: RunUpdate["mention"],
    key: string,
  ) => {
    await write(4, {
      phase: "triage",
      facts: { ...facts, state: "running" },
    });
    await write(4, {
      phase: "triage",
      facts: { link: "https://platform.test/r/1" },
      result: { body: "## Should the client call v2?\n\nDetails." },
    });
    await write(
      4,
      {
        phase: "triage",
        facts: { state: "stopped", reason: "waits in `owner`", waits: "owner" },
        mention,
      },
      { key, stopped: "owner" },
    );
  };
  const configured = {
    ...configuration,
    labels: { ...configuration.labels, owner: "owner" },
  };
  // A user owner by default.
  const owned = tracker();
  const { write } = issueComments(
    owned.tracker,
    configured,
    undefined,
    undefined,
    async () => "octo",
  );
  await stop(write, "maintainers", "stop:a");
  const body = owned.comments.find(run)!.body;
  assert.equal(lead(body), "### 👤 Waiting for an answer · @octo must act");
  assert.equal(
    body.split("\n").slice(1, 5).join("\n"),
    "\n> [!IMPORTANT]\n> @octo: Should the client call v2?\n",
  );
  // The action leads with its marker, mention and summary, keeps its answer
  // sentence and ends with the run comment's link.
  assert.equal(
    owned.comments.find(action)!.body.split("\n")[0],
    "👤 **@octo, Should the client call v2?** The factory waits in `owner` for an answer. See [the run comment](https://platform.test/c/100).",
  );
  // Once work resumes, nobody must act.
  await write(4, {
    phase: "implement",
    facts: { ...facts, state: "running" },
  });
  const resumed = owned.comments.find(run)!.body;
  assert.equal(lead(resumed), "### 🔄 Implementing");
  assert.doesNotMatch(resumed, /@octo|\[!IMPORTANT\]/);

  // Configured logins replace the owner, on one line.
  const listed = tracker();
  await stop(
    issueComments(
      listed.tracker,
      { ...configured, comments: { mention: ["alice", "@bob"] } },
      undefined,
      undefined,
      async () => "octo",
    ).write,
    "maintainers",
    "stop:a",
  );
  assert.match(
    listed.comments.find(action)!.body,
    /^👤 \*\*@alice, @bob, Should the client call v2\?\*\* /,
  );
  assert.equal(
    lead(listed.comments.find(run)!.body),
    "### 👤 Waiting for an answer · @alice, @bob must act",
  );

  // A reporter stop mentions the issue's author, never a bot.
  const reported = tracker();
  await stop(
    issueComments(
      reported.tracker,
      configured,
      undefined,
      undefined,
      async () => "octo",
    ).write,
    "author",
    "stop:a",
  );
  assert.match(reported.comments.find(action)!.body, /^👤 \*\*@reporter, /);
  const filed = tracker();
  filed.issue.author = { login: "factory[bot]", bot: true };
  await stop(
    issueComments(
      filed.tracker,
      configured,
      undefined,
      undefined,
      async () => "octo",
    ).write,
    "author",
    "stop:a",
  );
  assert.match(filed.comments.find(action)!.body, /^👤 The factory waits in /);

  // An organization owner, an empty list, a failed read or nobody asked:
  // no mention and no alert.
  for (const [owner, comments, mention, read] of [
    [async () => undefined, undefined, "maintainers", undefined],
    [async () => "octo", { mention: [] }, "maintainers", undefined],
    [
      async () => {
        throw new Error("owner read failed");
      },
      undefined,
      "maintainers",
      undefined,
    ],
    [async () => "octo", undefined, "author", new Error("issue read failed")],
    [async () => "octo", undefined, undefined, undefined],
  ] as const) {
    const nobody = tracker();
    if (read) nobody.issue.author = read;
    await stop(
      issueComments(
        nobody.tracker,
        {
          ...configured,
          ...(comments && { comments: { mention: [...comments.mention] } }),
        },
        undefined,
        undefined,
        owner,
      ).write,
      mention,
      "stop:a",
    );
    const unmentioned = nobody.comments.find(run)!.body;
    assert.equal(lead(unmentioned), "### 👤 Waiting for an answer");
    assert.doesNotMatch(unmentioned, /@(?!high)|\[!IMPORTANT\]/);
    assert.match(
      nobody.comments.find(action)!.body,
      /^👤 The factory waits in `owner` for an answer\. See /,
    );
  }
});

test("outside a phase a custom template reads the written phase's facts, which no other phase shows as its own", async () => {
  const fake = tracker();
  await issueComments(fake.tracker, {
    ...configuration,
    comments: {
      run: "{state} {provider}|{#implement}{state}{#provider} provider={provider}{/provider}{#reason} {reason}{/reason}{/implement}|{#merge}{state}: {reason}{/merge}",
    },
  }).write(4, {
    phase: "merge",
    facts: { ...facts, state: "failed", reason: "its pull request closed" },
  });
  assert.equal(
    fake.comments[0].body.split("\n")[0],
    "failed codex||failed: its pull request closed",
  );
});

test("a custom template reads the pass's and each phase's markers, the failure and the pause", async () => {
  const template =
    "{icon} {status}{#failure} failure={failure}{/failure}{#pause} pause={pause}{/pause}|{#implement}{icon}{#summary} {summary}{/summary}{/implement}|{#review}{icon}{/review}";
  const cases: [RunUpdate, string][] = [
    [
      { phase: "implement", facts: { ...facts, state: "running" } },
      "🔄 Implementing|🔄|⬜",
    ],
    [
      {
        phase: "implement",
        facts: { state: "failed", reason: "no pull request" },
        result: { body: "## Tests fail" },
      },
      "❌ Failed failure=no pull request|❌ Tests fail|⬜",
    ],
    [
      {
        phase: "implement",
        facts: { state: "paused", reason: "usage limit", reset: "18:00Z" },
      },
      "⏸️ Paused pause=usage limit, resumes at 18:00Z|⏸️|⬜",
    ],
    [
      {
        phase: "implement",
        facts: { state: "paused", reason: "pause threshold", reset: null },
      },
      "⏸️ Paused pause=pause threshold|⏸️|⬜",
    ],
    // A failed or paused review leaves implement's facts its own.
    [
      {
        phase: "review",
        facts: { state: "paused", reason: "usage limit", reset: "18:00Z" },
      },
      "⏸️ Paused pause=usage limit, resumes at 18:00Z|⬜|⏸️",
    ],
  ];
  for (const [update, rendered] of cases) {
    const fake = tracker();
    await issueComments(fake.tracker, {
      ...configuration,
      comments: { run: template },
    }).write(4, update);
    assert.equal(fake.comments[0].body.split("\n")[0], rendered);
  }
});

test("a custom template reads each phase's outcome: its summary, its reason, or both", async () => {
  const fake = tracker();
  const { write } = issueComments(fake.tracker, {
    ...configuration,
    comments: {
      run: "{#triage}T={outcome}{/triage}|{#implement}I={outcome}{/implement}|{#review}R={outcome}{/review}",
    },
  });
  await write(4, {
    phase: "triage",
    facts: { state: "done", link: "https://platform.test/r/1" },
    result: { body: "Ready." },
  });
  await write(4, {
    phase: "implement",
    facts: {
      state: "stopped",
      reason: "waits in `owner`",
      link: "https://platform.test/r/2",
    },
    result: { body: "Which version?" },
  });
  await write(4, {
    phase: "review",
    facts: { state: "paused", reason: "usage limit" },
  });
  assert.equal(
    fake.comments[0].body.split("\n")[0],
    "T=Ready.|I=Which version? · waits in `owner`|R=usage limit",
  );
});

test("a phase linked to its result before summaries were kept reads its summary from that result's comment", async () => {
  // The marker an earlier version wrote: no summaries, and the latest
  // result's body between the run-body markers.
  const earlier = {
    phases: {
      triage: { state: "done", link: "https://platform.test/c/1" },
      implement: { state: "done", link: "https://platform.test/c/2" },
      review: { state: "done", link: "https://platform.test/c/9" },
    },
  };
  const comment = (id: number, body: string): Comment => ({
    id,
    nodeId: `IC_${id}`,
    url: `https://platform.test/c/${id}`,
    author: { login: "factory[bot]", bot: true },
    body,
    createdAt: "2026-11-08T00:00:00Z",
    updatedAt: "2026-11-08T00:00:00Z",
  });
  const fake = tracker([
    // A result in the frame with a leading disclaimer and a `Run:` line.
    comment(
      1,
      '> *This was generated by AI during triage.*\n\n## Accepted ##\n\nThe brief.\n\nRun: triage, `codex/gpt-5.5@high`, attempt 1, done.\n<!-- scriptorium:run {"run":"r1","outcome":"done"} -->',
    ),
    // A result in the footer frame.
    comment(
      2,
      '✅ **Draft PR #7** · checks green\n\n<sub>Generated by AI · implement, `codex/gpt-5.5@high`, attempt 1, done</sub>\n<!-- scriptorium:run-result {"run":"r2","outcome":"done"} -->',
    ),
    comment(
      3,
      `**Factory run: in progress**\n<!-- scriptorium:run-body -->\nDraft PR\n<!-- /scriptorium:run-body -->\n<!-- scriptorium:run ${JSON.stringify(earlier)} -->`,
    ),
  ]);
  await issueComments(fake.tracker, configuration).write(4, {
    phase: "merge",
    facts: { state: "awaiting merge" },
  });
  const body = fake.comments[2].body;
  // A link to no result comment on the issue gives no summary to show.
  assert.deepEqual(outcomes(body), [
    "**Triage:** Accepted · [result](https://platform.test/c/1)",
    "**Implement:** ✅ Draft PR #7 · checks green · [result](https://platform.test/c/2)",
  ]);
  assert.match(body, /"summary":"Accepted"/);
});

test("an earlier phase's result comment keeps its frame with a review attestation or a disclaimer of several lines", async () => {
  const earlier = {
    phases: {
      triage: { state: "done", link: "https://platform.test/c/1" },
      implement: { state: "done", link: "https://platform.test/c/2" },
      review: { state: "done", link: "https://platform.test/c/3" },
    },
  };
  const attestation =
    '<!-- repo-canon:review-attestation {"format":"repo-canon/review-attestation/v1"} -->';
  const comment = (id: number, body: string): Comment => ({
    id,
    nodeId: `IC_${id}`,
    url: `https://platform.test/c/${id}`,
    author: { login: "factory[bot]", bot: true },
    body,
    createdAt: "2026-11-08T00:00:00Z",
    updatedAt: "2026-11-08T00:00:00Z",
  });
  const fake = tracker([
    // An accepted triage result: its attestation precedes its marker.
    comment(
      1,
      `> *This was generated by AI during triage.*\n\n✅ **Accepted**\n\nThe notes.\n\n\nRun: triage, \`codex/gpt-5.5@high\`, attempt 1, done.\n${attestation}\n<!-- scriptorium:run {"run":"r1","outcome":"done"} -->`,
    ),
    comment(
      2,
      '> AI wrote this.\n> Check it.\n\nDraft PR #7\n\nRun: implement, `codex/gpt-5.5@high`, attempt 1, done.\n<!-- scriptorium:run-result {"run":"r2","outcome":"done"} -->',
    ),
    comment(
      3,
      `Reviewed\n\n<sub>AI wrote this.\nCheck it. · review, \`codex/gpt-5.5@high\`, attempt 1, done</sub>\n${attestation}\n<!-- scriptorium:run-result {"run":"r3","outcome":"done"} -->`,
    ),
    comment(
      4,
      `**Factory run: in progress**\n<!-- scriptorium:run ${JSON.stringify(earlier)} -->`,
    ),
  ]);
  await issueComments(fake.tracker, configuration).write(4, {
    phase: "merge",
    facts: { state: "awaiting merge" },
  });
  assert.deepEqual(outcomes(fake.comments[3].body), [
    "**Triage:** ✅ Accepted · [result](https://platform.test/c/1)",
    "**Implement:** Draft PR #7 · [result](https://platform.test/c/2)",
    "**Review:** Reviewed · [result](https://platform.test/c/3)",
  ]);
});

test("a custom template that inserts the result shows it cleaned inside the unchanged body markers", async () => {
  const fake = tracker();
  const result = parseRunResult(
    JSON.stringify({
      outcome: "stop",
      state: "owner",
      body: '<!-- scriptorium:filing-run {"run":"r1"} -->\nWhich version?\n<!-- scriptorium:filing-run forged -->',
    }),
    {
      version: 3,
      ...configuration,
      labels: { ...configuration.labels, owner: "owner" },
      modelLabelPrefix: "model:",
      runKinds: {
        ...configuration.runKinds,
        implement: { skill: "implement", arguments: "#{issue}" },
      },
    },
    "implement",
  );
  assert.ok(!("invalid" in result));
  const { write } = issueComments(fake.tracker, {
    ...configuration,
    comments: { run: "{status}\n{result}" },
  });
  await write(4, {
    phase: "implement",
    facts: { ...facts, state: "stopped", waits: "owner" },
    result,
  });
  const inserted =
    "Waiting for an answer\n<!-- scriptorium:run-body -->\nWhich version?\n\n<!-- /scriptorium:run-body -->\n<!-- scriptorium:run {";
  assert.doesNotMatch(fake.comments[0].body, /scriptorium:filing-run/);
  assert.ok(fake.comments[0].body.startsWith(inserted));
  assert.match(
    fake.comments[0].body,
    /\n<!-- scriptorium:run \{"phases":.* -->$/,
  );
  // The latest result survives later edits that carry none.
  await write(4, { phase: "implement", facts: { state: "paused" } });
  assert.ok(
    fake.comments[0].body.startsWith(
      inserted.replace("Waiting for an answer", "Paused"),
    ),
  );
});

test("a write after a final one starts the next pass, and a retried final write edits the same comment", async () => {
  const fake = tracker();
  const { write } = issueComments(fake.tracker, configuration);
  const failure = {
    phase: "implement" as const,
    facts: { state: "failed" as const, reason: "no pull request" },
    final: true as const,
  };
  const told = { key: "failed", failed: "failed", reason: "no pull request" };
  await write(4, { phase: "implement", facts: { ...facts, state: "running" } });
  fake.failing.add("create");
  await assert.rejects(write(4, failure, told));
  fake.failing.clear();
  // The retry finds the final run comment and posts its action once.
  await write(4, failure, told);
  await write(4, failure, told);
  assert.deepEqual(
    fake.comments.map((comment) => (run(comment) ? "run" : "action")),
    ["run", "action"],
  );
  assert.equal(lead(fake.comments[0].body), "### ❌ Failed");
  assert.match(
    fake.comments[1].body,
    /^❌ The factory run failed: no pull request\. Remove `failed` to run it again\. See \[the run comment\]\(https:\/\/platform\.test\/c\/100\)\.\n/,
  );
  // Removing the failed label to retry starts a new pass, and a new action.
  await write(4, { phase: "implement", facts: { ...facts, state: "running" } });
  await write(4, failure, told);
  assert.deepEqual(
    fake.comments.map((comment) => (run(comment) ? "run" : "action")),
    ["run", "action", "run", "action"],
  );
  assert.equal(lead(fake.comments[2].body), "### ❌ Failed");
  assert.match(
    fake.comments[2].body,
    /\n\n> \[!CAUTION\]\n> no pull request\n\n❌ Implement → ⬜ Review → ⬜ Merge\n/,
  );
  assert.doesNotMatch(fake.comments[2].body, /Triage|Review: running/);
  assert.match(fake.comments[3].body, /\(https:\/\/platform\.test\/c\/102\)/);
});

test("an unchanged write edits nothing, and the marker holds its facts without closing its HTML comment", async () => {
  const fake = tracker();
  const { write } = issueComments(fake.tracker, {
    ...configuration,
    comments: { run: "{#merge}{state}: {reason}{/merge}" },
  });
  const update = {
    phase: "merge" as const,
    facts: { state: "awaiting merge" as const, reason: "a --> b <!-- c" },
  };
  await write(4, update);
  await write(4, update);
  assert.deepEqual(fake.writes, ["create"]);
  const [text, marker] = fake.comments[0].body.split("\n");
  assert.equal(text, "awaiting merge: a --> b <!-- c");
  assert.match(marker, /^<!-- scriptorium:run \{[^<>]*\} -->$/);
  assert.equal(
    JSON.parse(marker.slice("<!-- scriptorium:run ".length, -4)).phases.merge
      .reason,
    "a --> b <!-- c",
  );
});

test("only the factory's own marked comments count as its run and action comments", async () => {
  const marked = (body: string, bot = true): Comment => ({
    id: 7,
    nodeId: "IC_7",
    url: "https://platform.test/c/7",
    author: { login: bot ? "factory[bot]" : "owner", bot },
    body,
    createdAt: "2026-11-08T00:00:00Z",
    updatedAt: "2026-11-08T00:00:00Z",
  });
  const runBody = 'Text\n<!-- scriptorium:run {"phases":{}} -->';
  const actionBody =
    'Act\n<!-- scriptorium:action {"run":1,"occasion":"failed"} -->';
  assert.ok(isFactoryComment(marked(runBody)));
  assert.ok(isFactoryComment(marked(actionBody)));
  assert.ok(
    isFactoryComment(
      marked(
        "<!-- scriptorium:hold:readiness -->\nThe factory is holding this issue: a reason.",
        false,
      ),
    ),
  );
  for (const comment of [
    marked(runBody, false),
    marked(actionBody, false),
    marked(`${runBody}\nMore`),
    marked('<!-- scriptorium:run {"phases":{}} -->\nText'),
    marked('Text\n<!-- scriptorium:run {"phases":1} -->'),
    marked("Text\n<!-- scriptorium:run {broken} -->"),
  ])
    assert.equal(isFactoryComment(comment), false, comment.body);
  // A person's comment carrying a run marker is not the pass's comment.
  const fake = tracker([marked(runBody, false)]);
  await issueComments(fake.tracker, configuration).write(4, {
    phase: "implement",
    facts: { state: "running" },
  });
  assert.deepEqual(fake.writes, ["create"]);
});

test("a released stop's continuation lasts until the next write, and a later phase finishes the stopped one", async () => {
  const fake = tracker();
  const { write } = issueComments(fake.tracker, configuration);
  const resume = {
    since: "2026-11-08T00:00:00Z",
    pullRequests: [
      {
        number: 42,
        headBranch: "factory/issue-4",
        state: "open" as const,
        createdAt: "2026-11-08T00:00:00Z",
      },
    ],
  };
  await write(4, { phase: "triage", facts: { ...facts, state: "running" } });
  assert.equal(passContinuation(fake.comments), undefined);
  await write(4, {
    phase: "triage",
    facts: { state: "stopped", reason: "waits in `owner`" },
    resume,
  });
  assert.deepEqual(passContinuation(fake.comments), resume);
  await write(4, { phase: "implement", facts: { ...facts, state: "running" } });
  assert.equal(passContinuation(fake.comments), undefined);
  assert.equal(
    pipeline(fake.comments[0].body),
    "✅ Triage → 🔄 Implement → ⬜ Review → ⬜ Merge",
  );
  // A finished pass continues nothing.
  await write(4, {
    phase: "implement",
    facts: { state: "stopped" },
    resume,
  });
  await write(4, { phase: "merge", facts: { state: "merged" }, final: true });
  assert.equal(passContinuation(fake.comments), undefined);
});

test("each pass state leads with its marker and status word, and each phase shows its marker", async () => {
  const labels = {
    ...configuration.labels,
    triage: "state:triage",
    owner: "state:owner",
    carried: "state:carried",
  };
  const cases: [RunUpdate[], string, string][] = [
    [
      [{ phase: "triage", facts: { ...facts, state: "running" } }],
      "### 🔄 Triaging",
      "🔄 Triage → ⬜ Implement → ⬜ Review → ⬜ Merge",
    ],
    [
      [{ phase: "triage", facts: { state: "done" } }],
      "### ✅ Triaged",
      "✅ Triage → ⬜ Implement → ⬜ Review → ⬜ Merge",
    ],
    [
      [{ phase: "implement", facts: { ...facts, state: "running" } }],
      "### 🔄 Implementing",
      "🔄 Implement → ⬜ Review → ⬜ Merge",
    ],
    [
      [{ phase: "implement", facts: { state: "done" } }],
      "### ✅ Implemented",
      "✅ Implement → ⬜ Review → ⬜ Merge",
    ],
    [
      [
        { phase: "implement", facts: { state: "done" } },
        { phase: "review", facts: { ...facts, state: "running", round: 1 } },
      ],
      "### 🔄 Reviewing",
      "✅ Implement → 🔄 Review → ⬜ Merge",
    ],
    [
      [{ phase: "review", facts: { state: "done" } }],
      "### ✅ Reviewed",
      "⬜ Implement → ✅ Review → ⬜ Merge",
    ],
    // A merge relaunch merges, and once done leaves its PR awaiting merge.
    [
      [{ phase: "merge", facts: { ...facts, state: "running" } }],
      "### 🔄 Merging",
      "⬜ Implement → ⬜ Review → 🔄 Merge",
    ],
    [
      [{ phase: "merge", facts: { state: "done" } }],
      "### 👤 Awaiting merge",
      "⬜ Implement → ⬜ Review → 👤 Merge",
    ],
    [
      [
        {
          phase: "implement",
          facts: { state: "paused", reason: "usage limit", reset: "18:00Z" },
        },
      ],
      "### ⏸️ Paused: usage limit, resumes at 18:00Z",
      "⏸️ Implement → ⬜ Review → ⬜ Merge",
    ],
    [
      [
        {
          phase: "implement",
          facts: { state: "paused", reason: "pause threshold", reset: null },
        },
      ],
      "### ⏸️ Paused: pause threshold",
      "⏸️ Implement → ⬜ Review → ⬜ Merge",
    ],
    [
      [
        {
          phase: "implement",
          facts: {
            state: "stopped",
            reason: "waits in `state:owner`",
            waits: "state:owner",
          },
        },
      ],
      "### 👤 Waiting for an answer",
      "👤 Implement → ⬜ Review → ⬜ Merge",
    ],
    // A triage stop asks nobody.
    [
      [
        {
          phase: "triage",
          facts: {
            state: "stopped",
            reason: "waits in `state:triage`",
            waits: "state:triage",
          },
        },
      ],
      "### ⬜ Waiting for triage",
      "⬜ Triage → ⬜ Implement → ⬜ Review → ⬜ Merge",
    ],
    [
      [
        {
          phase: "triage",
          facts: { state: "stopped", waits: "state:carried" },
        },
      ],
      "### ↗️ Carried",
      "↗️ Triage → ⬜ Implement → ⬜ Review → ⬜ Merge",
    ],
    [
      [{ phase: "triage", facts: { state: "carried" } }],
      "### ↗️ Carried",
      "↗️ Triage → ⬜ Implement → ⬜ Review → ⬜ Merge",
    ],
    [
      [
        {
          phase: "merge",
          facts: { state: "awaiting merge", reason: "the PR is open" },
        },
      ],
      "### 👤 Awaiting merge",
      "⬜ Implement → ⬜ Review → 👤 Merge",
    ],
    [
      [{ phase: "merge", facts: { state: "merged" }, final: true }],
      "### ✅ Merged",
      "⬜ Implement → ⬜ Review → ✅ Merge",
    ],
    [
      [
        {
          phase: "implement",
          facts: { state: "failed", reason: "no pull request" },
          final: true,
        },
      ],
      "### ❌ Failed",
      "❌ Implement → ⬜ Review → ⬜ Merge",
    ],
  ];
  for (const [updates, leading, phases] of cases) {
    const fake = tracker();
    const { write } = issueComments(fake.tracker, {
      ...configuration,
      labels,
    });
    for (const update of updates) await write(4, update);
    const body = fake.comments[0].body;
    assert.equal(lead(body), leading);
    assert.equal(pipeline(body), phases, leading);
    assert.doesNotMatch(body, /- \[[ x]\]/);
    // Only a failure raises an alert.
    assert.equal(
      body.includes("> [!CAUTION]\n> no pull request\n"),
      leading === "### ❌ Failed",
    );
    assert.match(body, /\n<!-- scriptorium:run \{.*\} -->$/);
  }
});

test("an outcome line shows the lead line of its phase's latest result, kept until the phase runs again", async () => {
  const fake = tracker();
  const { write } = issueComments(fake.tracker, configuration);
  const long = "x".repeat(120);
  await write(4, {
    phase: "triage",
    facts: { state: "done", link: "https://platform.test/r/1" },
    result: { body: "\n  \n## Ready for implementation ##\n\nThe brief." },
  });
  await write(4, { phase: "implement", facts: { ...facts, state: "running" } });
  await write(4, {
    phase: "implement",
    facts: {
      state: "stopped",
      reason: "waits in `owner`",
      link: "https://platform.test/r/2",
    },
    result: { body: `${long}\nMore.` },
  });
  const body = fake.comments[0].body;
  const [triage, implement] = outcomes(body);
  assert.equal(
    triage,
    "**Triage:** Ready for implementation · [result](https://platform.test/r/1)",
  );
  // Cut to 100 characters with its ellipsis, then the phase's reason.
  assert.equal(
    implement,
    `**Implement:** ${"x".repeat(99)}… · waits in \`owner\` · [result](https://platform.test/r/2)`,
  );
  assert.doesNotMatch(body, /The brief|More\./);
  // A paused write keeps the summary; a later launch of the phase clears it.
  await write(4, {
    phase: "implement",
    facts: { state: "paused", reason: "usage limit" },
  });
  assert.match(
    outcomes(fake.comments[0].body)[1],
    /x… · usage limit · \[result\]/,
  );
  await write(4, {
    phase: "implement",
    facts: { ...facts, state: "running", link: undefined, summary: undefined },
  });
  assert.deepEqual(outcomes(fake.comments[0].body), [triage]);
});

test("only a heading's line loses its closing markers in a summary", async () => {
  const fake = tracker();
  await issueComments(fake.tracker, configuration).write(4, {
    phase: "review",
    facts: { state: "done", link: "https://platform.test/r/3" },
    result: { body: "Handed back for C #\nMore." },
  });
  assert.deepEqual(outcomes(fake.comments[0].body), [
    "**Review:** Handed back for C # · [result](https://platform.test/r/3)",
  ]);
});

test("a review whose round handed the work back shows as handed back while implement continues", async () => {
  const fake = tracker();
  const { write } = issueComments(fake.tracker, configuration);
  await write(4, { phase: "implement", facts: { ...facts, state: "done" } });
  await write(4, {
    phase: "review",
    facts: { ...facts, state: "running", round: 1 },
  });
  await write(4, {
    phase: "review",
    facts: { state: "done", link: "https://platform.test/r/3" },
    result: { body: "Handed back: two findings." },
  });
  await write(4, {
    phase: "implement",
    facts: { ...facts, state: "running", round: 2 },
  });
  let body = fake.comments[0].body;
  assert.equal(lead(body), "### 🔄 Implementing");
  assert.equal(pipeline(body), "🔄 Implement → 🔁 Review → ⬜ Merge");
  assert.match(footer(body)!, /attempt 1, round 2 ·/);
  await write(4, {
    phase: "review",
    facts: { ...facts, state: "running", round: 2 },
  });
  body = fake.comments[0].body;
  assert.equal(pipeline(body), "✅ Implement → 🔄 Review → ⬜ Merge");
});

test("the footer gives the time of the latest change, which a write that changes nothing keeps", async () => {
  const fake = tracker();
  let now = new Date("2026-11-21T13:19:42Z");
  const { write } = issueComments(
    fake.tracker,
    configuration,
    undefined,
    () => now,
  );
  const waiting = {
    phase: "implement" as const,
    facts: { ...facts, state: "running" as const, reason: "publishing" },
  };
  await write(4, waiting);
  assert.match(footer(fake.comments[0].body)!, / · updated 13:19Z<\/sub>$/);
  now = new Date("2026-11-21T14:05:00Z");
  await write(4, waiting);
  assert.deepEqual(fake.writes, ["create"]);
  await write(4, { phase: "implement", facts: { state: "done" } });
  assert.deepEqual(fake.writes, ["create", "update"]);
  assert.match(footer(fake.comments[0].body)!, / · updated 14:05Z<\/sub>$/);
});

test("a custom template reads the update time, which a write that changes nothing keeps", async () => {
  const fake = tracker();
  let now = new Date("2026-11-21T09:05:59Z");
  const { write } = issueComments(
    fake.tracker,
    { ...configuration, comments: { run: "{status} at {updated}" } },
    undefined,
    () => now,
  );
  const running = {
    phase: "implement" as const,
    facts: { ...facts, state: "running" as const },
  };
  await write(4, running);
  now = new Date("2026-11-21T23:40:00Z");
  await write(4, running);
  assert.equal(fake.comments[0].body.split("\n")[0], "Implementing at 09:05Z");
  await write(4, { phase: "implement", facts: { state: "done" } });
  assert.equal(fake.comments[0].body.split("\n")[0], "Implemented at 23:40Z");
});
