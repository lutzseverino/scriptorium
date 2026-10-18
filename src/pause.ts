// When a paused run or a usage hold stops waiting for its provider's usage to
// read: the reset its limit error or usage reading stated, when the factory
// can date it, and at most a fixed hold after the pause or the hold began.

// The longest a paused run or a usage hold waits while its provider's usage
// stays unknown.
export const maximumPauseHours = 24;

// The deadline, fixed once from the time the run paused or the hold began,
// never from a later pass or restart. A reset a usage reading reported, as an
// ISO 8601 time, is that time, or the start once it has passed. A reset stated
// as a UTC time of day, such as `5:50pm (UTC)` or `17:50 (UTC)`, is its first
// occurrence at or after the start. Any other wording, or none, waits the
// whole hold.
export function pauseDeadline(reset: string | null, pausedAt: Date): Date {
  const hold = new Date(pausedAt.getTime() + maximumPauseHours * 3_600_000);
  const instant = reset === null ? null : isoTime(reset);
  if (instant !== null)
    return new Date(
      Math.min(Math.max(instant, pausedAt.getTime()), hold.getTime()),
    );
  const time = reset === null ? null : utcTimeOfDay(reset);
  if (time === null) return hold;
  const day = Date.UTC(
    pausedAt.getUTCFullYear(),
    pausedAt.getUTCMonth(),
    pausedAt.getUTCDate(),
  );
  let at = day + time;
  if (at < pausedAt.getTime()) at += 24 * 3_600_000;
  return new Date(Math.min(at, hold.getTime()));
}

// An ISO 8601 date and time with its offset, or null for any other wording.
function isoTime(reset: string): number | null {
  const time =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      reset,
    )
      ? Date.parse(reset)
      : NaN;
  return Number.isFinite(time) ? time : null;
}

// Milliseconds after UTC midnight, or null for any other wording.
function utcTimeOfDay(reset: string): number | null {
  const twelveHour =
    /^(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<half>[ap])\.?m\.?\s*\(UTC\)$/i.exec(
      reset.trim(),
    );
  const twentyFourHour = /^(?<hour>\d{1,2}):(?<minute>\d{2})\s*\(UTC\)$/i.exec(
    reset.trim(),
  );
  const groups = (twelveHour ?? twentyFourHour)?.groups;
  if (!groups) return null;
  let hour = Number(groups.hour);
  const minute = Number(groups.minute ?? 0);
  if (minute > 59) return null;
  if (groups.half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (groups.half.toLowerCase() === "p" ? 12 : 0);
  } else if (hour > 23) return null;
  return (hour * 60 + minute) * 60_000;
}
