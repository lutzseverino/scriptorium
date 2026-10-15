// Usage is the fullest window's percentage used, or null when unreadable.
export function fullest(values: unknown[]): number | null {
  const readings = values.filter(
    (value): value is number => typeof value === "number",
  );
  return readings.length > 0 ? Math.max(...readings) : null;
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
