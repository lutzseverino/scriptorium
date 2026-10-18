// A provider's usage window: its percentage used, and when it resets, as an
// ISO time, or null when the provider reports no reset.
export type UsageWindow = { used: number; reset: string | null };

// Usage is the fullest window, or null when no window holds a percentage. A
// reset the provider reports as an ISO 8601 time or as Unix seconds is kept as
// an ISO time; any other value is no reset.
export function fullest(
  windows: { used: unknown; reset: unknown }[],
): UsageWindow | null {
  let fullest: UsageWindow | null = null;
  for (const { used, reset } of windows)
    if (typeof used === "number" && (fullest === null || used > fullest.used))
      fullest = { used, reset: resetTime(reset) };
  return fullest;
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
