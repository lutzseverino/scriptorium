# Retain sandbox images the factory can prove it owns

After each pass that prepares every served repository's sandbox image pair,
the factory removes its own obsolete pairs beyond a host-configured allowance.
A host that opts into the factory builder also has that builder's cache pruned
past a host-configured age. The owner chose automatic, bounded retention over
an operator command on 2026-10-18 in
[the retention decision](https://github.com/lutzseverino/scriptorium/issues/22),
after a homeserver's root filesystem filled with 36 obsolete images and their
build cache, and CI jobs on that host failed for lack of space. The same day,
in [the builder decision](https://github.com/lutzseverino/scriptorium/issues/33),
the owner made the factory builder an opt-in, so the daemon's own builder
remains the default and retention ships in the compatible 1.1.0 release.

An operator command would leave the disk growing between invocations, so the
factory retains images itself, as part of preparing them. It removes a
resource only when it can prove the resource is its own and that nothing uses
it; when it cannot, the resource stays, even if the allowance is exceeded:

- An image is its own only under the exact current-format tag, or the exact
  legacy name an earlier release gave a repository the host serves. A name
  prefix proves nothing.
- A pass that lacks any repository's current image removes no image, because
  that repository could still need any obsolete pair. A successful build for
  one repository never makes another repository's pair obsolete.
- Every image ID a container references, running or stopped, keeps its pair,
  as does the image of a run whose sandbox may not exist yet. Removal is by
  tag and never forced, so another tag keeps its image and the Docker daemon
  refuses an image a container started meanwhile uses.
- The Docker daemon's own build cache cannot be attributed: its records carry
  no owner, and other builds on the host share it, so the factory never prunes
  it. A host that wants its build cache bounded opts into a dedicated Buildx
  builder whose cache holds only the factory's builds, and the factory prunes
  only that builder. Host-wide image, system and builder prunes were
  rejected.

Making the dedicated builder mandatory was rejected. It cannot read images
from the daemon's store or use the daemon's registry mirrors, so a
`.factory/Dockerfile` based on a local-only image would stop building, and
the sandbox image contract change would need a new factory major. The images
were the bulk of the disk the homeserver lost; cache isolation is a
refinement each host can choose.

## Consequences

- By default the daemon's own builder builds both images of a pair, as
  releases before retention did, and build cache is the operator's to manage.
  Image retention applies either way.
- A host that sets `imageBuilder` to `factory` needs Docker's Buildx plugin.
  The factory builder runs BuildKit in a container from a pinned
  `moby/buildkit` image, pulls base images itself without the daemon's images
  or registry mirrors, and keeps a second copy of the layers it built until
  its cache is pruned. One bake builds both images of a pair and loads them
  into Docker, since the builder cannot read images from the daemon's store.
- Both builders give a pair the same tag, and a host that switches back to
  the daemon's builder stops pruning a factory builder left from earlier.
- A repository that stays without a current image, such as one with no
  `.factory/Dockerfile`, holds every removal back; the process log says so.
- Build cache in the daemon's own builder, including that of releases before
  this decision, stays for the operator to judge.
- `imageBuilder` and `imageRetention` are optional in host configuration, so
  existing configurations need no migration.
