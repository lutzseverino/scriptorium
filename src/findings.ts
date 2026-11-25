// A run's findings as the host files them: each new finding becomes an issue
// in its target repository, labelled with that repository's triage state and
// citing the filing run, and each recurrence one comment on an existing
// issue. The run wrote every text in final form, so the host adds only the
// citation and edits nothing it posts. Each write is recorded before and
// after it is made, so a restart finds an interrupted write instead of
// making it twice.
import {
  PlatformError,
  type ConnectionWithLinkAdditions,
} from "@lutzseverino/postern";
import { contain, type Finding, type RunResult } from "./run-result.ts";

// What became of one finding.
export type FindingRecord =
  // A write began at `at` and may have landed.
  | { state: "attempted"; at: string }
  // The new issue, as `<owner>/<name>#<number>`.
  | { state: "filed"; issue: string; url: string }
  // The existing issue and the recurrence comment posted on it.
  | { state: "linked"; issue: string; url: string }
  | { state: "unfiled"; reason: string }
  | { state: "invalid"; reason: string };

// One target repository's finding writes.
export type FindingTarget = {
  // Creates the issue in the repository's triage state.
  create(title: string, body: string): Promise<{ number: number; url: string }>;
  // The issue with exactly this title and body updated since `since`, which
  // an interrupted create may have left.
  created(
    title: string,
    body: string,
    since: string,
  ): Promise<{ number: number; url: string } | null>;
  // Posts the comment on the issue, unless `retry` finds it already posted,
  // and resolves its link.
  comment(issue: number, body: string, retry: boolean): Promise<string>;
};

// A GitHub repository as the target of a run's findings, through its
// Postern connection: issues created with the repository's triage label, and
// comments on its existing issues. Postern has no issue creation port, so
// creation, the read that finds an interrupted one and the read that tells an
// issue from a pull request use GitHub's REST API on its authenticated
// transport.
// https://docs.github.com/en/rest/issues/issues#create-an-issue
// https://docs.github.com/en/rest/issues/issues#list-repository-issues
// https://docs.github.com/en/rest/issues/issues#get-an-issue
export function findingTarget(
  connection: ConnectionWithLinkAdditions,
  triage: string,
): FindingTarget {
  const { access, issueTracker } = connection;
  const path = connection.repository.path;
  const issue = (data: unknown) => {
    const { number, html_url: url } = (data ?? {}) as {
      number?: unknown;
      html_url?: unknown;
    };
    if (!Number.isSafeInteger(number) || typeof url !== "string")
      throw new PlatformError(
        "invalidResponse",
        "The filed issue could not be read",
      );
    return { number: number as number, url };
  };
  const lines = (text: unknown) =>
    typeof text === "string" ? text.replace(/\r\n?/g, "\n") : text;
  return {
    async create(title, body) {
      const response = await access.request({
        method: "POST",
        path: `/repos/${path}/issues`,
        body: { title, body, labels: [triage] },
      });
      return issue(response.data);
    },
    async created(title, body, since) {
      const pages = await access.requestPages({
        path: `/repos/${path}/issues`,
        query: { state: "all", since, per_page: 100 },
      });
      for (const page of pages) {
        if (!Array.isArray(page.data))
          throw new PlatformError(
            "invalidResponse",
            "The repository's issues could not be read",
          );
        const found = (page.data as Record<string, unknown>[]).find(
          (item) =>
            !item?.pull_request &&
            item?.title === title &&
            lines(item?.body) === lines(body),
        );
        if (found) return issue(found);
      }
      return null;
    },
    async comment(number, body, retry) {
      const existing = await access.request({
        path: `/repos/${path}/issues/${number}`,
      });
      if ((existing.data as { pull_request?: unknown })?.pull_request)
        throw new PlatformError(
          "notFound",
          `#${number} is a pull request, not an issue`,
        );
      const posted =
        retry &&
        (await issueTracker.comments(number)).find(
          (comment) => lines(comment.body) === lines(body),
        );
      return (posted || (await issueTracker.createComment(number, body))).url;
    },
  };
}

export type FindingTargets = (
  repository: string,
) => Promise<FindingTarget | { unfiled: string }>;

// A refusal the platform would repeat leaves the finding unfiled; any other
// failure rejects, and a later pass retries the finding.
const refusals = new Set<PlatformError["reason"]>([
  "unauthenticated",
  "forbidden",
  "notFound",
  "conflict",
  "rejected",
  "unsupported",
]);

// An interrupted create landed within this long before its record.
const createdWindow = 60 * 60_000;

// Files each finding without a final record into `records`, in order, saving
// after every change. `citation` is the run's filing citation line, null when
// the run has no filing provenance to cite.
export async function fileFindings(
  findings: Finding[],
  records: (FindingRecord | undefined)[],
  options: {
    targets: FindingTargets;
    citation: string | null;
    now: () => Date;
    save: () => void;
  },
): Promise<void> {
  const targets = new Map<string, ReturnType<FindingTargets>>();
  const settle = (index: number, record: FindingRecord) => {
    records[index] = record;
    options.save();
  };
  for (const [index, finding] of findings.entries()) {
    const previous = records[index];
    if (previous && previous.state !== "attempted") continue;
    if ("invalid" in finding) {
      settle(index, { state: "invalid", reason: finding.invalid });
      continue;
    }
    if ("title" in finding && options.citation === null) {
      settle(index, {
        state: "unfiled",
        reason: "the run has no filing provenance to cite",
      });
      continue;
    }
    const key = finding.repository.toLowerCase();
    if (!targets.has(key))
      targets.set(key, options.targets(finding.repository));
    const target = await targets.get(key)!;
    if ("unfiled" in target) {
      settle(index, { state: "unfiled", reason: target.unfiled });
      continue;
    }
    const attempted = previous?.at;
    if (!attempted)
      settle(index, { state: "attempted", at: options.now().toISOString() });
    try {
      if ("title" in finding) {
        const body = `${finding.body}\n\n${options.citation}`;
        const issue =
          (attempted &&
            (await target.created(
              finding.title,
              body,
              new Date(Date.parse(attempted) - createdWindow).toISOString(),
            ))) ||
          (await target.create(finding.title, body));
        settle(index, {
          state: "filed",
          issue: `${finding.repository}#${issue.number}`,
          url: issue.url,
        });
      } else
        settle(index, {
          state: "linked",
          issue: `${finding.repository}#${finding.issue}`,
          url: await target.comment(
            finding.issue,
            finding.comment,
            attempted !== undefined,
          ),
        });
    } catch (error) {
      if (!(error instanceof PlatformError && refusals.has(error.reason)))
        throw error;
      settle(index, {
        state: "unfiled",
        reason: `${finding.repository} refused the write (${error.reason})`,
      });
    }
  }
}

// The result as its comment shows it: its body, then the findings table.
export function withFindings(
  result: RunResult,
  records: (FindingRecord | undefined)[],
): RunResult {
  return result.findings
    ? {
        ...result,
        body: `${result.body}\n\n${findingsTable(result.findings, records)}`,
      }
    : result;
}

// Text safe in one table cell, cut to 100 characters.
function cell(text: string): string {
  const characters = [...text];
  const cut =
    characters.length > 100
      ? `${characters.slice(0, 99).join("")}…`
      : characters.join("");
  return contain(cut).replace(/[\\|]/g, "\\$&");
}

// The findings table the run-result comment shows after the result's body,
// one row per finding in order, once every finding has a final record.
export function findingsTable(
  findings: Finding[],
  records: (FindingRecord | undefined)[],
): string {
  const rows = findings.map((finding, index) => {
    const record = records[index];
    const title = "title" in finding ? cell(finding.title) : undefined;
    switch (record?.state) {
      case "filed":
        return `| ${record.issue}: ${title} | ↗️ Filed, ${"observed" in finding && finding.observed ? "observed" : "only read"} |`;
      case "linked":
        return `| ${record.issue} | ↗️ Linked by [a recurrence comment](${record.url}) |`;
      case "unfiled":
        return "title" in finding
          ? `| ${title} | ⏭️ Not filed in ${finding.repository}: ${cell(record.reason)} |`
          : `| ${"issue" in finding ? `${finding.repository}#${finding.issue}` : ""} | ⏭️ Not linked: ${cell(record.reason)} |`;
      case "invalid":
        return `| Finding ${index + 1} | ❌ Invalid: ${cell(record.reason)} |`;
      default:
        throw new Error(`finding ${index + 1} has no final record`);
    }
  });
  return ["| Finding | Filing |", "| --- | --- |", ...rows].join("\n");
}
