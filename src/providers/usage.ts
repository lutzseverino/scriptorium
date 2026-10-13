// Usage is the fullest window's percentage used, or null when unreadable.
export function fullest(values: unknown[]): number | null {
  const readings = values.filter(
    (value): value is number => typeof value === "number",
  );
  return readings.length > 0 ? Math.max(...readings) : null;
}
