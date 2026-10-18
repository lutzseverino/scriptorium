// The owner's control of each provider's claims, kept across passes and
// restarts: the owner hold an owner-resume host sets when a provider drains,
// the reserve raise a resume request grants, and the resume requests the
// `resume` command queues in the state directory, which the running factory
// applies on its next pass. No other process edits the factory's live state.
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  claimThresholds,
  reached,
  usageInForce,
  type OwnerControl,
  type OwnerHold,
  type ReserveRaise,
  type Usage,
  type UsageHold,
} from "./factory.ts";
import type { UsagePolicy } from "./host-configuration.ts";

// A queued request to lift a provider's owner hold, and to raise its drain
// threshold once when it names one.
export type ResumeRequest = {
  provider: string;
  drainThreshold?: number;
  requestedAt: string;
};

// Where requests wait in the state directory, one file each, applied in the
// order of their names.
export function requestsDirectory(stateDirectory: string): string {
  return join(stateDirectory, "requests");
}

// Why a resume request can't apply under the host's configuration, or null.
// A raise must lift a configured drain threshold, up to the pause threshold,
// or to 100 without one.
export function resumeProblem(
  providers: readonly string[],
  policy: Pick<UsagePolicy, "drainThreshold" | "pauseThreshold">,
  request: Pick<ResumeRequest, "provider" | "drainThreshold">,
): string | null {
  if (!providers.includes(request.provider))
    return `the host configuration has no provider ${request.provider}; choose ${providers.join(" or ")}`;
  const raise = request.drainThreshold;
  if (raise === undefined) return null;
  const { drainThreshold: drain, pauseThreshold: pause } = policy;
  const ceiling = pause ?? 100;
  if (drain === null)
    return "the host sets no drain threshold, so there is none to raise";
  if (!Number.isFinite(raise) || raise <= drain || raise > ceiling)
    return `the drain threshold can be raised only above its configured ${drain}%, up to ${pause === null ? "100%, as the host sets no pause threshold" : `the ${pause}% pause threshold`}`;
  return null;
}

// Writes the request whole and at once, under a name that sorts after every
// earlier one, and resolves that name.
export function queueResume(
  stateDirectory: string,
  request: ResumeRequest,
): string {
  const directory = requestsDirectory(stateDirectory);
  mkdirSync(directory, { recursive: true });
  const id = `${request.requestedAt.replaceAll(":", "-")}-${randomBytes(4).toString("hex")}.json`;
  const path = join(directory, id);
  writeFileSync(`${path}.partial`, `${JSON.stringify(request, null, 2)}\n`);
  renameSync(`${path}.partial`, path);
  return id;
}

// A provider's control, and whether it is draining: whether claims have been
// held by its usage since the owner hold was last set or lifted, so a lifted
// hold is not set again until the provider drains anew.
type ProviderOwner = OwnerControl & { draining: boolean };

// The record: each provider's control, and the requests already applied
// whose files may remain.
type OwnerRecord = {
  providers: Record<string, ProviderOwner>;
  applied: string[];
};

export type OwnerPorts = {
  providers: readonly string[];
  policy: UsagePolicy;
  now(): Date;
  // Writes a line to the process log.
  report(line: string): void;
  stateDirectory: string;
};

export function createOwner(ports: OwnerPorts) {
  const path = join(ports.stateDirectory, "owner.json");
  const requests = requestsDirectory(ports.stateDirectory);
  // Loaded on the first pass, which follows the host's own startup.
  let state: OwnerRecord | null = null;
  let saved = "";

  function empty(): ProviderOwner {
    return { hold: null, reserve: null, draining: false };
  }

  // An unreadable record must not lift an owner hold, so an owner-resume host
  // holds every provider until the owner resumes it.
  function load(): OwnerRecord {
    if (!existsSync(path)) return { providers: {}, applied: [] };
    let recorded;
    try {
      saved = readFileSync(path, "utf8");
      recorded = JSON.parse(saved);
    } catch (error) {
      const held = ports.policy.afterDrain === "owner-resume";
      ports.report(
        `the owner record is unreadable, so it starts ${held ? "with an owner hold on every provider" : "empty"}: ${error}`,
      );
      const since = ports.now().toISOString();
      return {
        providers: Object.fromEntries(
          ports.providers.map((provider) => [
            provider,
            { ...empty(), hold: held ? { since, used: null } : null },
          ]),
        ),
        applied: [],
      };
    }
    const providers: Record<string, ProviderOwner> = {};
    for (const provider of ports.providers) {
      const entry = recorded?.providers?.[provider];
      if (entry === undefined) continue;
      providers[provider] = {
        hold: validHold(entry?.hold),
        reserve: validReserve(entry?.reserve),
        draining: entry?.draining === true,
      };
    }
    const applied = Array.isArray(recorded?.applied)
      ? recorded.applied.filter((id: unknown) => typeof id === "string")
      : [];
    return { providers, applied };
  }

  // Replaces the file whole and at once, and only when it changed. A request
  // is applied only once this write has kept its effect.
  function save(current: OwnerRecord): boolean {
    const text = `${JSON.stringify(current, null, 2)}\n`;
    if (text === saved) return true;
    try {
      mkdirSync(ports.stateDirectory, { recursive: true });
      writeFileSync(`${path}.partial`, text);
      renameSync(`${path}.partial`, path);
      saved = text;
      return true;
    } catch (error) {
      ports.report(`the owner record was not written: ${error}`);
      return false;
    }
  }

  // A reserve raise ends on a reading below the configured drain threshold,
  // once the reset it waits for passes, or once the configuration no longer
  // allows it.
  function expire(
    provider: string,
    entry: ProviderOwner,
    reading: Usage | null,
  ) {
    const reserve = entry.reserve;
    if (reserve === null) return;
    const now = ports.now();
    const { drainThreshold } = ports.policy;
    // A reserve granted before its provider reported a reset waits for the
    // first one it reports.
    if (reserve.until === null && reading?.reset !== undefined)
      reserve.until = future(reading.reset, now);
    const ended =
      resumeProblem(ports.providers, ports.policy, {
        provider,
        drainThreshold: reserve.drainThreshold,
      }) !== null
        ? "the host configuration no longer allows it"
        : reading !== null && reading.used < drainThreshold!
          ? `usage ${reading.used}% is below the configured ${drainThreshold}% drain threshold`
          : reserve.until !== null && now.getTime() >= Date.parse(reserve.until)
            ? `the reset at ${reserve.until} passed`
            : null;
    if (ended === null) return;
    entry.reserve = null;
    ports.report(
      `${provider}'s reserve raise to ${reserve.drainThreshold}% ended: ${ended}; its configured drain threshold applies again`,
    );
  }

  // On an owner-resume host, a provider whose new claims its usage holds
  // starts draining and gets an owner hold, unless it is already draining.
  // Low and unknown usage end the draining, never the owner hold.
  function drain(
    provider: string,
    entry: ProviderOwner,
    reading: Usage | null,
    hold: UsageHold | null,
  ) {
    const now = ports.now().toISOString();
    const inForce = usageInForce(reading, hold, now);
    const held =
      inForce !== null &&
      reached(inForce.usage.used, claimThresholds(ports.policy, entry)) !==
        null;
    if (!held) entry.draining = false;
    else if (ports.policy.afterDrain === "owner-resume" && !entry.draining) {
      entry.draining = true;
      if (entry.hold !== null) return;
      entry.hold = { since: now, used: inForce.usage.used };
      ports.report(
        `${provider} drained at ${inForce.usage.used}% usage, so it has an owner hold: it claims no new issue until the owner resumes it`,
      );
    }
  }

  // Lifts the provider's owner hold, and grants the reserve raise the request
  // names, from now until the reset its usage in force reported.
  function apply(
    id: string,
    request: ResumeRequest,
    entry: ProviderOwner,
    reading: Usage | null,
    hold: UsageHold | null,
  ) {
    const now = ports.now();
    const lifted = entry.hold;
    entry.hold = null;
    const said = [
      lifted
        ? `lifted ${request.provider}'s owner hold ${lifted.used === null ? "since" : `from ${lifted.used}% at`} ${lifted.since}`
        : `${request.provider} had no owner hold`,
    ];
    if (request.drainThreshold !== undefined) {
      // Usage reaching the raise drains the provider anew.
      entry.draining = false;
      const reset = usageInForce(reading, hold, now.toISOString())?.usage.reset;
      entry.reserve = {
        drainThreshold: request.drainThreshold,
        since: now.toISOString(),
        until: reset === undefined ? null : future(reset, now),
      };
      said.push(
        `raised its drain threshold once to ${request.drainThreshold}% until usage reads below the configured ${ports.policy.drainThreshold}% or ${entry.reserve.until === null ? "its provider reports a reset that passes" : `its reset at ${entry.reserve.until} passes`}`,
      );
    }
    ports.report(`resume request ${id} applied: ${said.join(", and ")}`);
  }

  // The requests waiting in the state directory, oldest first.
  function waiting(): string[] {
    try {
      return readdirSync(requests)
        .filter((file) => file.endsWith(".json"))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        ports.report(`the resume requests are unreadable: ${error}`);
      return [];
    }
  }

  function read(id: string): ResumeRequest | string {
    let request;
    try {
      request = JSON.parse(readFileSync(join(requests, id), "utf8"));
    } catch (error) {
      return `it is unreadable: ${error}`;
    }
    if (
      typeof request?.provider !== "string" ||
      (request.drainThreshold !== undefined &&
        typeof request.drainThreshold !== "number") ||
      typeof request.requestedAt !== "string"
    )
      return "it is not a resume request";
    return resumeProblem(ports.providers, ports.policy, request) ?? request;
  }

  // Each provider's control for this pass's snapshot. Reserve raises expire
  // and owner holds are set on this pass's usage first; then each waiting
  // request applies once, in order, and is removed.
  function pass(
    usage: Record<string, Usage | null>,
    holds: Record<string, UsageHold | null>,
  ): Record<string, OwnerControl | null> {
    state ??= load();
    const current = state;
    for (const provider of ports.providers) {
      const entry = (current.providers[provider] ??= empty());
      expire(provider, entry, usage[provider] ?? null);
      drain(provider, entry, usage[provider] ?? null, holds[provider] ?? null);
    }
    const files = waiting();
    // An applied request whose file is gone is forgotten.
    current.applied = current.applied.filter((id) => files.includes(id));
    for (const id of files) {
      if (current.applied.includes(id)) continue;
      const request = read(id);
      if (typeof request === "string")
        ports.report(`resume request ${id} was discarded: ${request}`);
      else
        apply(
          id,
          request,
          current.providers[request.provider],
          usage[request.provider] ?? null,
          holds[request.provider] ?? null,
        );
      current.applied.push(id);
    }
    // A request's file goes only once the record keeps its effect, so a
    // restart before then applies it again, and one after never does.
    if (save(current))
      for (const id of current.applied)
        try {
          rmSync(join(requests, id), { force: true });
        } catch (error) {
          ports.report(`resume request ${id} was not removed: ${error}`);
        }
    return controls();
  }

  // Each provider's control as the latest pass left it.
  function controls(): Record<string, OwnerControl | null> {
    return Object.fromEntries(
      ports.providers.map((provider) => {
        const entry = state?.providers[provider];
        return [
          provider,
          entry && (entry.hold || entry.reserve)
            ? { hold: entry.hold, reserve: entry.reserve }
            : null,
        ];
      }),
    );
  }

  return { pass, controls };
}

// A reset still ahead of `now`, or null.
function future(reset: string, now: Date): string | null {
  return Date.parse(reset) > now.getTime() ? reset : null;
}

function validTime(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function validHold(value: unknown): OwnerHold | null {
  const hold = value as Partial<OwnerHold> | null;
  const since = validTime(hold?.since);
  return since && (hold?.used === null || typeof hold?.used === "number")
    ? { since, used: hold.used }
    : null;
}

function validReserve(value: unknown): ReserveRaise | null {
  const reserve = value as Partial<ReserveRaise> | null;
  const since = validTime(reserve?.since);
  return since &&
    typeof reserve?.drainThreshold === "number" &&
    Number.isFinite(reserve.drainThreshold)
    ? {
        drainThreshold: reserve.drainThreshold,
        since,
        until: validTime(reserve.until),
      }
    : null;
}
