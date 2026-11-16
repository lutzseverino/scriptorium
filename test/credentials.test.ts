import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  credentialHealth,
  readCredentialObservations,
  requiredPermissions,
  type ObservationsReading,
} from "../src/credentials.ts";
import { directory } from "./fakes.ts";

const now = new Date("2026-11-16T12:00:00.000Z");
const later = "2026-11-17T12:00:00.000Z";
const earlier = "2026-11-15T12:00:00.000Z";

// Every fact known and good: both logins valid and renewed, and an App
// installation granting every run kind's permissions.
function observations() {
  const provider = () => ({
    observedAt: earlier,
    validUntil: later,
    renewalDueAt: later,
    lastRenewal: { at: earlier, outcome: "succeeded" },
  });
  return {
    version: 1,
    providers: { "claude-code": provider(), codex: provider() },
    githubApp: {
      observedAt: earlier,
      validUntil: later,
      grantedPermissions: {
        actions: "read",
        checks: "read",
        contents: "write",
        issues: "read",
        metadata: "read",
        pull_requests: "write",
        statuses: "read",
      } as Record<string, string>,
    },
  };
}

function health(
  document: unknown,
  {
    loginExpiries = {
      "claude-code": new Date(later),
      codex: new Date(later),
    } as Record<string, Date | null>,
    version2 = false,
  } = {},
) {
  return credentialHealth({
    now,
    loginExpiries,
    observations:
      document === null
        ? {
            document: null,
            problem: "credentialObservations is not configured",
          }
        : ({ document } as ObservationsReading),
    version2,
  });
}

test("credentials with every fact known and good are healthy, with their detail", () => {
  const credentials = health(observations());
  assert.deepEqual(credentials, {
    health: "healthy",
    observedAt: now.toISOString(),
    providers: {
      "claude-code": {
        health: "healthy",
        loginExpiry: later,
        renewalDueAt: later,
        lastRenewal: { at: earlier, outcome: "succeeded" },
      },
      codex: {
        health: "healthy",
        loginExpiry: later,
        renewalDueAt: later,
        lastRenewal: { at: earlier, outcome: "succeeded" },
      },
    },
    runKinds: {
      triage: { health: "healthy", missingPermissions: {} },
      implement: { health: "healthy", missingPermissions: {} },
      review: { health: "healthy", missingPermissions: {} },
    },
    problems: [],
  });
});

test("each known bad fact makes the credentials unhealthy and names its provider or permission", () => {
  const expired = health(observations(), {
    loginExpiries: { "claude-code": new Date(earlier), codex: new Date(later) },
  });
  assert.equal(expired.health, "unhealthy");
  assert.equal(expired.providers["claude-code"].health, "unhealthy");
  assert.equal(expired.providers["claude-code"].loginExpiry, earlier);
  assert.equal(expired.providers.codex.health, "healthy");

  const due = observations();
  due.providers.codex.renewalDueAt = earlier;
  const overdue = health(due);
  assert.equal(overdue.health, "unhealthy");
  assert.equal(overdue.providers.codex.health, "unhealthy");
  assert.equal(overdue.providers.codex.renewalDueAt, earlier);

  const failing = observations();
  failing.providers["claude-code"].lastRenewal.outcome = "failed";
  const failed = health(failing);
  assert.equal(failed.health, "unhealthy");
  assert.deepEqual(failed.providers["claude-code"].lastRenewal, {
    at: earlier,
    outcome: "failed",
  });

  const lacking = observations();
  delete lacking.githubApp.grantedPermissions.statuses;
  const missing = health(lacking);
  assert.equal(missing.health, "unhealthy");
  assert.deepEqual(missing.runKinds, {
    triage: { health: "healthy", missingPermissions: {} },
    implement: {
      health: "unhealthy",
      missingPermissions: { statuses: "read" },
    },
    review: { health: "unhealthy", missingPermissions: { statuses: "read" } },
  });
});

test("a write grant satisfies a read requirement, and a read grant no write requirement", () => {
  const document = observations();
  document.githubApp.grantedPermissions = {
    actions: "write",
    checks: "write",
    contents: "write",
    issues: "write",
    metadata: "write",
    pull_requests: "read",
    statuses: "write",
  };
  const credentials = health(document);
  assert.deepEqual(credentials.runKinds.triage.missingPermissions, {});
  assert.deepEqual(credentials.runKinds.implement.missingPermissions, {
    pull_requests: "write",
  });
});

test("a served repository on configuration version 2 needs issues write for implement", () => {
  assert.equal(requiredPermissions(false).implement.issues, "read");
  assert.equal(requiredPermissions(true).implement.issues, "write");
  assert.equal(requiredPermissions(true).review.issues, "read");
  const credentials = health(observations(), { version2: true });
  assert.equal(credentials.health, "unhealthy");
  assert.deepEqual(credentials.runKinds.implement, {
    health: "unhealthy",
    missingPermissions: { issues: "write" },
  });
  assert.deepEqual(credentials.runKinds.review.missingPermissions, {});
});

test("each unknown fact is unknown in the detail and makes the credentials unknown, never healthy", () => {
  const unknownSections = (
    credentials: ReturnType<typeof health>,
    problem: RegExp,
  ) => {
    assert.equal(credentials.health, "unknown");
    assert.ok(
      credentials.problems.some((line) => problem.test(line)),
      credentials.problems.join("\n"),
    );
  };

  const absent = health(null);
  unknownSections(absent, /not configured/);
  for (const provider of ["claude-code", "codex"])
    assert.deepEqual(absent.providers[provider], {
      health: "unknown",
      loginExpiry: later,
      renewalDueAt: "unknown",
      lastRenewal: "unknown",
    });
  for (const kind of ["triage", "implement", "review"] as const)
    assert.deepEqual(absent.runKinds[kind], {
      health: "unknown",
      missingPermissions: "unknown",
    });

  const stale = observations();
  stale.githubApp.validUntil = earlier;
  const staleApp = health(stale);
  unknownSections(staleApp, /^githubApp is past its validUntil$/);
  assert.equal(staleApp.runKinds.implement.missingPermissions, "unknown");
  assert.equal(staleApp.providers.codex.health, "healthy");

  const staleProvider = observations();
  staleProvider.providers.codex.validUntil = now.toISOString();
  const staleLogin = health(staleProvider);
  unknownSections(staleLogin, /^providers\.codex is past its validUntil$/);
  assert.equal(staleLogin.providers.codex.renewalDueAt, "unknown");
  assert.equal(staleLogin.providers["claude-code"].health, "healthy");

  for (const malformed of [
    { ...observations().providers.codex, lastRenewal: { at: earlier } },
    { ...observations().providers.codex, renewalDueAt: "soon" },
    { ...observations().providers.codex, observedAt: undefined },
    "renewed",
  ]) {
    const document: Record<string, any> = observations();
    document.providers.codex = malformed;
    unknownSections(health(document), /^providers\.codex is malformed$/);
  }
  for (const grantedPermissions of [{ contents: "admin" }, ["contents"]]) {
    const document: Record<string, any> = observations();
    document.githubApp.grantedPermissions = grantedPermissions;
    unknownSections(health(document), /^githubApp is malformed$/);
  }

  const withoutCodex: Record<string, any> = observations();
  delete withoutCodex.providers.codex;
  // A provider the host does not configure is ignored.
  withoutCodex.providers.other = { renewed: "never" };
  unknownSections(health(withoutCodex), /^providers\.codex is not observed$/);

  const unreadableLogin = health(observations(), {
    loginExpiries: { "claude-code": null, codex: new Date(later) },
  });
  unknownSections(
    unreadableLogin,
    /^claude-code holds no login copy with a readable expiry$/,
  );
  assert.equal(unreadableLogin.providers["claude-code"].loginExpiry, "unknown");
});

test("a known unhealthy fact outranks unknown facts", () => {
  const credentials = health(null, {
    loginExpiries: { "claude-code": new Date(earlier), codex: null },
  });
  assert.equal(credentials.health, "unhealthy");
  assert.equal(credentials.providers["claude-code"].health, "unhealthy");
  assert.equal(credentials.providers.codex.health, "unknown");
});

test("the observations document is unknown when absent, unreadable, not JSON or of another version", async (t: TestContext) => {
  const root = directory(t);
  assert.deepEqual(await readCredentialObservations(undefined), {
    document: null,
    problem: "credentialObservations is not configured",
  });
  const path = join(root, "observations.json");
  assert.deepEqual(await readCredentialObservations(path), {
    document: null,
    problem: "the credential observations are missing",
  });
  mkdirSync(join(root, "directory"));
  assert.deepEqual(await readCredentialObservations(join(root, "directory")), {
    document: null,
    problem: "the credential observations are unreadable",
  });
  writeFileSync(path, '{"version": 1, "secret-ghs_notjson');
  assert.deepEqual(await readCredentialObservations(path), {
    document: null,
    problem: "the credential observations are not JSON",
  });
  writeFileSync(path, JSON.stringify({ ...observations(), version: 2 }));
  assert.deepEqual(await readCredentialObservations(path), {
    document: null,
    problem: "the credential observations are not version 1",
  });
  writeFileSync(path, JSON.stringify(observations()));
  assert.deepEqual(await readCredentialObservations(path), {
    document: observations(),
  });
});
