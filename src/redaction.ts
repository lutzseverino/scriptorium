// Redaction: every secret the process learns stays out of what it writes for
// people to read, for as long as the process lives.

export type Redactor = {
  // Adds a secret; a blank one is ignored.
  add(secret: string): void;
  // The text with every secret added so far replaced by `<REDACTED>`.
  redact(text: string): string;
};

export const redacted = "<REDACTED>";

export function createRedactor(): Redactor {
  const secrets = new Set<string>();
  let pattern: RegExp | null = null;
  return {
    add(secret) {
      if (secret.trim() === "" || secrets.has(secret)) return;
      secrets.add(secret);
      pattern = null;
    },
    redact(text) {
      if (secrets.size === 0) return text;
      // The longest secret wins where one contains another.
      pattern ??= new RegExp(
        [...secrets]
          .sort((a, b) => b.length - a.length)
          .map((secret) => secret.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&"))
          .join("|"),
        "g",
      );
      return text.replace(pattern, redacted);
    },
  };
}
