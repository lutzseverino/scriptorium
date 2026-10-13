// One repository's GitHub reads and writes, through the GitHub CLI with that
// repository's token.
import type { FactoryConfiguration } from "./factory-configuration.ts";
import {
  reference,
  type Issue,
  type IssueId,
  type PullRequestState,
} from "./factory.ts";

// Runs the GitHub CLI and resolves its standard output.
export type GitHubCli = (args: string[]) => Promise<string>;

// A page holds 25 issues so the query stays within GitHub's limit of 500,000
// requested nodes.
export const issuesQuery = `query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 25, after: $endCursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        createdAt
        labels(first: 100) { nodes { name } }
        parent { number repository { nameWithOwner } }
        subIssues(first: 100) { nodes { number repository { nameWithOwner } state } }
        blockedBy(first: 100) { nodes { number state } }
        labelEvents: timelineItems(itemTypes: [LABELED_EVENT], last: 100) { nodes { ... on LabeledEvent { createdAt label { name } } } }
        linkEvents: timelineItems(itemTypes: [SUB_ISSUE_ADDED_EVENT], last: 1) { nodes { ... on SubIssueAddedEvent { createdAt subIssue { number repository { nameWithOwner } } } } }
      }
    }
  }
}`;

const pullRequestsQuery = `query($owner: String!, $name: String!, $number: Int!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      state
      closedByPullRequestsReferences(first: 20, includeClosedPrs: true) { nodes { state createdAt isCrossRepository } }
    }
    pullRequests(headRefName: $branch, first: 20) { nodes { state createdAt isCrossRepository } }
  }
}`;

// The branch an issue's runs use.
export function runBranch(issue: number): string {
  return `factory/issue-${issue}`;
}

// `repository` is `<owner>/<name>`.
export function repositoryGitHub(
  repository: string,
  labels: FactoryConfiguration["labels"],
  gh: GitHubCli,
) {
  const [owner, name] = repository.split("/");
  const identity = ["-F", `owner=${owner}`, "-F", `name=${name}`];
  // An issue as the decision core identifies it: its number in this
  // repository, or `<owner>/<name>#<n>` in another.
  const id = (node: {
    number: number;
    repository: { nameWithOwner: string };
  }): IssueId =>
    node.repository.nameWithOwner.toLowerCase() === repository.toLowerCase()
      ? node.number
      : `${node.repository.nameWithOwner}#${node.number}`;
  const edit = (issue: number, ...args: string[]) =>
    gh(["issue", "edit", String(issue), "--repo", repository, ...args]);

  return {
    async createStateLabels(): Promise<void> {
      for (const [role, color] of [
        ["running", "0052cc"],
        ["failed", "b60205"],
        ["needsInput", "fbca04"],
      ] as const)
        await gh([
          "label",
          "create",
          labels[role],
          "--repo",
          repository,
          "--color",
          color,
          "--description",
          `Factory state: ${role}`,
          "--force",
        ]);
    },

    async readIssues(): Promise<Issue[]> {
      const pages = JSON.parse(
        await gh([
          "api",
          "graphql",
          "--paginate",
          "--slurp",
          "-f",
          `query=${issuesQuery}`,
          ...identity,
        ]),
      );
      const names = (connection: { nodes: { name: string }[] }) =>
        connection.nodes.map((label) => label.name);
      const state = (value: string) => (value === "OPEN" ? "open" : "closed");
      return pages.flatMap((page: any) =>
        page.data.repository.issues.nodes.map((node: any): Issue => {
          const link = node.linkEvents.nodes.at(-1);
          return {
            number: node.number,
            createdAt: node.createdAt,
            labels: names(node.labels),
            // Events arrive oldest first, so the last match is the latest.
            readyAt:
              node.labelEvents.nodes.findLast(
                (event: any) => event.label?.name === labels.ready,
              )?.createdAt ?? null,
            nativeParent: node.parent ? id(node.parent) : null,
            latestLink: link
              ? {
                  ticket: link.subIssue ? id(link.subIssue) : null,
                  at: link.createdAt,
                }
              : null,
            subIssues: node.subIssues.nodes.map((child: any) => ({
              number: id(child),
              state: state(child.state),
            })),
            blockedBy: node.blockedBy.nodes.map((blocker: any) => ({
              number: blocker.number,
              state: state(blocker.state),
            })),
          };
        }),
      );
    },

    // A run's pull request is one from this repository, not a fork, that
    // closes its issue or comes from the run's branch, opened since the first
    // attempt started (`since`), so an earlier run's pull requests don't
    // decide it. Only a closed issue counts as merged work. An open pull
    // request holds the claim; a merged pull request with the issue still
    // open and none open is its own state.
    async pullRequestState(
      number: number,
      since?: string,
    ): Promise<PullRequestState> {
      const response = JSON.parse(
        await gh([
          "api",
          "graphql",
          "-f",
          `query=${pullRequestsQuery}`,
          ...identity,
          "-F",
          `number=${number}`,
          "-F",
          `branch=${runBranch(number)}`,
        ]),
      );
      const { issue, pullRequests } = response.data.repository;
      const states = [
        ...issue.closedByPullRequestsReferences.nodes,
        ...pullRequests.nodes,
      ]
        .filter(
          (pullRequest: { createdAt: string; isCrossRepository: boolean }) =>
            !pullRequest.isCrossRepository &&
            (since === undefined ||
              Date.parse(pullRequest.createdAt) >= Date.parse(since)),
        )
        .map((pullRequest: { state: string }) => pullRequest.state);
      if (issue.state === "CLOSED") return "merged";
      if (states.includes("OPEN")) return "open";
      if (states.includes("MERGED")) return "merged-issue-open";
      return states.includes("CLOSED") ? "closed" : "none";
    },

    // The closed issues still carrying the running label.
    async readClosedClaims(): Promise<number[]> {
      const closed: { number: number }[] = JSON.parse(
        await gh([
          "issue",
          "list",
          "--repo",
          repository,
          "--state",
          "closed",
          "--label",
          labels.running,
          "--json",
          "number",
          "--limit",
          "1000",
        ]),
      );
      return closed.map(({ number }) => number);
    },

    claim: (issue: number) => edit(issue, "--add-label", labels.running),

    release: (issue: number) => edit(issue, "--remove-label", labels.running),

    async fail(issue: number, comment: string) {
      await edit(
        issue,
        "--remove-label",
        labels.running,
        "--add-label",
        labels.failed,
      );
      await gh([
        "issue",
        "comment",
        String(issue),
        "--repo",
        repository,
        "--body",
        comment,
      ]);
    },

    async close(issue: number, tickets: IssueId[]) {
      await gh([
        "issue",
        "close",
        String(issue),
        "--repo",
        repository,
        "--reason",
        "completed",
        "--comment",
        [
          "_This was generated by AI._",
          "",
          "All sub-issues are closed. Closing this parent.",
          "",
          ...tickets.map((ticket) => `- ${reference(ticket)}`),
        ].join("\n"),
      ]);
    },
  };
}

export type RepositoryGitHub = ReturnType<typeof repositoryGitHub>;
