// When a paused run stops waiting for its provider's usage to read: the reset
// its limit error stated, when the factory can date it, and at most a fixed
// hold after the pause.

// The longest a paused run waits while its provider's usage stays unknown.
export const maximumPauseHours = 24;

// The pause's deadline, fixed once from the time the run paused, never from a
// later pass or restart. Only a reset stated as a UTC time of day, such as
// `5:50pm (UTC)` or `17:50 (UTC)`, is dated: its first occurrence at or after
// the pause. Any other wording, or none, waits the whole hold.
export function pauseDeadline(reset: string | null, pausedAt: Date): Date {
  const hold = new Date(pausedAt.getTime() + maximumPauseHours * 3_600_000);
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
