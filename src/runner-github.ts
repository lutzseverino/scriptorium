// Runner event delivery's reads on GitHub, through Postern's authenticated
// GraphQL fallback. GraphQL's issue connections hold issues only, so no pull
// request or comment on one reaches issue-contract delivery, whereas GitHub's
// REST issue and issue-comment reads would include them.
// https://docs.github.com/en/graphql/reference/objects#repository
import {
  PlatformError,
  type Account,
  type Connection,
} from "@lutzseverino/postern";
import type {
  RunnerChange,
  RunnerComment,
  RunnerIssue,
  RunnerPullRequest,
  RunnerReads,
} from "./runner.ts";

type Actor = { __typename?: string; login?: string } | null;
type Page<T> = {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

const actor = `{ __typename login }`;

export function githubRunnerReads(connection: Connection): RunnerReads {
  const [owner, name] = connection.repository.path.split("/");

  async function query(
    text: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, any>> {
    const response = await connection.access.request({
      method: "POST",
      path: "/graphql",
      body: {
        query: text,
        variables: text.includes("$owner")
          ? { owner, name, ...variables }
          : variables,
      },
    });
    const result = response.data as {
      errors?: unknown;
      data?: Record<string, any>;
    } | null;
    if (result?.errors || !result?.data)
      throw new PlatformError(
        "invalidResponse",
        `Runner delivery read ${/query (\w+)/.exec(text)?.[1]} failed`,
      );
    return result.data;
  }

  // Every page of a connection that `select` finds in the response.
  async function pages<T>(
    text: string,
    variables: Record<string, unknown>,
    select: (data: Record<string, any>) => Page<T> | undefined,
  ): Promise<T[]> {
    const items: T[] = [];
    let after: string | null = null;
    for (;;) {
      const page = select(await query(text, { ...variables, after }));
      if (!page || !Array.isArray(page.nodes))
        throw new PlatformError(
          "invalidResponse",
          `Runner delivery read ${/query (\w+)/.exec(text)?.[1]} returned no page`,
        );
      items.push(...page.nodes);
      if (!page.pageInfo?.hasNextPage) return items;
      if (!page.pageInfo.endCursor || page.pageInfo.endCursor === after)
        throw new PlatformError(
          "invalidResponse",
          "Runner delivery read a page without a next cursor",
        );
      after = page.pageInfo.endCursor;
    }
  }

  const issues = (states: string[] | null, since: string | null) =>
    pages<{ number: number; createdAt: string; author: Actor }>(
      `query RunnerIssues($owner: String!, $name: String!, $after: String, $states: [IssueState!], $since: DateTime) {
        repository(owner: $owner, name: $name) {
          issues(first: 100, after: $after, states: $states, filterBy: { since: $since }, orderBy: { field: UPDATED_AT, direction: ASC }) {
            nodes { number createdAt author ${actor} }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { states, since },
      (data) => data.repository?.issues,
    ).then((nodes) =>
      nodes.map((node): RunnerIssue => ({
        number: node.number,
        createdAt: node.createdAt,
        author: account(node.author),
      })),
    );

  return {
    openIssues: () => issues(["OPEN"], null),
    changedIssues: (since) => issues(null, since),

    async changes(number, since) {
      let edits: {
        id: string;
        editedAt: string;
        editor: Actor;
      }[] = [];
      let createdAt = "";
      const items = await pages<Record<string, any>>(
        `query RunnerIssueChanges($owner: String!, $name: String!, $number: Int!, $since: DateTime!, $after: String) {
          repository(owner: $owner, name: $name) {
            issue(number: $number) {
              createdAt
              userContentEdits(first: 100) { nodes { id editedAt editor ${actor} } }
              timelineItems(first: 100, after: $after, since: $since, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, CLOSED_EVENT, REOPENED_EVENT, RENAMED_TITLE_EVENT, COMMENT_DELETED_EVENT]) {
                nodes {
                  __typename
                  ... on LabeledEvent { id createdAt actor ${actor} label { name } }
                  ... on UnlabeledEvent { id createdAt actor ${actor} label { name } }
                  ... on ClosedEvent { id createdAt actor ${actor} }
                  ... on ReopenedEvent { id createdAt actor ${actor} }
                  ... on RenamedTitleEvent { id createdAt actor ${actor} }
                  ... on CommentDeletedEvent { id createdAt actor ${actor} deletedCommentAuthor ${actor} }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        { number, since },
        (data) => {
          const issue = data.repository?.issue;
          createdAt = issue?.createdAt ?? createdAt;
          if (Array.isArray(issue?.userContentEdits?.nodes))
            edits = issue.userContentEdits.nodes;
          return issue?.timelineItems;
        },
      );
      const changes: RunnerChange[] = [];
      for (const item of items) {
        const base = {
          id: item.id,
          at: item.createdAt,
          actor: account(item.actor),
        };
        if (item.__typename === "LabeledEvent")
          changes.push({ ...base, kind: "labeled", label: item.label.name });
        else if (item.__typename === "UnlabeledEvent")
          changes.push({ ...base, kind: "unlabeled", label: item.label.name });
        else if (item.__typename === "ClosedEvent")
          changes.push({ ...base, kind: "closed" });
        else if (item.__typename === "ReopenedEvent")
          changes.push({ ...base, kind: "reopened" });
        else if (item.__typename === "RenamedTitleEvent")
          changes.push({ ...base, kind: "edited", bodyChanged: false });
        else if (item.__typename === "CommentDeletedEvent")
          changes.push({
            ...base,
            kind: "commentDeleted",
            author: account(item.deletedCommentAuthor)?.login ?? null,
          });
      }
      // The oldest edit record is the issue's creation, not an edit.
      for (const edit of edits)
        if (
          Date.parse(edit.editedAt) >= Date.parse(since) &&
          Date.parse(edit.editedAt) > Date.parse(createdAt)
        )
          changes.push({
            id: edit.id,
            at: edit.editedAt,
            actor: account(edit.editor),
            kind: "edited",
            bodyChanged: true,
          });
      return changes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    },

    async comments(number) {
      const nodes = await pages<Record<string, any>>(
        `query RunnerIssueComments($owner: String!, $name: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $name) {
            issue(number: $number) {
              comments(first: 100, after: $after) {
                nodes { id fullDatabaseId body createdAt lastEditedAt author ${actor} editor ${actor} }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        { number },
        (data) => data.repository?.issue?.comments,
      );
      return nodes.map((node): RunnerComment => ({
        id: Number(node.fullDatabaseId),
        nodeId: node.id,
        body: node.body,
        author: account(node.author),
        editor: account(node.editor),
        createdAt: node.createdAt,
        editedAt: node.lastEditedAt ?? node.createdAt,
      }));
    },

    async openPullRequests() {
      const nodes = await pages<Record<string, any>>(
        `query RunnerPullRequests($owner: String!, $name: String!, $after: String) {
          repository(owner: $owner, name: $name) {
            pullRequests(first: 50, after: $after, states: OPEN) {
              nodes { number title body isDraft headRefOid baseRefOid baseRefName isCrossRepository }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        {},
        (data) => data.repository?.pullRequests,
      );
      return nodes.map((node): RunnerPullRequest => ({
        number: node.number,
        head: node.headRefOid,
        base: node.baseRefOid,
        baseBranch: node.baseRefName,
        title: node.title,
        body: node.body,
        draft: node.isDraft,
        crossRepository: node.isCrossRepository,
      }));
    },

    // GraphQL's viewer also identifies an installation token.
    async account() {
      const data = await query(
        `query RunnerFactoryAccount { viewer ${actor} }`,
        {},
      );
      const viewer = account(data.viewer);
      if (!viewer)
        throw new PlatformError(
          "invalidResponse",
          "The factory's account could not be read",
        );
      return viewer;
    },
  };
}

// An account as REST and webhooks name it: GraphQL drops a bot's `[bot]`.
function account(value: Actor): Account | null {
  if (!value || typeof value.login !== "string" || !value.login) return null;
  const bot = value.__typename === "Bot";
  return {
    login: bot ? `${value.login.replace(/\[bot\]$/i, "")}[bot]` : value.login,
    bot,
  };
}
