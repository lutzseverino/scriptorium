// Repo Canon's factory review attestation, through the issue-contract module
// Repo Canon installs in this repository (ADR 0047). Canon owns its format;
// the factory builds it only here and restates none of it.
// Repo Canon installs JavaScript without TypeScript declarations.
// prettier-ignore
// @ts-expect-error The installed module owns the attestation format.
import * as installedModule from "../scripts/issue-contract-sources.mjs";

// The facts an attestation names: the repository `OWNER/REPO`, the issue's
// node ID, the run, and the exact revision and body source the validator's
// notice names.
export type ReviewAttestationFacts = {
  repository: string;
  issue: string;
  run: string;
  revision: string;
  source: { type: "issue-body"; editedAt: string | null };
};

// Builds an attestation's marker line from its facts.
export type ReviewAttestation = (facts: ReviewAttestationFacts) => string;

// The installed module's attestation builder, or null when the installed
// module has none. `installed` stands in for the installed module in tests.
export function reviewAttestation(
  installed: Record<string, unknown> = installedModule,
): ReviewAttestation | null {
  const line = installed.reviewAttestationLine;
  return typeof line === "function" ? (line as ReviewAttestation) : null;
}
