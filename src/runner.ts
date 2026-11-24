// Runner event delivery. When the host is a repository's named runner, each
// pass polls the repository from its durable cursor, turns what changed into
// deliveries, and runs each delivery through one of the entry points Repo
// Canon installs, loaded from a default-branch commit pinned for it, under the
// runner account's credential. The first pass after the host becomes the
// runner delivers no history: it records the cursor, the current heads and
// the comment copies, then catches up once.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Account, IssueEvent } from "@lutzseverino/postern";
import type { Git } from "./clone.ts";
import {
  factoryConfigurationPath,
  readFactoryConfiguration,
} from "./factory-configuration.ts";

// Repo Canon's installed entry points, by their repository paths. Scriptorium
// invokes them; Repo Canon reads nothing Scriptorium owns.
export const entryPoints = {
  validate: "vendor/repo-canon/validate.mjs",
  sandboxImage: "vendor/repo-canon/sandbox-image.mjs",
} as const;

// Each pass reads back this far before the previous one started, so an event
// the platform records late is still observed. Delivered identities keep an
// event seen twice from being delivered twice.
const overlapMs = 5 * 60_000;

// Where the check command's container mounts the head checkout.
const checkWorkdir = "/home/agent/workspace";

// An entry point runs this much longer than the check command's container,
// so the container's own stop lets it post the command's failure.
const graceMs = 2 * 60_000;

// A preparation that fails this many times, such as a head no longer
// fetchable, drops its delivery rather than holding its lane.
const attemptLimit = 3;

// An account the platform no longer knows, as GitHub names it.
const ghost: Account = { login: "ghost", bot: false };

export type RunnerIssue = {
  number: number;
  createdAt: string;
  author: Account | null;
};

export type RunnerComment = {
  id: number;
  nodeId: string | null;
  body: string;
  author: Account | null;
  // Who last edited it, where the platform says.
  editor: Account | null;
  createdAt: string;
  // When its body was last edited, or when it was created.
  editedAt: string;
};

// One recorded change to an issue other than a comment's creation or edit,
// with its platform identity.
export type RunnerChange = { id: string; at: string; actor: Account | null } & (
  | { kind: "labeled" | "unlabeled"; label: string }
  | { kind: "closed" | "reopened" }
  | { kind: "edited"; bodyChanged: boolean }
  | { kind: "commentDeleted"; author: string | null }
);

export type RunnerPullRequest = {
  number: number;
  head: string;
  base: string;
  baseBranch: string;
  title: string;
  body: string;
  draft: boolean;
  // Whether the head comes from another repository, such as a fork.
  crossRepository: boolean;
};

// The platform reads one pass makes. None returns a pull request or a
// comment on one.
export type RunnerReads = {
  openIssues(): Promise<RunnerIssue[]>;
  // Issues updated at or after `since`, in any state.
  changedIssues(since: string): Promise<RunnerIssue[]>;
  // The issue's label, state, title and body changes and comment deletions
  // recorded at or after `since`.
  changes(issue: number, since: string): Promise<RunnerChange[]>;
  comments(issue: number): Promise<RunnerComment[]>;
  openPullRequests(): Promise<RunnerPullRequest[]>;
  // The account the factory's own requests come from.
  account(): Promise<Account>;
};

export type EntryPointRequest = {
  // The entry point's absolute path inside the pinned checkout.
  script: string;
  args: string[];
  cwd: string;
  // The runner account's token, which the entry point reads as
  // `POSTERN_TOKEN`.
  token: string;
  timeoutMs: number;
};

export type EntryPointResult = { code: number; output: string };

export type RunnerPorts = {
  stateDirectory: string;
  // The repositories this host is the runner of.
  repositories: string[];
  // Git as the repository's own token holder, never the runner account.
  git(repository: string): Git;
  // The URL a head missing from the host's clone is fetched from.
  remoteUrl(repository: string): string;
  // The runner account's token for the repository.
  token(repository: string): Promise<string>;
  run(request: EntryPointRequest): Promise<EntryPointResult>;
  // How long one entry point may run.
  timeoutMs: number;
  now(): Date;
  report(line: string): void;
  // Keeps background delivery work drainable.
  track(work: Promise<void>): void;
};

// What a pass pins for the deliveries that start after it: the clone it
// updated, its default-branch commit and the sandbox image built from it.
export type RunnerPin = {
  clone: string;
  commit: string;
  image: string | null;
  // The account the validator posts as, which the repository names in
  // `contractResult.author`: the runner account itself.
  validator: string;
};

type Copy = {
  id: number;
  nodeId: string | null;
  body: string;
  author: string | null;
};

type Delivery = { id: string; attempts?: number } & (
  | { lane: "contract"; event: IssueEvent; requested?: true }
  | { lane: "metadata"; pullRequest: number }
  | { lane: "head"; pullRequest: number; head: string; base: string }
);
type Lane = Delivery["lane"];
const lanes: Lane[] = ["contract", "metadata", "head"];

type State = {
  version: 1;
  // When the host became the runner; nothing before it is delivered.
  since: string;
  // When the last observation's reads started.
  cursor: string;
  issues: Record<
    string,
    { comments: Copy[]; delivered: Record<string, string> }
  >;
  pullRequests: Record<
    string,
    { head: string; metadata: string; draft: boolean }
  >;
  // Pending deliveries, in order; each lane takes its own.
  queue: Delivery[];
};

export function createRunner(ports: RunnerPorts) {
  const runner = new Set(ports.repositories.map((name) => name.toLowerCase()));
  const states = new Map<string, State | null>();
  const pins = new Map<string, RunnerPin>();
  const accounts = new Map<string, Account>();
  // The delivery each lane is running, by `<repository> <lane>`.
  const active = new Map<string, string>();
  // How many deliveries use each pinned checkout.
  const using = new Map<string, number>();

  const root = (repository: string) =>
    join(
      ports.stateDirectory,
      "repositories",
      ...repository.split("/"),
      "runner",
    );
  const statePath = (repository: string) =>
    join(root(repository), "state.json");

  // A repository that stopped naming this host, even while it was down,
  // loses its cursor, so naming it again catches up once more.
  const repositories = join(ports.stateDirectory, "repositories");
  const directories = (path: string) =>
    existsSync(path)
      ? readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory() ? [entry.name] : [],
        )
      : [];
  for (const owner of directories(repositories))
    for (const name of directories(join(repositories, owner)))
      if (!runner.has(`${owner}/${name}`.toLowerCase()))
        rmSync(root(`${owner}/${name}`), { recursive: true, force: true });
      // Checkouts and inputs a stopped process left behind.
      else
        for (const work of ["heads", "inputs", "trusted"])
          rmSync(join(root(`${owner}/${name}`), work), {
            recursive: true,
            force: true,
          });

  function load(repository: string): State | null {
    if (!states.has(repository)) {
      const path = statePath(repository);
      states.set(
        repository,
        existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null,
      );
    }
    return states.get(repository)!;
  }

  function save(repository: string, state: State) {
    states.set(repository, state);
    const path = statePath(repository);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.partial`, `${JSON.stringify(state)}\n`);
    renameSync(`${path}.partial`, path);
  }

  function enqueue(state: State, delivery: Delivery) {
    state.queue.push(delivery);
  }

  // The synthesized event of Scriptorium's own evaluation request, as the
  // installed workflow builds it for the dispatch it replaces.
  const requested = (
    repository: string,
    issue: number,
    actor: Account,
  ): IssueEvent => ({
    platform: "github",
    repository,
    issue,
    kind: "edited",
    actor,
    label: null,
    openingLabels: null,
    bodyChanged: null,
    comment: null,
  });

  // Records what the pass observed and queues its deliveries.
  async function observe(
    repository: string,
    reads: RunnerReads,
    pin: RunnerPin,
  ): Promise<void> {
    pins.set(repository, pin);
    const started = ports.now().toISOString();
    if (!accounts.has(repository))
      accounts.set(repository, await reads.account());
    const actor = accounts.get(repository)!;
    const state = load(repository);
    if (!state) {
      const issues = await reads.openIssues();
      const copies: State["issues"] = {};
      for (const issue of issues)
        copies[issue.number] = {
          comments: (await reads.comments(issue.number)).map(copy),
          delivered: {},
        };
      const pullRequests = await reads.openPullRequests();
      const fresh: State = {
        version: 1,
        since: started,
        cursor: started,
        issues: copies,
        pullRequests: {},
        queue: [],
      };
      for (const issue of issues)
        enqueue(fresh, {
          id: randomUUID(),
          lane: "contract",
          event: requested(repository, issue.number, actor),
          requested: true,
        });
      observePullRequests(fresh, pullRequests);
      save(repository, fresh);
      ports.report(
        `${repository} runner delivery started: catching up ${issues.length} open issues and ${pullRequests.length} open pull requests`,
      );
      drive(repository);
      return;
    }
    const since = new Date(
      Math.max(Date.parse(state.cursor) - overlapMs, Date.parse(state.since)),
    ).toISOString();
    const observed: {
      number: number;
      record: State["issues"][string];
      events: { at: string; event: IssueEvent }[];
    }[] = [];
    for (const issue of await reads.changedIssues(since)) {
      const known = state.issues[issue.number];
      const changes = await reads.changes(issue.number, since);
      const comments = await reads.comments(issue.number);
      observed.push({
        number: issue.number,
        ...issueEvents(repository, issue, known, changes, comments, {
          since: state.since,
          window: since,
          now: started,
          validator: pin.validator,
        }),
      });
    }
    const pullRequests = await reads.openPullRequests();
    // Only synchronous updates follow, so lanes see one consistent state.
    const prune = Date.parse(since) - overlapMs;
    for (const { number, record, events } of observed) {
      for (const [id, at] of Object.entries(record.delivered))
        if (Date.parse(at) < prune) delete record.delivered[id];
      state.issues[number] = record;
      for (const { event } of events)
        enqueue(state, { id: randomUUID(), lane: "contract", event });
    }
    observePullRequests(state, pullRequests);
    state.cursor = started;
    save(repository, state);
    drive(repository);
  }

  // Each new current head of a pull request in the repository itself runs
  // the check command and the image build; any change the platform's pull
  // request events name runs the metadata entry point once on the current
  // state, which several of them between passes share.
  function observePullRequests(state: State, open: RunnerPullRequest[]) {
    const next: State["pullRequests"] = {};
    for (const pullRequest of open) {
      const copy = state.pullRequests[pullRequest.number];
      const metadata = digest([
        pullRequest.title,
        pullRequest.body,
        pullRequest.baseBranch,
      ]);
      const pushed = !copy || copy.head !== pullRequest.head;
      if (
        pushed ||
        copy.metadata !== metadata ||
        (copy.draft && !pullRequest.draft)
      )
        enqueue(state, {
          id: randomUUID(),
          lane: "metadata",
          pullRequest: pullRequest.number,
        });
      if (pushed && !pullRequest.crossRepository)
        enqueue(state, {
          id: randomUUID(),
          lane: "head",
          pullRequest: pullRequest.number,
          head: pullRequest.head,
          base: pullRequest.base,
        });
      next[pullRequest.number] = {
        head: pullRequest.head,
        metadata,
        draft: pullRequest.draft,
      };
    }
    state.pullRequests = next;
  }

  // Scriptorium's own request to evaluate an issue, sent through the same
  // serialized path as observed events. A request still waiting in its lane
  // already answers a repeated one.
  function request(repository: string, issue: number): void {
    const state = load(repository);
    const actor = accounts.get(repository);
    if (!state || !actor) {
      ports.report(
        `${repository}#${issue} evaluation request waits for runner delivery to start`,
      );
      return;
    }
    const running = active.get(`${repository} contract`);
    if (
      state.queue.some(
        (delivery) =>
          delivery.lane === "contract" &&
          delivery.requested &&
          delivery.event.issue === issue &&
          delivery.id !== running,
      )
    )
      return;
    enqueue(state, {
      id: randomUUID(),
      lane: "contract",
      event: requested(repository, issue, actor),
      requested: true,
    });
    save(repository, state);
    drive(repository);
  }

  // Drops the repository's cursor, copies and pending deliveries when this
  // host is not its runner.
  function disable(repository: string): void {
    if (load(repository) === null && !existsSync(root(repository))) return;
    states.set(repository, null);
    pins.delete(repository);
    rmSync(root(repository), { recursive: true, force: true });
  }

  function drive(repository: string) {
    for (const lane of lanes) {
      const key = `${repository} ${lane}`;
      if (active.has(key)) continue;
      active.set(key, "");
      ports.track(
        work(repository, lane, key).finally(() => active.delete(key)),
      );
    }
  }

  // Runs the lane's deliveries one at a time, in order, so runs for one
  // issue never overlap and none cancels an earlier one.
  async function work(repository: string, lane: Lane, key: string) {
    for (;;) {
      const state = load(repository);
      const delivery = state?.queue.find((delivery) => delivery.lane === lane);
      if (!state || !delivery) return;
      active.set(key, delivery.id);
      try {
        await deliver(repository, delivery);
      } catch (error) {
        const attempts = (delivery.attempts ?? 0) + 1;
        if (attempts < attemptLimit) {
          delivery.attempts = attempts;
          if (load(repository) === state) save(repository, state);
          ports.report(
            `${repository} runner ${describe(delivery)} waits for a later pass: ${error}`,
          );
          return;
        }
        ports.report(
          `${repository} runner ${describe(delivery)} dropped after ${attempts} attempts: ${error}`,
        );
      }
      if (load(repository) !== state) return;
      state.queue = state.queue.filter((queued) => queued.id !== delivery.id);
      save(repository, state);
    }
  }

  async function deliver(repository: string, delivery: Delivery) {
    const pin = pins.get(repository);
    if (!pin) throw new Error("no pass has pinned a default-branch commit");
    const trusted = await pinned(repository, pin);
    const inputs = join(root(repository), "inputs");
    await mkdir(inputs, { recursive: true });
    const input = join(inputs, `${delivery.id}.json`);
    // The entry points reach the platform through Postern, by this URL.
    const url = `https://github.com/${repository}`;
    const script = (path: string) => join(trusted, path);
    try {
      const token = await ports.token(repository);
      const validate = async (value: object) => {
        await writeFile(input, JSON.stringify(value));
        return ports.run({
          script: script(entryPoints.validate),
          args: [input],
          cwd: trusted,
          token,
          timeoutMs: ports.timeoutMs + graceMs,
        });
      };
      if (delivery.lane === "contract")
        outcome(
          repository,
          delivery,
          await validate({
            kind: "issue-contract",
            repository: url,
            event: delivery.event,
          }),
        );
      else if (delivery.lane === "metadata")
        outcome(
          repository,
          delivery,
          await validate({
            kind: "pr-metadata",
            repository: url,
            pullRequest: delivery.pullRequest,
          }),
        );
      else {
        // The check command comes from the same pinned commit as the entry
        // points, never from the head.
        const command = readFactoryConfiguration(
          join(trusted, factoryConfigurationPath),
        ).checkCommand;
        const checkout = await headCheckout(repository, pin, delivery);
        try {
          // The image build runs first, while Git still reads a checkout no
          // head code has written to.
          outcome(
            repository,
            delivery,
            await ports.run({
              script: script(entryPoints.sandboxImage),
              args: [delivery.base, delivery.head, repository],
              cwd: checkout,
              token,
              timeoutMs: ports.timeoutMs + graceMs,
            }),
            "image build",
          );
          if (command === undefined)
            ports.report(
              `${repository} runner has no checkCommand in ${factoryConfigurationPath}; #${delivery.pullRequest} at ${delivery.head} gets no check-command run`,
            );
          else if (pin.image === null)
            ports.report(
              `${repository} runner has no sandbox image from the default branch; #${delivery.pullRequest} at ${delivery.head} gets no check-command run`,
            );
          else
            outcome(
              repository,
              delivery,
              await validate({
                kind: "check-command",
                repository: url,
                head: delivery.head,
                checkout,
                command: checkContainer(
                  pin.image,
                  checkout,
                  command,
                  ports.timeoutMs,
                ),
                role: "runner",
              }),
              "check command",
            );
        } finally {
          await remove(checkout);
        }
      }
    } finally {
      await rm(input, { force: true });
      using.set(trusted, using.get(trusted)! - 1);
    }
  }

  function outcome(
    repository: string,
    delivery: Delivery,
    result: EntryPointResult,
    what?: string,
  ) {
    const name = what ? `${describe(delivery)} ${what}` : describe(delivery);
    ports.report(
      result.code === 0
        ? `${repository} runner ${name} succeeded`
        : `${repository} runner ${name} exited ${result.code}: ${result.output.slice(-2000).trim()}`,
    );
  }

  // The checkout of the pinned commit the delivery's entry points load from,
  // counted as in use until the caller releases it. Older pinned checkouts
  // are removed once no delivery uses them.
  async function pinned(repository: string, pin: RunnerPin): Promise<string> {
    const parent = join(root(repository), "trusted");
    const path = join(parent, pin.commit);
    if (!existsSync(path)) {
      await mkdir(parent, { recursive: true });
      const temporary = await mkdtemp(join(parent, ".partial-"));
      using.set(temporary, 1);
      try {
        const git = ports.git(repository);
        await git(parent, [
          "clone",
          "--quiet",
          "--no-checkout",
          pin.clone,
          temporary,
        ]);
        await git(temporary, ["checkout", "--quiet", "--detach", pin.commit]);
        // Another lane may have pinned the same commit meanwhile.
        if (existsSync(path)) rmSync(temporary, { recursive: true });
        else renameSync(temporary, path);
      } finally {
        using.delete(temporary);
        rmSync(temporary, { recursive: true, force: true });
      }
    }
    using.set(path, (using.get(path) ?? 0) + 1);
    for (const entry of readdirSync(parent)) {
      const other = join(parent, entry);
      if (!using.get(other)) rmSync(other, { recursive: true, force: true });
    }
    return path;
  }

  // A private checkout of the head, with the base for the image build's
  // comparison. Its objects are copied, never linked, so the head's code
  // cannot change the host's clone through them, and its Git directory is
  // the host's own, so nothing of the host's configuration is in it.
  async function headCheckout(
    repository: string,
    pin: RunnerPin,
    delivery: Extract<Delivery, { lane: "head" }>,
  ): Promise<string> {
    const parent = join(root(repository), "heads");
    await mkdir(parent, { recursive: true });
    const path = await mkdtemp(join(parent, `pull-${delivery.pullRequest}-`));
    const git = ports.git(repository);
    try {
      await git(parent, [
        "clone",
        "--quiet",
        "--no-checkout",
        "--no-hardlinks",
        pin.clone,
        path,
      ]);
      const missing = [];
      for (const commit of [delivery.head, delivery.base])
        try {
          await git(path, ["cat-file", "-e", `${commit}^{commit}`]);
        } catch {
          missing.push(commit);
        }
      if (missing.length)
        await git(path, [
          "fetch",
          "--quiet",
          ports.remoteUrl(repository),
          ...missing,
        ]);
      await git(path, ["checkout", "--quiet", "--detach", delivery.head]);
      return path;
    } catch (error) {
      await remove(path);
      throw error;
    }
  }

  async function remove(path: string) {
    try {
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      ports.report(`runner checkout ${path} was not removed: ${error}`);
    }
  }

  return { observe, request, disable };
}

export type Runner = ReturnType<typeof createRunner>;

// The events an issue's observation delivers, and its updated record: each
// recorded change and comment difference since the window, apart from what
// was delivered already or precedes the host becoming the runner. The
// validator's own writes are observed but not delivered, as GitHub starts no
// workflow for the events its workflow token causes.
function issueEvents(
  repository: string,
  issue: RunnerIssue,
  known: State["issues"][string] | undefined,
  changes: RunnerChange[],
  comments: RunnerComment[],
  {
    since,
    window,
    now,
    validator,
  }: { since: string; window: string; now: string; validator: string },
): {
  record: State["issues"][string];
  events: { at: string; event: IssueEvent }[];
} {
  const delivered = { ...known?.delivered };
  const events: { at: string; order: number; event: IssueEvent }[] = [];
  const after = (at: string, start = since) =>
    Date.parse(at) >= Date.parse(start);
  const event = (
    kind: IssueEvent["kind"],
    actor: Account | null,
    fields: Partial<IssueEvent> = {},
  ): IssueEvent => ({
    platform: "github",
    repository,
    issue: issue.number,
    kind,
    actor: actor ?? ghost,
    label: null,
    openingLabels: null,
    bodyChanged: null,
    comment: null,
    ...fields,
  });
  const add = (id: string, at: string, value: IssueEvent, order = 1) => {
    if (delivered[id] !== undefined || !after(at)) return;
    delivered[id] = at;
    if (value.actor.login.toLowerCase() !== validator.toLowerCase())
      events.push({ at, order, event: value });
  };
  const second = (at: string) => Math.floor(Date.parse(at) / 1000);
  if (!known)
    add(
      "opened",
      issue.createdAt,
      event("opened", issue.author, {
        // The labels applied with the issue carry its creation second.
        openingLabels: changes.flatMap((change) =>
          change.kind === "labeled" &&
          second(change.at) === second(issue.createdAt)
            ? [change.label]
            : [],
        ),
      }),
      0,
    );
  // Each deletion this pass observes is of a comment the copies miss now, so
  // one no copy matches was of a comment the host never saw.
  const deletions = changes.filter(
    (change): change is Extract<RunnerChange, { kind: "commentDeleted" }> =>
      change.kind === "commentDeleted" && delivered[change.id] === undefined,
  );
  for (const deletion of deletions) delivered[deletion.id] = deletion.at;
  for (const change of changes)
    if (change.kind === "labeled" || change.kind === "unlabeled")
      add(
        change.id,
        change.at,
        event(change.kind, change.actor, { label: change.label }),
      );
    else if (change.kind === "edited")
      add(
        change.id,
        change.at,
        event("edited", change.actor, { bodyChanged: change.bodyChanged }),
      );
    else if (change.kind === "closed" || change.kind === "reopened")
      add(change.id, change.at, event(change.kind, change.actor));
  const copies = new Map(
    (known?.comments ?? []).map((comment) => [comment.id, comment]),
  );
  const fields = (comment: Copy) => ({
    comment: { id: comment.id, nodeId: comment.nodeId, body: comment.body },
  });
  for (const comment of comments) {
    const stored = copies.get(comment.id);
    if (!stored) {
      // A comment the host never copied is new only when it was created in
      // the window; on an issue it never observed, older ones are history.
      if (after(comment.createdAt, known ? since : window))
        add(
          `created:${comment.id}`,
          comment.createdAt,
          event("commentCreated", comment.author, fields(copy(comment))),
        );
    } else if (stored.body !== comment.body)
      add(
        `edited:${comment.id}:${comment.editedAt}`,
        comment.editedAt,
        event(
          "commentEdited",
          comment.editor ?? comment.author,
          fields(copy(comment)),
        ),
      );
  }
  const current = new Set(comments.map((comment) => comment.id));
  for (const stored of copies.values()) {
    if (current.has(stored.id)) continue;
    // The deletion that names the comment's author records who deleted it.
    const index = deletions.findIndex(
      (deletion) =>
        deletion.author === null ||
        stored.author === null ||
        deletion.author.toLowerCase() === stored.author.toLowerCase(),
    );
    const [deletion] = index < 0 ? [] : deletions.splice(index, 1);
    add(
      `deleted:${stored.id}`,
      deletion?.at ?? now,
      event("commentDeleted", deletion?.actor ?? null, fields(stored)),
      2,
    );
  }
  events.sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.order - b.order,
  );
  return {
    record: { comments: comments.map(copy), delivered },
    events: events.map(({ at, event }) => ({ at, event })),
  };
}

function copy(comment: RunnerComment | Copy): Copy {
  return {
    id: comment.id,
    nodeId: comment.nodeId,
    body: comment.body,
    author:
      typeof comment.author === "string" || comment.author === null
        ? comment.author
        : comment.author.login,
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function describe(delivery: Delivery): string {
  if (delivery.lane === "contract")
    return `${delivery.requested ? "evaluation request" : `${delivery.event.kind} event`} for #${delivery.event.issue}`;
  if (delivery.lane === "metadata")
    return `PR metadata for #${delivery.pullRequest}`;
  return `#${delivery.pullRequest} at ${delivery.head}`;
}

// The command the check-command entry point runs: the repository's check
// command inside its sandbox image, with the head checkout as its only mount
// and no credential, host configuration or token in its environment. It
// stops itself at the delivery's time limit, so its container never
// outlives the entry point.
export function checkContainer(
  image: string,
  checkout: string,
  command: string,
  timeoutMs: number,
): string {
  return [
    "timeout",
    "--kill-after=30",
    `${Math.ceil(timeoutMs / 1000)}`,
    "docker",
    "run",
    "--rm",
    "--pull=never",
    "--volume",
    `${checkout}:${checkWorkdir}`,
    "--workdir",
    checkWorkdir,
    "--entrypoint",
    "/usr/bin/tini",
    image,
    "--",
    "sh",
    "-c",
    command,
  ]
    .map(quote)
    .join(" ");
}

function quote(argument: string): string {
  return /^[\w@%+=:,./-]+$/.test(argument)
    ? argument
    : `'${argument.replaceAll("'", `'"'"'`)}'`;
}

// The host environment an entry point gets: what Node.js and Docker need,
// and the runner account's token, never the host's own tokens, keys or
// configuration.
const passed = [
  "PATH",
  "HOME",
  "TMPDIR",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
];
export function entryPointEnvironment(
  token: string,
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    ...Object.fromEntries(
      passed.flatMap((name) =>
        environment[name] === undefined ? [] : [[name, environment[name]!]],
      ),
    ),
    POSTERN_TOKEN: token,
  };
}

// Runs an entry point with Node.js in its own process group, keeping the end
// of its output, and kills the group at its time limit.
export function runEntryPoint(
  request: EntryPointRequest,
): Promise<EntryPointResult> {
  return new Promise((resolve) => {
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-64 * 1024);
    };
    const child = spawn(process.execPath, [request.script, ...request.args], {
      cwd: request.cwd,
      env: entryPointEnvironment(request.token),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      output += "\nThe entry point reached its time limit and was stopped.";
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // It exited meanwhile.
      }
    }, request.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, output: `${output}\n${error.message}` });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}
