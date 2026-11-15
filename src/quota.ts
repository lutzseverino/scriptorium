// Repository quota holds, observed through each repository's own Postern
// credential. Polling and admission share this record across host restarts.
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  PlatformError,
  type ConnectionWithLinkAdditions,
} from "@lutzseverino/postern";
import { retryAt } from "./usage.ts";

type Hold = { since: string; until: string };
type Ports = {
  repositories: string[];
  connect(name: string): ConnectionWithLinkAdditions | null;
  now(): Date;
  path: string;
  report(line: string): void;
};

export class QuotaHeld extends Error {}

export function createQuota(ports: Ports) {
  const holds: Record<string, Hold> = existsSync(ports.path)
    ? JSON.parse(readFileSync(ports.path, "utf8"))
    : {};
  let pending = Promise.resolve();

  function hold(name: string): Hold | null {
    const value = holds[name];
    return value && Date.parse(value.until) > ports.now().getTime()
      ? value
      : null;
  }

  function save() {
    mkdirSync(dirname(ports.path), { recursive: true });
    writeFileSync(
      `${ports.path}.partial`,
      `${JSON.stringify(holds, null, 2)}\n`,
    );
    renameSync(`${ports.path}.partial`, ports.path);
  }

  // Held repositories are not probed again early, even on another run's
  // exit. A deadline belongs to the repository that reported it.
  function probe(limited?: { name: string; until?: string }) {
    const next = pending.then(async () => {
      for (const name of ports.repositories) {
        if (hold(name)) continue;
        delete holds[name];
        const connection = ports.connect(name);
        if (!connection || connection.repository.platform !== "github")
          continue;
        const at = ports.now();
        let exhausted = limited?.name === name;
        let until = exhausted ? instant(limited?.until) : null;
        try {
          const response = await connection.access.request({
            path: "/rate_limit",
          });
          const data = response.data as {
            resources?: Record<string, { remaining?: number; reset?: number }>;
            rate?: { remaining?: number; reset?: number };
          } | null;
          const resources = [
            data?.resources?.core ?? data?.rate,
            data?.resources?.graphql,
          ].filter((resource) => resource?.remaining === 0);
          exhausted ||= resources.length > 0;
          if (exhausted) {
            const headers = Object.fromEntries(
              Object.entries(response.headers).map(([key, value]) => [
                key.toLowerCase(),
                value,
              ]),
            );
            until ??=
              retryAt(headers["retry-after"], at)?.toISOString() ??
              epoch(headers["x-ratelimit-reset"]);
            until ??=
              resources
                .map((resource) => epoch(resource?.reset))
                .filter((reset): reset is string => reset !== null)
                .sort()
                .at(-1) ?? null;
          }
        } catch (error) {
          if (
            error instanceof PlatformError &&
            error.reason === "rateLimited"
          ) {
            exhausted = true;
            until ??= instant(error.retryAt);
          } else ports.report(`${name} quota could not be read: ${error}`);
        }
        if (exhausted) {
          holds[name] = {
            since: at.toISOString(),
            until: until ?? new Date(at.getTime() + 15 * 60_000).toISOString(),
          };
          ports.report(
            `${name} quota held until ${holds[name].until}: GitHub rate limit`,
          );
        }
      }
      save();
    });
    pending = next;
    return next;
  }

  // Observe at the Postern seam, including errors that projection code catches
  // to produce a more specific hold. A held repository makes no further reads.
  function observe(
    name: string,
    connection: ConnectionWithLinkAdditions,
  ): ConnectionWithLinkAdditions {
    if (connection.repository.platform !== "github") return connection;
    const writes = new Set([
      "addLabels",
      "removeLabel",
      "createLabel",
      "updateLabel",
      "createComment",
      "updateComment",
      "closeIssue",
      "comment",
      "squashMerge",
    ]);
    function port<T extends object>(value: T): T {
      return new Proxy(value, {
        get(target, key, receiver) {
          const operation = Reflect.get(target, key, receiver);
          if (typeof operation !== "function") return operation;
          return async (...args: unknown[]) => {
            await pending;
            if (!writes.has(String(key)) && hold(name))
              throw new QuotaHeld(`${name} waits for its GitHub quota reset`);
            try {
              return await operation.apply(target, args);
            } catch (error) {
              if (
                error instanceof PlatformError &&
                error.reason === "rateLimited"
              )
                await probe({ name, until: error.retryAt });
              throw error;
            }
          };
        },
      });
    }
    return {
      ...connection,
      issueTracker: port(connection.issueTracker),
      pullRequests: port(connection.pullRequests),
      releaseSource: port(connection.releaseSource),
      access: port(connection.access),
    };
  }

  return {
    hold,
    observe,
    probe,
    settled: () => pending,
    async refresh() {
      await pending;
      if (Object.keys(holds).some((name) => !hold(name))) await probe();
    },
  };
}

function instant(value: string | undefined): string | null {
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

function epoch(value: number | string | undefined): string | null {
  if (value === undefined || !/^\d+$/.test(String(value))) return null;
  const date = new Date(Number(value) * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Stops still carry genuine permission refusals when quota is exhausted too.
// A quota-only HTTP 403 is not evidence of a permission refusal.
export function permissionRefusal(result: {
  outcome: string;
  body: string;
  reason?: string;
}): boolean {
  return (
    result.outcome === "stop" &&
    /Resource not accessible by (?:integration|personal access token)|refusing to allow .*workflow|permission denied|insufficient (?:permissions?|scopes?)|(?:missing|lacks?|requires?) [^\n.]*permission|not permitted to|not authorized to/i.test(
      `${result.reason ?? ""}\n${result.body}`,
    )
  );
}
