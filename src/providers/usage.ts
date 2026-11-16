// One usage window a provider reports: its percentage used, when it resets,
// as an ISO time, or null when the provider reports no reset, and its length
// in minutes, or null when the provider reports none.
export type ReportedWindow = {
  used: number;
  reset: string | null;
  minutes: number | null;
};

// A provider's usage: its fullest window's percentage and reset, which the
// usage thresholds read, and every window it reports.
export type UsageWindow = {
  used: number;
  reset: string | null;
  windows?: ReportedWindow[];
};

// Usage is the fullest window, with every window that holds a percentage, or
// null when none does. A reset the provider reports as an ISO 8601 time or as
// Unix seconds is kept as an ISO time; any other value is no reset. A length
// that is no positive number of minutes is no length.
export function fullest(
  reported: { used: unknown; reset: unknown; minutes: unknown }[],
): UsageWindow | null {
  const windows: ReportedWindow[] = [];
  for (const { used, reset, minutes } of reported)
    if (typeof used === "number")
      windows.push({
        used,
        reset: resetTime(reset),
        minutes:
          typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
            ? minutes
            : null,
      });
  let fullest: ReportedWindow | null = null;
  for (const window of windows)
    if (fullest === null || window.used > fullest.used) fullest = window;
  return fullest && { used: fullest.used, reset: fullest.reset, windows };
}

function resetTime(value: unknown): string | null {
  const time =
    typeof value === "number"
      ? value * 1000
      : typeof value === "string"
        ? Date.parse(value)
        : NaN;
  const date = new Date(time);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// A usage read the provider answered without a measurement. Its message, its
// HTTP status and its `Retry-After` value as sent, when its transport has
// them, hold neither the credential nor the answer's body.
export class UsageReadError extends Error {
  readonly status?: number;
  readonly retryAfter?: string;

  constructor(
    message: string,
    details: { status?: number; retryAfter?: string } = {},
  ) {
    super(message);
    this.name = "UsageReadError";
    if (details.status !== undefined) this.status = details.status;
    if (details.retryAfter !== undefined) this.retryAfter = details.retryAfter;
  }
}
