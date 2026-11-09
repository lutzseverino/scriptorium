// Pure rendering of a continuation and facts already read by the host.
import type { Continuation } from "./factory.ts";
import { handBackLimit } from "./run-ending.ts";
import { completionSignal, type ModelFacts } from "./providers.ts";
import type { repositoryHold } from "./repository-holds.ts";

export type PromptFacts = {
  invocation: string;
  credentialLimits: string;
  retryTail: string;
  holds: NonNullable<ReturnType<typeof repositoryHold>>[];
  // Supplied when the host provides a writable run-result mount.
  resultPath?: string;
  resultInstructions?: string;
  reviewTarget?: number;
  filingRun?: string;
  models?: ModelFacts;
};

export function prompt(continuation: Continuation, facts: PromptFacts): string {
  const { retry, recovery, mergeRelaunch, inputResume } = continuation;
  const handBack =
    continuation.runKind === undefined && continuation.target
      ? { target: continuation.target, handBacks: continuation.handBacks ?? 1 }
      : undefined;
  const guidance = [
    "Unattended execution:",
    `This is a factory run. ${facts.credentialLimits}`,
    "Before every delivery push, fetch origin and resolve its remote default branch again (for example, git fetch --prune origin, then git remote set-head origin --auto). Inspect the outgoing commits, including per-parent patches for merges (git log --stat --patch -m origin/HEAD..HEAD), and the change against that refreshed base (git diff origin/HEAD...HEAD). Keep both history and diff limited to the issue's work. A clean final diff can conceal reverted workflow edits or unrelated rewritten commits. When an update is needed, safely rebase or replay only the issue's own changes onto the current base. Never merge the default branch into the issue branch. Intentional workflow edits must remain visible; never discard them to bypass permissions. Revalidate a reconstructed change before publication.",
    "Preserve committed, staged, unstaged and untracked work and existing PR, review and handoff context before changing history. Continuing a branch does not require retaining unrelated history or override an owner's explicit request to reconstruct the issue's changes on the current base. If ownership is uncertain or reconstruction has conflicts, preserve the work and hand off under the repository's owner-question rules. After any permission refusal, stop with an explicit owner handoff: no second push, credential discovery or identity switch. Do not assume broader App permissions are necessary; ask the owner how to proceed.",
    "There is no interactive notification or resume loop. Keep commands in the foreground and wait for validation to finish; inspect its final exit status before PR delivery. Do not yield while work is pending; detaching shell commands with &, nohup, disown or similar is not a substitute. A timeout is a failure to resolve, never evidence of a pass. Use bounded foreground command timeouts within the run's time limit.",
    `Emit ${completionSignal} only after the requested delivery or explicit owner handoff is actually recorded. The signal is loop control; GitHub outcomes and your run result still determine delivery.`,
    ...(facts.resultInstructions ? [facts.resultInstructions] : []),
    ...(facts.models ? [`Host models: ${JSON.stringify(facts.models)}`] : []),
    ...(facts.reviewTarget
      ? [
          `Review target: PR #${facts.reviewTarget}. Resolve its linked issue contract; when it has no linked issue, use the PR body as the Spec source.`,
        ]
      : []),
    ...(facts.filingRun
      ? [
          `Factory filing run: ${facts.filingRun}. Cite findings filed by this run with this exact line in the issue body: <!-- scriptorium:filing-run {"run":"${facts.filingRun}"} -->`,
        ]
      : []),
    ...facts.holds.map(
      ({ hold, numbers }) =>
        `${hold}: ${numbers === null ? "unreadable" : `active: ${numbers.map((number) => `#${number}`).join(", ")}`}`,
    ),
    ...(facts.resultPath ? [`Run result path: ${facts.resultPath}`] : []),
    ...(mergeRelaunch
      ? [
          `Merge relaunch: bring PR #${mergeRelaunch.number}, relaunched for head ${mergeRelaunch.headCommit}, onto the current default branch (${mergeRelaunch.baseBranch}). Preserve this same PR, its reviews and handoff context and all dirty work.`,
        ]
      : []),
    ...(handBack
      ? [
          `Review hand-back: the latest review of PR #${handBack.target.number} handed the work back (hand-back ${handBack.handBacks} of at most ${handBackLimit}). Continue this same PR from its branch and that review's findings; never open a replacement PR.`,
        ]
      : []),
    ...(inputResume
      ? [
          `Needs-input resume: continue ${inputResume.pullRequests.length ? inputResume.pullRequests.map((pr) => `PR #${pr.number} (${pr.state}, branch ${pr.headBranch})`).join(", ") : "the preserved issue work"}. Preserve the same PR, its reviews, owner answers and handoff context, and bring only this issue's work onto the current default branch under the delivery instructions above. Reopen an existing closed-unmerged PR when needed. Never open a replacement PR. If PR ownership or identity is uncertain, preserve work and record an owner handoff.`,
        ]
      : []),
    ...(recovery
      ? [
          `Recovery state: ${JSON.stringify(recovery)}. Continue from this preserved branch and worktree, including committed, staged, unstaged and untracked changes, applying the delivery and reconstruction instructions above. Revalidate recovered work before publication. Recovery itself must not push, open a PR, merge, close the issue or grant readiness.`,
        ]
      : []),
  ].join("\n");
  return [
    facts.invocation,
    ...(retry ? [`First attempt failure: ${retry.failure}`] : []),
    ...(retry && facts.retryTail
      ? [
          `First attempt log tail:
${facts.retryTail}`,
        ]
      : []),
    guidance,
  ].join("\n\n");
}
