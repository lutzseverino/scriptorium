# Give each run a private Git directory

Each run works in a run clone: a clone of the repository made for that run
alone, without hardlinks to the shared clone's objects, in which its sandbox is
launched directly. The sandbox sees no shared Git state, so Git commands inside
it, temporary worktrees included, touch only the run's own clone. The clone
belongs to the issue's claim and stays across retries, run kinds,
pauses, interruptions, failures and owner stops. It is removed when the claim
completes or the host observes that its issue is closed or no longer open,
after any sandbox still running in it exits. This also covers retained clones
with no live run record, including after host restart. An inconclusive read
keeps the clone. Every Git command the host runs in a run clone treats it as untrusted: hooks are disabled and
command-valued configuration is ignored.

Until now every sandbox mounted the shared clone's whole `.git` read-write. On
2026-11-14 one review run's `git worktree prune` deleted every other run's
worktree registration, breaking a concurrent run and losing an uncommitted fix
([#86](https://github.com/lutzseverino/scriptorium/issues/86)), and the same
mount let a sandbox write the shared clone's hooks, configuration and other
runs' branches, which the host later runs Git in
([#220](https://github.com/lutzseverino/scriptorium/issues/220)). The owner
agreed on 2026-11-15 ("Agreed to all").

## Considered options

- Narrower mounts over the shared clone: rejected, because they break
  in-sandbox `git worktree add`, leave hooks, configuration and branches
  writable unless commands that write configuration break too, and rely on
  nested-mount ordering.
- A fix in Sandcastle, which owns the mount layout: rejected as a dependency,
  because its current release has the same layout and its timing is outside
  this project; the owner's direction of 2026-11-12 is "don't couple projects".
- A hardlinked local clone: rejected, because it shares object files the
  sandbox user can write, so a write in one run could change the shared clone
  and every later run cloned from it.

## Consequences

- Each run costs a clone's time and disk, and the state directory holds one
  run clone per issue's claim while the issue remains open. The per-claim
  lifetime follows the delegated owner answer on 2026-11-18
  ([#230](https://github.com/lutzseverino/scriptorium/issues/230#issuecomment-6976656675));
  deleting failed or stopped work would lose unpublished changes, while
  keeping it after issue closure would leak a full clone per claim.
- A live check on the factory host shows that a sandbox's `git worktree prune`
  leaves a concurrent run's checkout and its own usable.
