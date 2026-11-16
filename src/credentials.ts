// Credential health: the expiry of each provider login the factory holds and,
// per run kind, the GitHub App permissions the installation lacks, judged with
// the observations the host writes for the factory. Only facts reach the
// status file and the `status` output: times, outcomes, permission names and
// health, never a token, key or credential.
import { readFile } from "node:fs/promises";
import { runKindNames, type RunKindName } from "./factory-configuration.ts";
import {
  runKindPermissions,
  version2Permissions,
  type GitHubPermissions,
} from "./github-token.ts";
import { object, time, type ObjectValue } from "./status.ts";

export const credentialHealths = ["healthy", "unhealthy", "unknown"] as const;
export type CredentialHealth = (typeof credentialHealths)[number];

// A fact the factory could not establish.
export type Known<T> = T | "unknown";

type Level = NonNullable<GitHubPermissions[keyof GitHubPermissions]>;
type Renewal = { at: string; outcome: "succeeded" | "failed" };

export type ProviderCredentials = {
  health: CredentialHealth;
  // When the login copy the factory holds expires.
  loginExpiry: Known<string>;
  // From the host's observations: the login's expiry minus the host's
  // renewal threshold, and the host's last renewal of it.
  renewalDueAt: Known<string>;
  lastRenewal: Known<Renewal>;
};

export type RunKindCredentials = {
  health: CredentialHealth;
  // Each permission the run kind declares that the App installation does not
  // grant, with the level it needs.
  missingPermissions: Known<Record<string, Level>>;
};

export type Credentials = {
  health: CredentialHealth;
  // When the factory computed this.
  observedAt: string;
  providers: Record<string, ProviderCredentials>;
  runKinds: Record<RunKindName, RunKindCredentials>;
  // Why each unknown fact is unknown, in safe words.
  problems: string[];
};

// The host's credential observations document as read: its parsed content,
// or why there is none.
export type ObservationsReading =
  { document: Record<string, unknown> } | { document: null; problem: string };

// Reads the document at `path`, the host configuration's
// `credentialObservations`. Errors stay out: a parse error can quote content.
export async function readCredentialObservations(
  path: string | undefined,
): Promise<ObservationsReading> {
  if (path === undefined)
    return {
      document: null,
      problem: "credentialObservations is not configured",
    };
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return {
      document: null,
      problem:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "the credential observations are missing"
          : "the credential observations are unreadable",
    };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      document: null,
      problem: "the credential observations are not JSON",
    };
  }
  const document = object(value);
  if (document?.version !== 1)
    return {
      document: null,
      problem: "the credential observations are not version 1",
    };
  return { document };
}

// What each run kind requires: its declared permission set, and for
// implement, version 2's too while a served repository is on version 2.
export function requiredPermissions(
  version2: boolean,
): Record<RunKindName, Record<string, Level>> {
  return Object.fromEntries(
    runKindNames.map((kind) => [
      kind,
      merged(
        runKindPermissions[kind],
        ...(version2 && kind === "implement" ? [version2Permissions] : []),
      ),
    ]),
  ) as Record<RunKindName, Record<string, Level>>;
}

function merged(...sets: GitHubPermissions[]): Record<string, Level> {
  const result: Record<string, Level> = {};
  for (const set of sets)
    for (const [permission, level] of Object.entries(set))
      if (result[permission] !== "write") result[permission] = level;
  return result;
}

// The credentials' health at `now`, from each configured provider's login
// expiry (null when its copy holds none the factory can read) and the host's
// observations. A known bad fact makes it unhealthy; otherwise any unknown
// fact makes it unknown.
export function credentialHealth({
  now,
  loginExpiries,
  observations,
  version2,
}: {
  now: Date;
  loginExpiries: Record<string, Date | null>;
  observations: ObservationsReading;
  version2: boolean;
}): Credentials {
  const problems: string[] = [];
  if (!observations.document) problems.push(observations.problem);
  const document = observations.document;
  const past = (time: string) => Date.parse(time) <= now.getTime();
  // A section is usable only when it matches its shape and is still valid.
  const section = <T>(
    name: string,
    value: unknown,
    read: (entry: ObjectValue) => T | null,
  ): T | null => {
    if (!document) return null;
    if (value === undefined) {
      problems.push(`${name} is not observed`);
      return null;
    }
    const entry = object(value);
    const parsed =
      entry && time(entry.observedAt) && time(entry.validUntil)
        ? read(entry)
        : null;
    if (!entry || !parsed) problems.push(`${name} is malformed`);
    else if (past(entry.validUntil as string))
      problems.push(`${name} is past its validUntil`);
    else return parsed;
    return null;
  };
  const observedProviders = object(document?.providers);
  if (document && document.providers !== undefined && !observedProviders)
    problems.push("providers is malformed");

  const providers = Object.fromEntries(
    Object.entries(loginExpiries).map(
      ([provider, expiry]): [string, ProviderCredentials] => {
        const observed = section(
          `providers.${provider}`,
          observedProviders?.[provider],
          (entry) => {
            const renewal = object(entry.lastRenewal);
            return time(entry.renewalDueAt) &&
              time(renewal?.at) &&
              (renewal.outcome === "succeeded" || renewal.outcome === "failed")
              ? {
                  renewalDueAt: entry.renewalDueAt,
                  lastRenewal: {
                    at: renewal.at,
                    outcome: renewal.outcome,
                  } as Renewal,
                }
              : null;
          },
        );
        if (!expiry)
          problems.push(
            `${provider} holds no login copy with a readable expiry`,
          );
        const loginExpiry = expiry ? expiry.toISOString() : "unknown";
        const bad =
          (expiry !== null && expiry.getTime() <= now.getTime()) ||
          (observed !== null &&
            (past(observed.renewalDueAt) ||
              observed.lastRenewal.outcome === "failed"));
        return [
          provider,
          {
            health: bad
              ? "unhealthy"
              : expiry === null || observed === null
                ? "unknown"
                : "healthy",
            loginExpiry,
            renewalDueAt: observed?.renewalDueAt ?? "unknown",
            lastRenewal: observed?.lastRenewal ?? "unknown",
          },
        ];
      },
    ),
  );

  const granted = section("githubApp", document?.githubApp, (entry) => {
    const permissions = object(entry.grantedPermissions);
    return permissions &&
      Object.values(permissions).every(
        (level) => level === "read" || level === "write",
      )
      ? (permissions as Record<string, Level>)
      : null;
  });
  const required = requiredPermissions(version2);
  const runKinds = Object.fromEntries(
    runKindNames.map((kind): [RunKindName, RunKindCredentials] => {
      if (!granted)
        return [kind, { health: "unknown", missingPermissions: "unknown" }];
      const missing = Object.fromEntries(
        Object.entries(required[kind]).filter(
          ([permission, level]) =>
            granted[permission] !== "write" && granted[permission] !== level,
        ),
      );
      return [
        kind,
        {
          health: Object.keys(missing).length ? "unhealthy" : "healthy",
          missingPermissions: missing,
        },
      ];
    }),
  ) as Record<RunKindName, RunKindCredentials>;

  const parts = [...Object.values(providers), ...Object.values(runKinds)];
  return {
    health: parts.some(({ health }) => health === "unhealthy")
      ? "unhealthy"
      : parts.some(({ health }) => health === "unknown")
        ? "unknown"
        : "healthy",
    observedAt: now.toISOString(),
    providers,
    runKinds,
    problems: [...new Set(problems)],
  };
}
