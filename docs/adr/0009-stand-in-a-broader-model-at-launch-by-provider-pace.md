# Stand in a broader model at launch by provider pace

A subscription's weekly allowance that is unused at its reset is lost, yet a
ticket labelled with a narrow model kept running on it while another
provider's allowance went unspent. The owner settled the remedy on
2026-11-13: the host configuration declares which models are narrower than
others (such as `gpt-6.1-sol` narrower than `claude-opus-5-5`), and the
factory decides at launch, in code, whether to run the broader model as a
stand-in, from the providers' usage at that moment. A stand-in runs only when
the broader model's provider can launch right now and either has spare usage
or, when the narrower model's provider cannot launch, has a fresh usage reading
below its drain threshold. Spare usage is judged by pace: the longest reported
window with a length and a reset is used less than the share of that window
already elapsed, with every shorter window below the drain threshold. A window
without a length or a reset gives no pace. `scriptorium status` prints the same
choice, so hand launches and the factory never disagree.

## Considered options

- **Model guidance that names usage** (the interim of 2026-11-13): labellers
  would weigh usage when choosing a label, often days before launch, so the
  choice used stale usage and could not be checked by code.
- **A ranking of the host's models**: the owner declined it ("I'd avoid making
  a ranking"). A narrower-than pair says only that one model's suitable work
  is a subset of another's, which keeps every stand-in a model that fits and
  never moves a launch to a narrower model.
- **A fixed usage threshold**: it cannot tell a provider that is ahead of its
  week from one that is behind. On 2026-11-13 Codex was at 66 % a third into
  its week, over pace, while a 70 % threshold would still have called it
  available.
- **Comparing providers' headroom**: it ignores when each window resets.

## Consequences

- The only setting is the narrower-than pair. A host that declares none
  behaves as before; there is no pace margin and no switch.
- A label names a model by fit: where several fit and the host declares one
  narrower, label the narrower model; otherwise the cheaper one. A broader
  label is never moved down to a narrower model, so a fitting model never gives
  way to one that may not fit.
- A stand-in needs a fresh usage reading; unknown usage keeps the labelled
  model. A recorded relaunch keeps its model, and a review never stands in
  onto the provider that implemented its change, so provider diversity holds.
- Pace needs every window a provider reports with its length, not only the
  fullest one; the drain and pause thresholds still apply to the fullest.
