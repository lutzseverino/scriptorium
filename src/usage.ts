// The host's view of provider usage: each provider's last good reading and
// when the provider may be read again and its unavailable episode, kept across
// passes and restarts. Each pass reads every provider whose read is due and
// hands the decision core only readings recent enough to trust.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Usage } from "./factory.ts";
import { UsageReadError } from "./providers/usage.ts";

// How long a good reading stays usable, counted from when it was read; failed
// and skipped reads don't renew it.
export const usageFreshMinutes = 20;

// Refusals without a usable Retry-After still give the endpoint time. A 403
// may be a permission refusal, rather than temporary throttling.
const forbiddenRetryMinutes = 60;
const throttledRetryMinutes = 20;

// Only safe categories identify an unavailable episode; no raw error, response
// or credential is kept in the record or used to decide whether to report.
type UsageFailure = `http:${number}` | "read-error" | "no-window";
type ProviderUsage = {
  reading: Usage | null;
  nextRead: string | null;
  failure: UsageFailure | null;
};

export type UsagePorts = {
  providers: readonly string[];
  read(provider: string): Promise<number | null>;
  now(): Date;
  // Writes a line to the process log.
  report(line: string): void;
  // The file that keeps the readings and read deadlines across restarts.
  path: string;
};

export function createUsage(ports: UsagePorts) {
  // Loaded on the first pass, which follows the host's own startup.
  let state: Record<string, ProviderUsage> | null = null;
  let saved = "";

  function load(): Record<string, ProviderUsage> {
    if (!existsSync(ports.path)) return {};
    let recorded;
    try {
      saved = readFileSync(ports.path, "utf8");
      recorded = JSON.parse(saved);
    } catch (error) {
      ports.report(
        `the usage record is unreadable, so it starts empty: ${error}`,
      );
      return {};
    }
    const loaded: Record<string, ProviderUsage> = {};
    for (const provider of ports.providers) {
      const entry = recorded?.[provider];
      if (entry === undefined) continue;
      loaded[provider] = {
        reading: validReading(entry?.reading),
        nextRead: validTime(entry?.nextRead),
        failure: validFailure(entry?.failure),
      };
    }
    return loaded;
  }

  // Replaces the file whole and at once, and only when it changed.
  function save(current: Record<string, ProviderUsage>) {
    const text = `${JSON.stringify(current, null, 2)}\n`;
    if (text === saved) return;
    try {
      mkdirSync(dirname(ports.path), { recursive: true });
      writeFileSync(`${ports.path}.partial`, text);
      renameSync(`${ports.path}.partial`, ports.path);
      saved = text;
    } catch (error) {
      ports.report(`the usage record was not written: ${error}`);
    }
  }

  function unavailable(
    provider: string,
    current: ProviderUsage,
    failure: UsageFailure,
    reason: string,
  ) {
    if (current.failure === failure) return;
    current.failure = failure;
    const permission =
      provider === "claude-code" && failure === "http:403"
        ? "; the documented long-lived setup token may lack usage-read permission"
        : "";
    ports.report(
      `usage for ${provider} is unreadable: ${reason}; ${current.nextRead ? `it is next read at ${current.nextRead}` : "it is read again next pass"}${permission}; a recent cached reading can still apply, but once it expires fresh launches proceed without the percentage gate`,
    );
  }

  async function attempt(provider: string, current: ProviderUsage) {
    try {
      const used = await ports.read(provider);
      current.nextRead = null;
      if (used === null || !Number.isFinite(used))
        unavailable(
          provider,
          current,
          "no-window",
          "its answer holds no usage window",
        );
      else {
        current.reading = { used, at: ports.now().toISOString() };
        if (current.failure !== null)
          ports.report(
            `usage for ${provider} is readable again: ${used}% used`,
          );
        current.failure = null;
      }
    } catch (error) {
      // The answer's receipt is what a delay in seconds counts from.
      const receivedAt = ports.now();
      const fallbackMinutes =
        error instanceof UsageReadError
          ? error.status === 403
            ? forbiddenRetryMinutes
            : error.status === 429
              ? throttledRetryMinutes
              : null
          : null;
      const next =
        error instanceof UsageReadError
          ? (retryAt(error.retryAfter, receivedAt) ??
            (fallbackMinutes === null
              ? null
              : new Date(receivedAt.getTime() + fallbackMinutes * 60_000)))
          : null;
      current.nextRead = next?.toISOString() ?? null;
      const status = error instanceof UsageReadError ? error.status : undefined;
      const failure = validFailure(`http:${status}`) ?? "read-error";
      unavailable(
        provider,
        current,
        failure,
        failure === "read-error"
          ? "the usage read failed"
          : `the usage endpoint answered HTTP ${status}`,
      );
    }
  }

  // Each provider's usage for this pass's snapshot: its reading while fresh,
  // otherwise null.
  async function read(): Promise<Record<string, Usage | null>> {
    state ??= load();
    const usage: Record<string, Usage | null> = {};
    const current: Record<string, ProviderUsage> = {};
    for (const provider of ports.providers) {
      const entry = (current[provider] = state[provider] ?? {
        reading: null,
        nextRead: null,
        failure: null,
      });
      if (
        entry.nextRead === null ||
        ports.now().getTime() >= Date.parse(entry.nextRead)
      )
        await attempt(provider, entry);
      usage[provider] = fresh(entry.reading, ports.now());
    }
    state = current;
    save(current);
    return usage;
  }

  return { read };
}

// A reading the decision core may use: one read at most `usageFreshMinutes`
// ago.
export function fresh(reading: Usage | null, now: Date): Usage | null {
  return reading !== null &&
    now.getTime() - Date.parse(reading.at) <= usageFreshMinutes * 60_000
    ? reading
    : null;
}

// When a `Retry-After` value lets the provider be read again: a delay in
// seconds from the answer's receipt or an HTTP date, as RFC 9110 defines
// them. A missing, malformed or past value is null, so the caller can choose
// its fallback policy.
export function retryAt(
  value: string | undefined,
  receivedAt: Date,
): Date | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  const at = /^\d+$/.test(trimmed)
    ? receivedAt.getTime() + Number(trimmed) * 1000
    : httpDate(trimmed, receivedAt);
  const date = new Date(at ?? NaN);
  return Number.isFinite(date.getTime()) &&
    date.getTime() > receivedAt.getTime()
    ? date
    : null;
}

const months = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const month = months.join("|");
const day = "Mon|Tue|Wed|Thu|Fri|Sat|Sun";
const dayName = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday";
const time = String.raw`(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})`;
// `Sun, 06 Nov 1994 08:49:37 GMT`, and the obsolete
// `Sunday, 06-Nov-94 08:49:37 GMT` and `Sun Nov  6 08:49:37 1994`.
const httpDates = [
  new RegExp(
    String.raw`^(?:${day}), (?<day>\d{2}) (?<month>${month}) (?<year>\d{4}) ${time} GMT$`,
  ),
  new RegExp(
    String.raw`^(?:${dayName}), (?<day>\d{2})-(?<month>${month})-(?<year>\d{2}) ${time} GMT$`,
  ),
  new RegExp(
    String.raw`^(?:${day}) (?<month>${month}) (?<day>[ \d]\d) ${time} (?<year>\d{4})$`,
  ),
];

// An HTTP date's time, or null when the value is none.
function httpDate(value: string, receivedAt: Date): number | null {
  for (const pattern of httpDates) {
    const groups = pattern.exec(value)?.groups;
    if (!groups) continue;
    let year = Number(groups.year);
    // A two-digit year more than 50 years ahead is in the past century.
    if (groups.year.length === 2) {
      const now = receivedAt.getUTCFullYear();
      year += now - (now % 100);
      if (year > now + 50) year -= 100;
    }
    const parts = [
      year,
      months.indexOf(groups.month),
      Number(groups.day),
      Number(groups.hour),
      Number(groups.minute),
      Number(groups.second),
    ] as const;
    const date = new Date(Date.UTC(...parts));
    // A day or time out of range is no date, rather than a rolled-over one.
    const read = [
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
    ];
    return read.every((part, index) => part === parts[index])
      ? date.getTime()
      : null;
  }
  return null;
}

function validReading(value: unknown): Usage | null {
  const reading = value as Partial<Usage> | null;
  return typeof reading?.used === "number" &&
    Number.isFinite(reading.used) &&
    validTime(reading.at) !== null
    ? { used: reading.used, at: reading.at! }
    : null;
}

function validTime(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function validFailure(value: unknown): UsageFailure | null {
  return value === "read-error" ||
    value === "no-window" ||
    (typeof value === "string" && /^http:[1-5]\d{2}$/.test(value))
    ? (value as UsageFailure)
    : null;
}
