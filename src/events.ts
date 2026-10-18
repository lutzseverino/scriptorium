// Durable operational transitions. A write-ahead record keeps each event's
// identity, exact append bytes and policy write together across process exits.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
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

export type ProviderStatus = {
  provider: string;
  observedAt: string;
  usage: { state: "known"; reading: Usage } | { state: "unknown" };
  usageHold: UsageHold | null;
  ownerHold: OwnerHold | null;
  reserve: ReserveRaise | null;
  thresholds: UsagePolicy & { effectiveDrainThreshold: number | null };
  running: number;
  paused: number;
  claimsHeld: boolean;
  pauseAtThreshold: boolean;
  drained: boolean;
  reason: "owner-hold" | "pause-threshold" | "drain-threshold" | "available";
  nextAction: "owner-resume" | "wait-for-usage" | "claims-allowed";
};

// Explicitly copy the permitted fields: a provider response or a run record
// (which may hold raw output) never becomes part of this public surface.
export function providerStatus(
  provider: string,
  observedAt: string,
  reading: Usage | null,
  hold: UsageHold | null,
  control: OwnerControl | null,
  policy: UsagePolicy,
  running: number,
  paused: number,
): ProviderStatus {
  const safeTime = (at: string) => new Date(at).toISOString();
  const safeReading = (usage: Usage): Usage => ({
    used: usage.used,
    at: safeTime(usage.at),
    ...(usage.reset && Number.isFinite(Date.parse(usage.reset))
      ? { reset: safeTime(usage.reset) }
      : {}),
  });
  const usageHold = hold && {
    ...safeReading(hold),
    since: safeTime(hold.since),
    until: safeTime(hold.until),
  };
  const ownerHold = control?.hold
    ? { since: safeTime(control.hold.since), used: control.hold.used }
    : null;
  const reserve = control?.reserve
    ? {
        drainThreshold: control.reserve.drainThreshold,
        since: safeTime(control.reserve.since),
        until: control.reserve.until && safeTime(control.reserve.until),
      }
    : null;
  const inForce = usageInForce(reading, hold, observedAt);
  const thresholds = claimThresholds(policy, control);
  const threshold = inForce && reached(inForce.usage.used, thresholds);
  const pauseAtThreshold =
    inForce !== null &&
    policy.pauseThreshold !== null &&
    inForce.usage.used >= policy.pauseThreshold;
  const claimsHeld = ownerHold !== null || threshold !== null;
  const reason = ownerHold
    ? "owner-hold"
    : threshold === "pause"
      ? "pause-threshold"
      : threshold === "drain"
        ? "drain-threshold"
        : "available";
  return {
    provider,
    observedAt,
    usage: reading
      ? { state: "known", reading: safeReading(reading) }
      : { state: "unknown" },
    usageHold,
    ownerHold,
    reserve,
    thresholds: {
      drainThreshold: policy.drainThreshold,
      pauseThreshold: policy.pauseThreshold,
      afterDrain: policy.afterDrain,
      effectiveDrainThreshold: thresholds.drainThreshold,
    },
    running,
    paused,
    claimsHeld,
    pauseAtThreshold,
    drained: claimsHeld && running === 0,
    reason,
    nextAction: ownerHold
      ? "owner-resume"
      : claimsHeld
        ? "wait-for-usage"
        : "claims-allowed",
  };
}

export type EventType =
  | "drain_started"
  | "drained"
  | "held"
  | "released"
  | "reserve_granted"
  | "resumed"
  | "paused_at_threshold";
export type FactoryEvent = {
  version: 1;
  id: string;
  sequence: number;
  type: EventType;
  provider: string;
  observedAt: string;
  reason: string;
  state: ProviderStatus;
};

type PolicyWrite = { file: "usage.json" | "owner.json"; text: string };
type Pending = { offset: number; text: string; write?: PolicyWrite };
type Record = {
  version: 1;
  stream: string;
  sequence: number;
  offset: number;
  providers: ProviderStatus[];
  pending?: Pending;
};

// Sync the replacement and its directory before publishing any dependent
// change. Used for both the write-ahead record and the policy it protects.
function replace(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  const file = openSync(partial, "w", 0o600);
  try {
    writeFileSync(file, text);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(partial, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function createEvents(stateDirectory: string) {
  const path = join(stateDirectory, "events-state.json");
  const log = join(stateDirectory, "events.jsonl");
  const save = (record: Record) => replace(path, `${JSON.stringify(record)}\n`);

  function recover(): Record {
    let record: Record;
    if (existsSync(path)) record = JSON.parse(readFileSync(path, "utf8"));
    else {
      // Losing a checkpoint cannot silently start a new stream over a log.
      if (existsSync(log) && readFileSync(log).length)
        throw new Error(
          "the event checkpoint is missing beside an existing event log",
        );
      record = {
        version: 1,
        stream: randomUUID(),
        sequence: 0,
        offset: 0,
        providers: [],
      };
    }
    const pending = record.pending;
    if (pending) {
      mkdirSync(stateDirectory, { recursive: true });
      const file = openSync(log, "a+", 0o600);
      try {
        const bytes = Buffer.from(pending.text);
        const written = fstatSync(file).size - pending.offset;
        if (written < 0 || written > bytes.length)
          throw new Error(
            "the event log length disagrees with its pending append",
          );
        const prefix = Buffer.alloc(written);
        if (
          readSync(file, prefix, 0, written, pending.offset) !== written ||
          !prefix.equals(bytes.subarray(0, written))
        )
          throw new Error("the event log disagrees with its pending append");
        // A short append, even inside a JSON line or UTF-8 character, resumes
        // at the exact byte. Committed bytes are never rewritten or truncated.
        for (let at = written; at < bytes.length;) {
          const count = writeSync(file, bytes, at, bytes.length - at);
          if (count === 0) throw new Error("the event append made no progress");
          at += count;
        }
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      if (pending.write)
        replace(join(stateDirectory, pending.write.file), pending.write.text);
      delete record.pending;
      save(record);
    }
    return record;
  }

  // The optional policy write is committed after its events are durable.
  // An owner request supplies its provider even when lifting no hold, so
  // every accepted request (including repeated reserve grants) is visible.
  function commit(
    providers: ProviderStatus[],
    write?: PolicyWrite,
    resume?: { provider: string; reserveGranted: boolean },
  ) {
    const record = recover();
    if (
      write &&
      existsSync(join(stateDirectory, write.file)) &&
      readFileSync(join(stateDirectory, write.file), "utf8") === write.text
    )
      return;
    const events: FactoryEvent[] = [];
    for (const state of providers) {
      const previous = record.providers.find(
        (entry) => entry.provider === state.provider,
      );
      const add = (type: EventType, reason: string) => {
        const sequence = ++record.sequence;
        events.push({
          version: 1,
          id: `${record.stream}:${sequence}`,
          sequence,
          type,
          provider: state.provider,
          observedAt: state.observedAt,
          reason,
          state,
        });
      };
      for (const [field, reason] of [
        ["usageHold", "usage-hold"],
        ["ownerHold", "owner-hold"],
      ] as const) {
        if (!previous?.[field] && state[field]) add("held", reason);
        if (previous?.[field] && !state[field]) add("released", reason);
      }
      if (!previous?.claimsHeld && state.claimsHeld)
        add("drain_started", state.reason);
      if (!previous?.pauseAtThreshold && state.pauseAtThreshold)
        add("paused_at_threshold", "pause-threshold");
      if (!previous?.drained && state.drained)
        add("drained", "no-running-work");
      if (resume?.provider === state.provider && resume.reserveGranted)
        add("reserve_granted", "owner-request");
      if (
        resume?.provider === state.provider ||
        (previous?.claimsHeld && !state.claimsHeld)
      )
        add(
          "resumed",
          resume?.provider === state.provider
            ? "owner-request"
            : "claims-reopened",
        );
    }
    const text = events.map((event) => `${JSON.stringify(event)}\n`).join("");
    record.providers = providers;
    record.pending = { offset: record.offset, text, ...(write && { write }) };
    record.offset += Buffer.byteLength(text);
    save(record);
    recover();
  }

  return {
    recover: () => {
      recover();
    },
    commit,
  };
}
