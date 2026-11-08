// One repository's issue, label, comment, role and pull request reads and
// writes, through its hosting platform's Postern connection. Postern reports
// the platform's facts; readiness, the frontier and authorization stay the
// decision core's.
import {
  PlatformError,
  type Account,
  type ConnectionWithLinkAdditions,
  type IssueReference,
  type PullRequest,
} from "@lutzseverino/postern";
import type { PlatformConventions } from "./factory-configuration.ts";
import { reconcileHolds, type HoldKey } from "./hold-comments.ts";
import { renderComment } from "./comment-template.ts";
import type { Issue, IssueId } from "./factory.ts";
import { filingRun } from "./triggers.ts";
import { reference, type Actor, type ReadinessHold } from "./readiness.ts";
import type { PullRequestState } from "./run-outcome.ts";
import {
  contractResultHold,
  triageBacked,
  type ContractFacts,
} from "./contract-result.ts";
import {
  claimLabels,
  configured,
  gateLabels,
  provisioned,
  transition as labelTransition,
  type Transition,
} from "./label-roles.ts";

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

// Work a stop released, which resumes on the same PRs once it is answered. A
// review stopped with its PR ready to merge resumes as review, and one
// stopped at a gate resumes once the gate is cleared.
export type InputResume = {
  since?: string;
  pullRequests: Pick<
    PullRequest,
    "number" | "headBranch" | "state" | "createdAt"
  >[];
  review?: {
    target: MergeRelaunch;
    implementedBy?: string;
    handBacks: number;
    gated: boolean;
  };
};

export function repositoryPlatform(
  connection: ConnectionWithLinkAdditions,
  configuration: PlatformConventions,
) {
  const { labels } = configuration;
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
  // port does not expose. A deletion newer than the validator's result is a
  // change it has not evaluated.
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

  // The validator's decision on a ready issue, checked against the issue's
  // comments and latest comment deletion, read here, and its other facts, and
  // whether the factory's triage result backs the brief it approved.
  async function readContractResult(
    number: number,
    facts: Omit<ContractFacts, "comments" | "latestDeletion">,
  ): Promise<{ hold: ReadinessHold | null; triage: boolean }> {
    try {
      const comments = await issueTracker.comments(number);
      const latestDeletion =
        connection.repository.platform === "github"
          ? await latestCommentDeletion(number)
          : undefined;
      const all = { ...facts, comments, latestDeletion };
      return {
        hold: contractResultHold(all, configuration),
        triage: triageBacked(all, configuration),
      };
    } catch (error) {
      if (!(error instanceof PlatformError)) throw error;
      return {
        hold: {
          reason:
            "waits: the issue-contract validator's result or the issue's comment history could not be read this pass; restore comment access and retry",
          waiting: true,
        },
        triage: false,
      };
    }
  }

  // Whether an open PR is still a draft. Postern's neutral PR port does not
  // report it, so this GitHub fact stays on its authenticated transport.
  async function readDraft(number: number): Promise<boolean> {
    const [owner, name] = path.split("/");
    const response = await access.request({
      method: "POST",
      path: "/graphql",
      body: {
        query: `query FactoryPullRequestDraft($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) { isDraft }
          }
        }`,
        variables: { owner, name, number },
      },
    });
    const result = response.data as {
      errors?: unknown;
      data?: { repository?: { pullRequest?: { isDraft?: unknown } } };
    } | null;
    const draft = result?.data?.repository?.pullRequest?.isDraft;
    if (result?.errors || typeof draft !== "boolean")
      throw new PlatformError(
        "invalidResponse",
        "Pull request draft state could not be read",
      );
    return draft;
  }

  function actorLookup() {
    const actors = new Map<string, Promise<Actor>>();
    return (account: Account | null): Promise<Actor> => {
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
  async function transition(issue: number, step: Transition) {
    const { add, remove: old } = labelTransition(labels, step);
    if (add !== null) await issueTracker.addLabels(issue, [add]);
    for (const label of old) await remove(issue, label);
  }

  async function candidates(
    number: number,
    since?: string,
    target?: number,
  ): Promise<{ found: PullRequest[]; closing: Set<number> }> {
    const closing =
      target !== number && pullRequests.capabilities.closingReferences
        ? await pullRequests.closing(number)
        : [];
    const found = [
      ...(target !== undefined ? [await pullRequests.pullRequest(target)] : []),
      ...closing,
      ...(await pullRequests.byHeadBranch(runBranch(number))),
    ].filter(
      (pr) =>
        (pr.number === target || !pr.crossRepository) &&
        (pr.number === target ||
          since === undefined ||
          Date.parse(pr.createdAt) >= Date.parse(since)),
    );
    return {
      found: [...new Map(found.map((pr) => [pr.number, pr])).values()],
      closing: new Set(closing.map((pr) => pr.number)),
    };
  }

  function state(candidates: PullRequest[]): PullRequestState {
    const states = candidates.map((pr) => pr.state);
    if (states.includes("open")) return "open";
    if (states.includes("merged")) return "merged";
    return states.includes("closed") ? "closed" : "none";
  }

  // The numbers of open items of one kind carrying `label`. Postern has no
  // label-filtered listing port, so this GitHub fact stays on its
  // authenticated transport, including every page of the labelled set. An
  // incomplete or malformed set never reads as a smaller one.
  async function readLabelled(
    operation: string,
    kind: "issues" | "pullRequests",
    label: string,
    subject: string,
  ): Promise<number[]> {
    const [owner, name] = path.split("/");
    const numbers = new Set<number>();
    let after: string | null = null;
    const cursors = new Set<string>();
    for (;;) {
      const response = await access.request({
        method: "POST",
        path: "/graphql",
        body: {
          query: `query ${operation}($owner: String!, $name: String!, $label: String!, $after: String) {
              repository(owner: $owner, name: $name) {
                ${kind}(first: 100, after: $after, states: OPEN, labels: [$label]) {
                  totalCount
                  nodes { number }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }`,
          variables: { owner, name, label, after },
        },
      });
      type Page = {
        totalCount?: number;
        nodes?: { number?: number }[];
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
      const result = response.data as {
        errors?: unknown;
        data?: { repository?: Partial<Record<typeof kind, Page>> };
      } | null;
      const page = result?.data?.repository?.[kind];
      const invalid = () =>
        new PlatformError(
          "invalidResponse",
          `${subject} could not be read completely`,
        );
      if (
        result?.errors ||
        !page ||
        !Number.isInteger(page.totalCount) ||
        page.totalCount! < 0 ||
        !Array.isArray(page.nodes) ||
        typeof page.pageInfo?.hasNextPage !== "boolean"
      )
        throw invalid();
      for (const node of page.nodes) {
        if (!Number.isInteger(node?.number) || node.number! <= 0)
          throw invalid();
        numbers.add(node.number!);
      }
      if (!page.pageInfo.hasNextPage) {
        if (numbers.size !== page.totalCount) throw invalid();
        return [...numbers].sort((a, b) => a - b);
      }
      const cursor = page.pageInfo.endCursor;
      if (typeof cursor !== "string" || !cursor || cursors.has(cursor))
        throw invalid();
      cursors.add(cursor);
      after = cursor;
    }
  }

  return {
    // GraphQL's viewer also identifies an installation token, for which the
    // REST /user endpoint used by Postern's viewer need not be available.
    // https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
    async filingAccount(): Promise<string | null> {
      if (connection.repository.platform !== "github")
        return (await access.viewer())?.login ?? null;
      const response = await access.request({
        method: "POST",
        path: "/graphql",
        body: {
          query: "query FactoryFilingAccount { viewer { login } }",
        },
      });
      const result = response.data as {
        errors?: unknown;
        data?: { viewer?: { login?: unknown } };
      } | null;
      const login = result?.data?.viewer?.login;
      if (result?.errors || typeof login !== "string" || !login.trim())
        throw new PlatformError(
          "invalidResponse",
          "The filing credential's account could not be read",
        );
      return login;
    },
    // The open PRs carrying the release hold label.
    async readReleaseHold(): Promise<number[]> {
      if (labels.releaseHold === undefined) return [];
      return readLabelled(
        "FactoryReleaseHold",
        "pullRequests",
        labels.releaseHold,
        "Release hold",
      );
    },

    // The open issues and PRs carrying the factory hold label. Issues and
    // PRs share one number space.
    async readHold(): Promise<number[]> {
      if (labels.hold === undefined) return [];
      const issues = await readLabelled(
        "FactoryHoldIssues",
        "issues",
        labels.hold,
        "Factory hold",
      );
      const pullRequests = await readLabelled(
        "FactoryHoldPullRequests",
        "pullRequests",
        labels.hold,
        "Factory hold",
      );
      return [...new Set([...issues, ...pullRequests])].sort((a, b) => a - b);
    },

    // The open PRs carrying a configured gate label.
    async readGated(): Promise<number[]> {
      const numbers = new Set<number>();
      for (const label of gateLabels(labels))
        for (const number of await readLabelled(
          "FactoryGatedPullRequests",
          "pullRequests",
          label,
          "Gated pull requests",
        ))
          numbers.add(number);
      return [...numbers].sort((a, b) => a - b);
    },

    // The labels only the factory writes. An existing label is left as it is.
    async createStateLabels(): Promise<void> {
      for (const { role, name, color } of provisioned(labels))
        try {
          await issueTracker.createLabel({
            name,
            color,
            description: `Factory state: ${role}`,
          });
        } catch (error) {
          if (!(error instanceof PlatformError && error.reason === "rejected"))
            throw error;
        }
    },

    // Postern has no PR listing/draft/label port. Read the inventory through
    // its authenticated transport, then each PR and author role through Postern.
    // Include ready PRs too, so an active review survives a draft-state change.
    async readPullRequests(): Promise<Issue[]> {
      if (connection.repository.platform !== "github") return [];
      const [owner, name] = path.split("/");
      const actor = actorLookup();
      const items: Issue[] = [];
      const cursors = new Set<string>();
      let after: string | null = null;
      for (;;) {
        const response = await access.request({
          method: "POST",
          path: "/graphql",
          body: {
            query: `query FactoryReviewPullRequests($owner: String!, $name: String!, $after: String) {
            repository(owner: $owner, name: $name) {
              pullRequests(first: 100, after: $after, states: OPEN) {
                totalCount nodes { number isDraft labels(first: 100) { totalCount nodes { name } } }
                pageInfo { hasNextPage endCursor }
              }
            }
          }`,
            variables: { owner, name, after },
          },
        });
        const result = response.data as {
          errors?: unknown;
          data?: {
            repository?: {
              pullRequests?: {
                totalCount: number;
                nodes: {
                  number: number;
                  isDraft: boolean;
                  labels: { totalCount: number; nodes: { name: string }[] };
                }[];
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
              };
            };
          };
        } | null;
        const page = result?.data?.repository?.pullRequests;
        const invalid = () =>
          new PlatformError(
            "invalidResponse",
            "Review PR inventory could not be read completely",
          );
        if (
          result?.errors ||
          !page ||
          !Array.isArray(page.nodes) ||
          !Number.isInteger(page.totalCount) ||
          typeof page.pageInfo?.hasNextPage !== "boolean"
        )
          throw invalid();
        for (const node of page.nodes) {
          if (
            !Number.isSafeInteger(node.number) ||
            node.number <= 0 ||
            typeof node.isDraft !== "boolean" ||
            !Array.isArray(node.labels?.nodes) ||
            node.labels.nodes.length !== node.labels.totalCount ||
            node.labels.nodes.some((label) => typeof label.name !== "string") ||
            items.some((item) => item.number === node.number)
          )
            throw invalid();
          const pr = await pullRequests.pullRequest(node.number);
          items.push({
            number: pr.number,
            createdAt: pr.createdAt,
            labels: node.labels.nodes.map((label) => label.name),
            author: await actor(pr.author),
            pullRequest: {
              target: {
                number: pr.number,
                headCommit: pr.headCommit,
                baseBranch: pr.baseBranch,
                createdAt: pr.createdAt,
              },
              draft: node.isDraft,
              headBranch: pr.headBranch,
            },
            ready: null,
            editedAt: null,
            contractHold: null,
            nativeParent: null,
            latestLink: null,
            linkAdditions: null,
            subIssues: [],
            blockedBy: [],
          });
        }
        if (!page.pageInfo.hasNextPage) {
          if (items.length !== page.totalCount) throw invalid();
          return items;
        }
        const cursor = page.pageInfo.endCursor;
        if (!cursor || cursors.has(cursor)) throw invalid();
        cursors.add(cursor);
        after = cursor;
      }
    },

    // The repository's open issues. The role of each ready label's latest
    // actor is read once per account per call, which a pass makes once. A
    // time the platform doesn't offer is null, never invented.
    async readIssues(): Promise<Issue[]> {
      const { capabilities } = issueTracker;
      const actor = actorLookup();
      const issues: Issue[] = [];
      for (const issue of await issueTracker.issues()) {
        // Changes arrive in platform order, so the last match is the latest.
        const changes = configured(labels, (role) => role.applied).some(
          (label) => issue.labels.includes(label),
        )
          ? await issueTracker.labelChanges(issue.number)
          : [];
        const latest = (label: string | undefined) =>
          label !== undefined && issue.labels.includes(label)
            ? changes.findLast(
                (change) => change.action === "added" && change.label === label,
              )
            : undefined;
        const ready = latest(labels.ready);
        const triage = latest(labels.triage);
        const reporter = latest(labels.reporter);
        const triggers = labels.triage !== undefined;
        const author = triggers ? await actor(issue.author) : undefined;
        const replies = reporter
          ? await issueTracker.comments(issue.number)
          : [];
        const authorReply =
          replies
            .filter(
              (comment) =>
                issue.author &&
                comment.author &&
                comment.author.login.toLowerCase() ===
                  issue.author.login.toLowerCase() &&
                !comment.author.bot &&
                Date.parse(comment.createdAt) > Date.parse(reporter!.time),
            )
            .map((comment) => comment.createdAt)
            .sort()
            .at(-1) ?? null;
        const readyActor = ready && (await actor(ready.actor));
        const contract = ready
          ? await readContractResult(issue.number, {
              ready,
              labelChanges: changes,
              bodyEditTime: capabilities.bodyEditTime
                ? issue.bodyEditTime
                : undefined,
            })
          : null;
        issues.push({
          number: issue.number,
          createdAt: issue.createdAt,
          ...(author && { author, filingRun: filingRun(issue) }),
          ...(reporter && {
            reporter: { at: reporter.time, actor: await actor(reporter.actor) },
            authorReply,
          }),
          labels: issue.labels,
          ready: ready
            ? {
                at: ready.time,
                actor: readyActor!,
                ...(contract?.triage && { triage: true as const }),
              }
            : null,
          ...(triage && {
            triage: { at: triage.time, actor: await actor(triage.actor) },
          }),
          editedAt: capabilities.bodyEditTime ? issue.bodyEditTime : null,
          contractHold: contract?.hold ?? null,
          nativeParent: issue.parent && id(issue.parent),
          // The platform reports when the latest sub-issue was linked, not
          // which.
          latestLink:
            capabilities.linkTime && issue.linkTime !== null
              ? { ticket: null, at: issue.linkTime }
              : null,
          linkAdditions:
            ready &&
            issue.subIssues.length > 0 &&
            capabilities.subIssueLinkAdditions
              ? await Promise.all(
                  (await issueTracker.subIssueLinkAdditions(issue.number)).map(
                    async (addition) => ({
                      ticket:
                        addition.subIssue === null
                          ? null
                          : id(addition.subIssue),
                      at: addition.time,
                      actor: await actor(addition.actor),
                    }),
                  ),
                )
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
      return state((await candidates(number, since)).found);
    },

    // A closing reference is observation, not delivery authorization. Only
    // the run branch or the supplied connection's verified identity owns a PR.
    // With `draft`, the owned open PR also says whether it is a draft.
    async pullRequestObservation(
      number: number,
      since?: string,
      draft = false,
      target?: number,
    ): Promise<{
      state: PullRequestState;
      closesIssue?: true;
      pullRequests: InputResume["pullRequests"];
      ownedPullRequests: number[];
      mergeCandidate?: MergeRelaunch & { draft?: true };
    }> {
      const { found, closing } = await candidates(number, since, target);
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
          pr.number === target ||
          pr.headBranch === runBranch(number) ||
          (viewer !== null &&
            pr.author?.login.toLowerCase() === viewer.login.toLowerCase()),
      );
      const pr = owned.length === 1 ? owned[0] : undefined;
      return {
        state: state(found),
        ownedPullRequests: owned.map((pr) => pr.number),
        pullRequests: found
          .filter((pr) => typeof pr.number === "number")
          .map(({ number, headBranch, state, createdAt }) => ({
            number,
            headBranch,
            state,
            createdAt,
          })),
        ...(state(found) === "merged" &&
          found.some(
            (pr) => pr.state === "merged" && closing.has(pr.number),
          ) && { closesIssue: true as const }),
        ...(pr && {
          mergeCandidate: {
            number: pr.number,
            headCommit: pr.headCommit,
            baseBranch: pr.baseBranch,
            createdAt: pr.createdAt,
            ...(draft && (await readDraft(pr.number)) && { draft: true }),
          },
        }),
      };
    },

    // Closed issues carrying any active state label, including questions
    // whose claims were already released.
    async readClosedClaims(): Promise<number[]> {
      const numbers = new Set<number>();
      for (const label of claimLabels(labels))
        for (const { number } of await issueTracker.issues({
          state: "closed",
          label,
        }))
          numbers.add(number);
      return [...numbers].sort((a, b) => a - b);
    },

    claim: (issue: number) => transition(issue, "claim"),

    // A claim ends without whichever of its running and paused labels it
    // carries.
    release: (issue: number) => transition(issue, "release"),

    // A closed issue no longer needs an owner's answer. Keep this separate
    // from release, which also settles open issues with pending questions.
    releaseClosed: (issue: number) => transition(issue, "closed"),

    async complete(issue: number) {
      // Clear failure before closure: closed-claim reconciliation can finish
      // active-label cleanup after a partial write without a failed-label sweep.
      await transition(issue, "complete");
      await issueTracker.closeIssue(issue);
      await transition(issue, "closed");
    },

    async fail(issue: number, comment: string) {
      await transition(issue, "fail");
      await issueTracker.createComment(issue, comment);
    },

    reconcileHolds: (
      issue: number,
      holds: { key: HoldKey; reason: string }[],
    ) => reconcileHolds(issueTracker, issue, holds),

    async awaitingMerge(issue: number, comment: string) {
      await issueTracker.createComment(issue, comment);
    },

    async pause(issue: number, comment: string) {
      await transition(issue, "pause");
      await issueTracker.createComment(issue, comment);
    },

    unpause: (issue: number) => transition(issue, "unpause"),

    // The platform's default close reason, completed on GitHub.
    async close(issue: number, tickets: IssueId[]) {
      await issueTracker.createComment(
        issue,
        renderComment("close", configuration.comments?.close, {
          tickets: tickets.map(reference),
        }),
      );
      await issueTracker.closeIssue(issue);
    },
  };
}

export type RepositoryPlatform = ReturnType<typeof repositoryPlatform>;
