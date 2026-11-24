// One in-memory GitHub repository behind Postern's real GitHub adapter, for
// runner delivery: its issues and pull requests share one number space, each
// person's write is recorded as GitHub's timeline records it, and the
// requests both the runner's reads and Repo Canon's installed validator make
// are served from the same state.
export const worldRepository = "acme/widgets";

export type WorldComment = {
  id: number;
  body: string;
  author: string;
  editor: string | null;
  createdAt: string;
  lastEditedAt: string | null;
};
type WorldEvent = {
  id: number;
  type:
    | "labeled"
    | "unlabeled"
    | "closed"
    | "reopened"
    | "renamed"
    | "commentDeleted";
  actor: string;
  at: string;
  label?: string;
  deletedAuthor?: string;
};
export type WorldItem = {
  number: number;
  pull: boolean;
  state: "open" | "closed";
  title: string;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  lastEditedAt: string | null;
  labels: string[];
  comments: WorldComment[];
  events: WorldEvent[];
  edits: { id: string; editedAt: string; editor: string }[];
  head?: string;
  base?: string;
  draft?: boolean;
  crossRepository?: boolean;
};

const isBot = (login: string) => login.endsWith("[bot]");
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
const page = (nodes: unknown[]) => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});

// The world starts at the current second, since the installed validator
// stamps its notices with the real clock.
export function runnerWorld({
  start = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
  roles = { maintainer: "admin" } as Record<string, string>,
  // The account the factory's own token reads as.
  factory = "factory[bot]",
} = {}) {
  let clock = Date.parse(start);
  let nextId = 100;
  const items: WorldItem[] = [];
  const files = new Map<string, { sha: string; value: unknown }>();
  const requests: {
    method: string;
    path: string;
    login: string;
    query?: string;
  }[] = [];

  const stamp = () => new Date(clock).toISOString().replace(".000Z", "Z");
  // Every write takes the current second, then the clock moves on.
  const at = () => {
    const value = stamp();
    clock += 1000;
    return value;
  };
  const find = (number: number) => {
    const item = items.find((candidate) => candidate.number === number);
    if (!item) throw new Error(`#${number} does not exist`);
    return item;
  };
  const touch = (item: WorldItem, time: string) => (item.updatedAt = time);
  const graphqlActor = (login: string | null) =>
    login === null
      ? null
      : isBot(login)
        ? { __typename: "Bot", login: login.slice(0, -5) }
        : { __typename: "User", login };
  const restActor = (login: string) => ({
    login,
    type: isBot(login) ? "Bot" : "User",
  });

  function open(
    pull: boolean,
    {
      title = "Fixture request",
      body = "Intake context.",
      author = "reporter",
      labels = [] as string[],
      state = "open" as "open" | "closed",
      head,
      base,
      draft = false,
      crossRepository = false,
    }: Partial<WorldItem> = {},
  ): WorldItem {
    const time = at();
    const item: WorldItem = {
      number: items.length + 1,
      pull,
      state,
      title,
      body,
      author,
      createdAt: time,
      updatedAt: time,
      lastEditedAt: null,
      labels: [...labels],
      comments: [],
      events: labels.map((label) => ({
        id: nextId++,
        type: "labeled",
        actor: author,
        at: time,
        label,
      })),
      edits: [],
      ...(pull && { head, base, draft, crossRepository }),
    };
    items.push(item);
    return item;
  }

  function record(item: WorldItem, event: Omit<WorldEvent, "id" | "at">) {
    const time = at();
    item.events.push({ ...event, id: nextId++, at: time });
    touch(item, time);
  }

  const restComment = (comment: WorldComment, number: number) => ({
    id: comment.id,
    node_id: `IC_${comment.id}`,
    html_url: `https://github.com/${worldRepository}/issues/${number}#issuecomment-${comment.id}`,
    user: restActor(comment.author),
    body: comment.body,
    created_at: comment.createdAt,
    updated_at: comment.lastEditedAt ?? comment.createdAt,
  });

  function issueNode(item: WorldItem) {
    return {
      number: item.number,
      fullDatabaseId: String(item.number),
      id: `I_${item.number}`,
      url: `https://github.com/${worldRepository}/issues/${item.number}`,
      state: item.state.toUpperCase(),
      title: item.title,
      body: item.body,
      createdAt: item.createdAt,
      lastEditedAt: item.lastEditedAt,
      author: graphqlActor(item.author),
      labels: page(item.labels.map((name) => ({ name }))),
      parent: null,
      subIssues: page([]),
      blockedBy: page([]),
      timelineItems: { nodes: [] },
    };
  }

  function timelineNode(event: WorldEvent) {
    const typename = {
      labeled: "LabeledEvent",
      unlabeled: "UnlabeledEvent",
      closed: "ClosedEvent",
      reopened: "ReopenedEvent",
      renamed: "RenamedTitleEvent",
      commentDeleted: "CommentDeletedEvent",
    }[event.type];
    return {
      __typename: typename,
      id: `EV_${event.id}`,
      createdAt: event.at,
      actor: graphqlActor(event.actor),
      ...(event.label !== undefined && { label: { name: event.label } }),
      ...(event.type === "commentDeleted" && {
        deletedCommentAuthor: graphqlActor(event.deletedAuthor ?? null),
      }),
    };
  }

  function graphql(
    query: string,
    variables: Record<string, any>,
    login: string,
  ): unknown {
    const name = /query (\w+)/.exec(query)?.[1];
    const issues = items.filter((item) => !item.pull);
    const issueAt = (number: number) =>
      issues.find((item) => item.number === number) ?? null;
    switch (name) {
      case "RunnerFactoryAccount":
      case "TriageActingAccount":
        return { viewer: graphqlActor(login) };
      case "RunnerIssues": {
        const since = variables.since ? Date.parse(variables.since) : null;
        return {
          repository: {
            issues: page(
              issues
                .filter(
                  (item) =>
                    (!variables.states ||
                      variables.states.includes(item.state.toUpperCase())) &&
                    (since === null || Date.parse(item.updatedAt) >= since),
                )
                .sort(
                  (a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt),
                )
                .map((item) => ({
                  number: item.number,
                  createdAt: item.createdAt,
                  author: graphqlActor(item.author),
                })),
            ),
          },
        };
      }
      case "RunnerIssueChanges": {
        const item = issueAt(variables.number);
        const since = Date.parse(variables.since);
        return {
          repository: {
            issue: item && {
              createdAt: item.createdAt,
              userContentEdits: {
                nodes: [
                  ...item.edits.map((edit) => ({
                    id: edit.id,
                    editedAt: edit.editedAt,
                    editor: graphqlActor(edit.editor),
                  })),
                  ...(item.edits.length
                    ? [
                        {
                          id: `EDIT_created_${item.number}`,
                          editedAt: item.createdAt,
                          editor: graphqlActor(item.author),
                        },
                      ]
                    : []),
                ].reverse(),
              },
              timelineItems: page(
                item.events
                  .filter((event) => Date.parse(event.at) >= since)
                  .map(timelineNode),
              ),
            },
          },
        };
      }
      case "RunnerIssueComments": {
        const item = issueAt(variables.number);
        return {
          repository: {
            issue: item && {
              comments: page(
                item.comments.map((comment) => ({
                  id: `IC_${comment.id}`,
                  fullDatabaseId: String(comment.id),
                  body: comment.body,
                  createdAt: comment.createdAt,
                  lastEditedAt: comment.lastEditedAt,
                  author: graphqlActor(comment.author),
                  editor: graphqlActor(comment.editor),
                })),
              ),
            },
          },
        };
      }
      case "RunnerPullRequests":
        return {
          repository: {
            pullRequests: page(
              items
                .filter((item) => item.pull && item.state === "open")
                .map((item) => ({
                  number: item.number,
                  title: item.title,
                  body: item.body,
                  isDraft: item.draft,
                  headRefOid: item.head,
                  baseRefOid: item.base,
                  baseRefName: "main",
                  isCrossRepository: item.crossRepository,
                })),
            ),
          },
        };
      case "ContractSourceEdits":
        return {
          nodes: variables.ids.map((id: string) => {
            const issue = issues.find((item) => `I_${item.number}` === id);
            const comment = items
              .flatMap((item) => item.comments)
              .find((comment) => `IC_${comment.id}` === id);
            const editedAt = issue?.lastEditedAt ?? comment?.lastEditedAt;
            return issue || comment
              ? {
                  id,
                  lastEditedAt: editedAt ?? null,
                  userContentEdits: {
                    nodes: editedAt
                      ? [{ id: `EDIT_${id}_${editedAt}`, editedAt }]
                      : [],
                  },
                }
              : null;
          }),
        };
      case "PosternIssues":
        return {
          repository: {
            issues: page(
              issues
                .filter((item) =>
                  variables.states.includes(item.state.toUpperCase()),
                )
                .map(issueNode),
            ),
          },
        };
      case "PosternIssue": {
        const item = issueAt(variables.number);
        return { repository: { issue: item && issueNode(item) } };
      }
    }
    throw new Error(`Unexpected world query ${name}`);
  }

  // The transport for one account's credential.
  function fetchAs(login: string): typeof fetch {
    return async (input, init = {}) => {
      const url = new URL(String(input));
      const path = url.pathname;
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : null;
      const repo = `/repos/${worldRepository}`;
      requests.push({
        method,
        path,
        login,
        ...(path === "/graphql" && {
          query: /query (\w+)/.exec(body.query)?.[1],
        }),
      });
      if (path === "/graphql") {
        const data = graphql(body.query, body.variables ?? {}, login);
        return json({ data });
      }
      if (path === `${repo}/actions/variables/REPO_CANON_RUNNER_ACCOUNT`)
        return json({ message: "Not found" }, 404);
      if (path === repo) return json({ default_branch: "main" });
      if (path === `${repo}/git/ref/heads/main`)
        return json({ object: { sha: "b".repeat(40) } });
      if (path.includes("/contents/")) {
        const name = path.split("/contents/")[1];
        if (method === "PUT") {
          const sha = `file-${nextId++}`;
          files.set(name, {
            sha,
            value: JSON.parse(Buffer.from(body.content, "base64").toString()),
          });
          return json({ content: { sha } });
        }
        const found =
          name === ".github/issue-contracts.json"
            ? { sha: "configuration", value: { mode: "prepared" } }
            : files.get(name);
        if (!found) return json({ message: "Not found" }, 404);
        const content = Buffer.from(JSON.stringify(found.value));
        return json({
          type: "file",
          encoding: "base64",
          sha: found.sha,
          size: content.length,
          content: content.toString("base64"),
        });
      }
      if (path.endsWith("/permission")) {
        const name = decodeURIComponent(path.split("/").at(-2)!);
        return roles[name]
          ? json({ permission: roles[name], role_name: roles[name] })
          : json({ permission: "none", role_name: "none" });
      }
      if (path === `${repo}/labels` && method === "GET") return json([]);
      if (path === `${repo}/labels` && method === "POST")
        return json({ ...body }, 201);
      const comments = /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(
        path,
      );
      if (comments && method === "PATCH") {
        const item = items.find((item) =>
          item.comments.some((comment) => comment.id === Number(comments[1])),
        )!;
        const comment = world.editComment(
          item.number,
          Number(comments[1]),
          body.body,
          login,
        );
        return json(restComment(comment, item.number));
      }
      const match =
        /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/(comments|events|labels)(?:\/(.+))?$/.exec(
          path,
        );
      if (match) {
        const item = find(Number(match[1]));
        if (match[2] === "comments" && method === "GET")
          return json(
            item.comments.map((comment) => restComment(comment, item.number)),
          );
        if (match[2] === "comments" && method === "POST")
          return json(
            restComment(
              world.comment(item.number, body.body, login),
              item.number,
            ),
            201,
          );
        if (match[2] === "events")
          return json(
            item.events
              .filter((event) => ["labeled", "unlabeled"].includes(event.type))
              .map((event) => ({
                id: event.id,
                event: event.type,
                label: { name: event.label },
                actor: restActor(event.actor),
                created_at: event.at,
              })),
          );
        if (match[2] === "labels" && method === "POST") {
          for (const name of body.labels) world.label(item.number, name, login);
          return json(item.labels.map((name) => ({ name })));
        }
        if (match[2] === "labels" && method === "DELETE") {
          world.unlabel(item.number, decodeURIComponent(match[3]!), login);
          return new Response(null, { status: 204 });
        }
      }
      throw new Error(`Unexpected world request ${method} ${path}`);
    };
  }

  const world = {
    items,
    files,
    requests,
    factory,
    now: () => new Date(clock),
    // Moves the clock on, as time between passes does.
    wait(seconds: number) {
      clock += seconds * 1000;
    },
    fetchAs,
    openIssue: (options: Partial<WorldItem> = {}) => open(false, options),
    openPull: (options: Partial<WorldItem> = {}) => open(true, options),
    label(number: number, label: string, login: string) {
      const item = find(number);
      if (item.labels.includes(label)) return;
      item.labels.push(label);
      record(item, { type: "labeled", actor: login, label });
    },
    unlabel(number: number, label: string, login: string) {
      const item = find(number);
      if (!item.labels.includes(label)) return;
      item.labels.splice(item.labels.indexOf(label), 1);
      record(item, { type: "unlabeled", actor: login, label });
    },
    close(number: number, login: string) {
      find(number).state = "closed";
      record(find(number), { type: "closed", actor: login });
    },
    reopen(number: number, login: string) {
      find(number).state = "open";
      record(find(number), { type: "reopened", actor: login });
    },
    rename(number: number, title: string, login: string) {
      find(number).title = title;
      record(find(number), { type: "renamed", actor: login });
    },
    editBody(number: number, body: string, login: string) {
      const item = find(number);
      const time = at();
      item.body = body;
      item.lastEditedAt = time;
      item.edits.push({
        id: `EDIT_${nextId++}`,
        editedAt: time,
        editor: login,
      });
      touch(item, time);
    },
    comment(number: number, body: string, login: string): WorldComment {
      const item = find(number);
      const time = at();
      const comment: WorldComment = {
        id: nextId++,
        body,
        author: login,
        editor: null,
        createdAt: time,
        lastEditedAt: null,
      };
      item.comments.push(comment);
      touch(item, time);
      return comment;
    },
    editComment(
      number: number,
      id: number,
      body: string,
      login: string,
    ): WorldComment {
      const item = find(number);
      const comment = item.comments.find((comment) => comment.id === id)!;
      const time = at();
      comment.body = body;
      comment.editor = login;
      comment.lastEditedAt = time;
      touch(item, time);
      return comment;
    },
    deleteComment(number: number, id: number, login: string) {
      const item = find(number);
      const index = item.comments.findIndex((comment) => comment.id === id);
      const [comment] = item.comments.splice(index, 1);
      record(item, {
        type: "commentDeleted",
        actor: login,
        deletedAuthor: comment!.author,
      });
    },
    push(number: number, head: string) {
      const item = find(number);
      item.head = head;
      touch(item, at());
    },
    editPull(number: number, fields: Partial<WorldItem>) {
      Object.assign(find(number), fields);
      touch(find(number), at());
    },
  };
  return world;
}

export type RunnerWorld = ReturnType<typeof runnerWorld>;
