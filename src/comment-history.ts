import {
  PlatformError,
  type Access,
  type Comment,
} from "@lutzseverino/postern";

// GitHub returns the Markdown at each edit in `diff`, including creation.
// Require all revisions, no redactions, and a current revision matching the
// comment snapshot before using them to rule out an erased Brief heading.
export async function commentHistory(
  access: Access,
  comment: Comment,
): Promise<string[]> {
  const revisions: string[] = [];
  let after: string | null = null;
  const cursors = new Set<string>();
  do {
    const response = await access.request({
      method: "POST",
      path: "/graphql",
      body: {
        query: `query FactoryCommentEdits($id: ID!, $after: String) {
        node(id: $id) { ... on IssueComment {
            body updatedAt lastEditedAt includesCreatedEdit
          userContentEdits(first: 100, after: $after) {
            nodes { diff deletedAt }
            pageInfo { hasNextPage endCursor }
          }
        } }
      }`,
        variables: { id: comment.nodeId, after },
      },
    });
    const result = response.data as {
      errors?: unknown;
      data?: {
        node?: {
          body?: unknown;
          updatedAt?: unknown;
          lastEditedAt?: unknown;
          includesCreatedEdit?: unknown;
          userContentEdits?: {
            nodes?: { diff?: unknown; deletedAt?: unknown }[];
            pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
          };
        };
      };
    } | null;
    const node = result?.data?.node;
    const edits = node?.userContentEdits;
    const page = edits?.pageInfo;
    if (
      result?.errors ||
      !comment.nodeId ||
      node?.body !== comment.body ||
      node.updatedAt !== comment.updatedAt
    )
      throw new PlatformError(
        "invalidResponse",
        "Comment edit snapshot could not be read",
      );
    // REST's equal creation/update seconds do not prove a comment unedited.
    // Native nullable edit metadata does, including edits within that second.
    if (node.lastEditedAt === null) return [comment.body];
    if (
      node.includesCreatedEdit !== true ||
      typeof node.lastEditedAt !== "string" ||
      !Number.isFinite(Date.parse(node.lastEditedAt)) ||
      !Array.isArray(edits?.nodes) ||
      edits.nodes.length === 0 ||
      !page ||
      typeof page.hasNextPage !== "boolean" ||
      edits.nodes.some(
        (edit) => typeof edit?.diff !== "string" || edit.deletedAt !== null,
      ) ||
      (page.hasNextPage &&
        (typeof page.endCursor !== "string" || cursors.has(page.endCursor)))
    )
      throw new PlatformError(
        "invalidResponse",
        "Complete comment edit history could not be read",
      );
    revisions.push(...edits.nodes.map((edit) => edit.diff as string));
    after = page.hasNextPage ? (page.endCursor as string) : null;
    if (after !== null) cursors.add(after);
  } while (after !== null);
  if (!revisions.includes(comment.body))
    throw new PlatformError(
      "invalidResponse",
      "Comment edit history does not contain its current revision",
    );
  return revisions;
}
