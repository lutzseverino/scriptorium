// One repository's issue, label, comment, role and pull request reads and
// writes, through its hosting platform's Postern connection. Postern reports
// the platform's facts; readiness, the frontier and authorization stay the
// decision core's.
import {
  PlatformError,
  type Account,
  type Connection,
  type IssueReference,
  type LabelChange,
  type PullRequest,
} from "@lutzseverino/postern";
import type { FactoryConfiguration } from "./factory-configuration.ts";
import { renderComment } from "./comment-template.ts";
import type { Issue, IssueId } from "./factory.ts";
import { reference, type Actor, type ReadinessHold } from "./readiness.ts";
import { commentHistory } from "./comment-history.ts";
import type { PullRequestState } from "./run-outcome.ts";
import {
  briefReadiness,
  hasBriefContract,
  briefHistoryCandidates,
} from "./contract.ts";

// The body sections a platform without native links reads an issue's parent
// and blockers from. Only Postern's adapter reads them.
export const relationshipSections = {
  parent: "Parent",
  blockedBy: "Blocked by",
} as const;

// The branch an issue's runs use.
export function runBranch(issue: number): string {
  return `factory/issue-${issue}`;
}

// Identity needed to recover an open PR. Ownership and uniqueness are decided
// here; the host checks its base and ancestry in the refreshed clone.
export type MergeRelaunch = Pick<
  PullRequest,
  "number" | "headCommit" | "baseBranch" | "createdAt"
>;

export function repositoryPlatform(
  connection: Connection,
  labels: FactoryConfiguration["labels"],
  closeTemplate?: string,
) {
  const { issueTracker, pullRequests, access } = connection;
  const path = connection.repository.path;
  // An issue as the decision core identifies it: its number in this
  // repository, or `<path>#<n>` in another.
  const id = (linked: IssueReference): IssueId =>
    linked.repository.toLowerCase() === path.toLowerCase()
      ? linked.number
      : `${linked.repository}#${linked.number}`;
  const link = (linked: IssueReference) => ({
    number: id(linked),
    state: linked.state,
  });

  // Postern's authenticated fallback for a GitHub fact its neutral comment
  // port does not expose. Deleted text is unavailable, so a newer deletion
  // prevents proving that the surviving Brief was never superseded.
  // https://docs.github.com/en/graphql/reference/issues#commentdeletedevent
  async function latestCommentDeletion(number: number): Promise<string | null> {
    const [owner, name] = path.split("/");
    const response = await access.request({
      method: "POST",
      path: "/graphql",
      body: {
        query: `query FactoryCommentDeletions($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            issue(number: $number) {
              timelineItems(last: 1, itemTypes: [COMMENT_DELETED_EVENT]) {
                nodes { ... on CommentDeletedEvent { createdAt } }
              }
            }
          }
        }`,
        variables: { owner, name, number },
      },
    });
    const result = response.data as {
      errors?: unknown;
      data?: {
        repository?: {
          issue?: { timelineItems?: { nodes?: { createdAt?: unknown }[] } };
        };
      };
    } | null;
    const nodes = result?.data?.repository?.issue?.timelineItems?.nodes;
    if (
      result?.errors ||
      !Array.isArray(nodes) ||
      nodes.length > 1 ||
      (nodes.length === 1 &&
        (typeof nodes[0]?.createdAt !== "string" ||
          !Number.isFinite(Date.parse(nodes[0].createdAt))))
    )
      throw new PlatformError(
        "invalidResponse",
        "Comment deletion history could not be read",
      );
    return nodes.length === 0 ? null : (nodes[0].createdAt as string);
  }

  async function readBrief(
    number: number,
    ready: LabelChange,
  ): Promise<ReadinessHold | null> {
    try {
      const comments = await issueTracker.comments(number);
      const deletion =
        connection.repository.platform === "github"
          ? await latestCommentDeletion(number)
          : null;
      const histories: string[][] = [];
      if (connection.repository.platform === "github")
        for (const comment of briefHistoryCandidates(comments, ready))
          histories.push(await commentHistory(access, comment));
      return briefReadiness(
        comments,
        ready,
        connection.repository.platform,
        deletion,
        histories,
      );
    } catch (error) {
      if (!(error instanceof PlatformError)) throw error;
      return {
        reason:
          "waits: the current Agent Brief, validator approval or comment history could not be read this pass; restore comment access and retry",
        waiting: true,
      };
    }
  }

  // An absent label counts as removed.
  async function remove(issue: number, label: string) {
    try {
      await issueTracker.removeLabel(issue, label);
    } catch (error) {
      if (!(error instanceof PlatformError && error.reason === "notFound"))
        throw error;
    }
  }

  // Adds the new state label before removing the old ones, so a write that
  // fails part way never leaves a claimed issue without a state label for a
  // pass to pick it up again.
  async function transition(issue: number, add: string | null, old: string[]) {
    if (add !== null) await issueTracker.addLabels(issue, [add]);
    for (const label of old) await remove(issue, label);
  }

  async function candidates(
    number: number,
    since?: string,
  ): Promise<PullRequest[]> {
    const found = [
      ...(pullRequests.capabilities.closingReferences
        ? await pullRequests.closing(number)
        : []),
      ...(await pullRequests.byHeadBranch(runBranch(number))),
    ].filter(
      (pr) =>
        !pr.crossRepository &&
        (since === undefined || Date.parse(pr.createdAt) >= Date.parse(since)),
    );
    return [...new Map(found.map((pr) => [pr.number, pr])).values()];
  }

  function state(candidates: PullRequest[]): PullRequestState {
    const states = candidates.map((pr) => pr.state);
    if (states.includes("open")) return "open";
    if (states.includes("merged")) return "merged";
    return states.includes("closed") ? "closed" : "none";
  }

  return {
    // An existing label is left as it is.
    async createStateLabels(): Promise<void> {
      for (const [role, color] of [
        ["running", "0052cc"],
        ["failed", "b60205"],
        ["needsInput", "fbca04"],
        ["paused", "c5def5"],
      ] as const)
        try {
          await issueTracker.createLabel({
            name: labels[role],
            color,
            description: `Factory state: ${role}`,
          });
        } catch (error) {
          if (!(error instanceof PlatformError && error.reason === "rejected"))
            throw error;
        }
    },

    // The repository's open issues. The role of each ready label's latest
    // actor is read once per account per call, which a pass makes once. A
    // time the platform doesn't offer is null, never invented.
    async readIssues(): Promise<Issue[]> {
      const { capabilities } = issueTracker;
      const actors = new Map<string, Promise<Actor>>();
      const actor = (account: Account | null): Promise<Actor> => {
        if (account === null) return Promise.resolve({ kind: "unknown" });
        const { login } = account;
        if (account.bot) return Promise.resolve({ kind: "bot", login });
        if (!actors.has(login))
          actors.set(
            login,
            access.role(login).then(
              (role): Actor => ({ kind: "user", login, role }),
              (error) => {
                if (error instanceof PlatformError)
                  return { kind: "unreadable", login };
                throw error;
              },
            ),
          );
        return actors.get(login)!;
      };
      const issues: Issue[] = [];
      for (const issue of await issueTracker.issues()) {
        // Changes arrive in platform order, so the last match is the latest.
        const changes = issue.labels.includes(labels.ready)
          ? await issueTracker.labelChanges(issue.number)
          : [];
        const ready = changes.findLast(
          (change) =>
            change.action === "added" && change.label === labels.ready,
        );
        issues.push({
          number: issue.number,
          createdAt: issue.createdAt,
          labels: issue.labels,
          ready: ready
            ? { at: ready.time, actor: await actor(ready.actor) }
            : null,
          editedAt: capabilities.bodyEditTime ? issue.bodyEditTime : null,
          contractHold:
            ready && hasBriefContract(issue.labels, changes)
              ? await readBrief(issue.number, ready)
              : null,
          nativeParent: issue.parent && id(issue.parent),
          // The platform reports when the latest sub-issue was linked, not
          // which.
          latestLink:
            capabilities.linkTime && issue.linkTime !== null
              ? { ticket: null, at: issue.linkTime }
              : null,
          subIssues: issue.subIssues.map(link),
          blockedBy: issue.blockedBy.map(link),
        });
      }
      return issues;
    },

    // A run's pull request is one from this repository, not a fork, that
    // closes its issue or comes from the run's branch, opened since the first
    // attempt started (`since`). Issue closure is observed separately.
    async pullRequestState(
      number: number,
      since?: string,
    ): Promise<PullRequestState> {
      return state(await candidates(number, since));
    },

    // A closing reference is observation, not delivery authorization. Only
    // the run branch or the supplied connection's verified identity owns a PR.
    async pullRequestObservation(
      number: number,
      since?: string,
    ): Promise<{
      state: PullRequestState;
      mergeCandidate?: MergeRelaunch;
    }> {
      const found = await candidates(number, since);
      const open = found.filter((pr) => pr.state === "open");
      let viewer: Account | null = null;
      if (open.some((pr) => pr.headBranch !== runBranch(number))) {
        try {
          viewer = await access.viewer();
        } catch {
          /* Installation tokens need not support the viewer endpoint. */
        }
      }
      const owned = open.filter(
        (pr) =>
          pr.headBranch === runBranch(number) ||
          (viewer !== null &&
            pr.author?.login.toLowerCase() === viewer.login.toLowerCase()),
      );
      const pr = owned.length === 1 ? owned[0] : undefined;
      return {
        state: state(found),
        ...(pr && {
          mergeCandidate: {
            number: pr.number,
            headCommit: pr.headCommit,
            baseBranch: pr.baseBranch,
            createdAt: pr.createdAt,
          },
        }),
      };
    },

    // Closed issues carrying any active state label, including questions
    // whose claims were already released.
    async readClosedClaims(): Promise<number[]> {
      const numbers = new Set<number>();
      for (const label of [labels.running, labels.paused, labels.needsInput])
        for (const { number } of await issueTracker.issues({
          state: "closed",
          label,
        }))
          numbers.add(number);
      return [...numbers];
    },

    claim: (issue: number) => transition(issue, labels.running, []),

    // A claim ends without whichever of its running and paused labels it
    // carries.
    release: (issue: number) =>
      transition(issue, null, [labels.running, labels.paused]),

    // A closed issue no longer needs an owner's answer. Keep this separate
    // from release, which also settles open issues with pending questions.
    releaseClosed: (issue: number) =>
      transition(issue, null, [
        labels.running,
        labels.paused,
        labels.needsInput,
      ]),

    async fail(issue: number, comment: string) {
      await transition(issue, labels.failed, [labels.running, labels.paused]);
      await issueTracker.createComment(issue, comment);
    },

    async awaitingMerge(issue: number, comment: string) {
      await issueTracker.createComment(issue, comment);
    },

    async pause(issue: number, comment: string) {
      await transition(issue, labels.paused, [labels.running]);
      await issueTracker.createComment(issue, comment);
    },

    unpause: (issue: number) =>
      transition(issue, labels.running, [labels.paused]),

    // The platform's default close reason, completed on GitHub.
    async close(issue: number, tickets: IssueId[]) {
      await issueTracker.createComment(
        issue,
        renderComment("close", closeTemplate, {
          tickets: tickets.map(reference),
        }),
      );
      await issueTracker.closeIssue(issue);
    },
  };
}

export type RepositoryPlatform = ReturnType<typeof repositoryPlatform>;
