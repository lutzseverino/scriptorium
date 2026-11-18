# Read terminal run results

External readers can obtain Scriptorium's published run results without
interpreting its comment frames, markers or host storage. From an installed
Scriptorium checkout, run:

```sh
node src/main.ts results --author 'factory-account[bot]' < comments.json
```

The command reads a JSON array of tracker comment facts from standard input.
Each entry supplies `body` (a string) and `author` (either `null` or an object
with a string `login`). Additional tracker fields are allowed, so callers can
pass Postern comments directly. Supply the complete current comments for one
issue, including edits to existing comments, on every observation. Fetch and
pagination failures must remain failures in the caller.

`--author` is required and names the factory's trusted publishing account,
chosen by the caller from its existing trust configuration. Author comparison
is case insensitive and recognizes GitHub's equivalent `app/name` and
`name[bot]` forms; a person's `name` stays distinct. Comment contents never
establish their own trusted author. The command uses no credentials, network,
host configuration or writable state.

Successful output is one JSON object:

```json
{
  "version": 1,
  "results": [{ "run": "opaque-run-identity", "outcome": "stop" }]
}
```

`results` is the distinct set of published terminal results, sorted by opaque
`run` identity. Outcomes are `done`, `stop` and `failed`: they describe a run's
accepted result, not completion of its issue or pipeline. Identity is scoped
to the watched issue and publishing account. Compare identities, not comment
IDs, edit times, prose, order or a hash of the output. Presentation edits and
repeat publication of the same result retain its identity; a later run has a
different identity even when its outcome and prose match. Conflicting outcomes
for one identity fail observation rather than inventing another result.

The factory also retains result identities in its mutable run comment. A result
can therefore appear in an existing comment, and subsequent progress edits
retain it. Accepted results in that pass are retained unless withdrawn,
including when a later result replaces the visible result body. Consumers reread current
comment bodies instead of watching only new comment IDs. Standalone results
using Scriptorium's default result marker are also readable and deduplicate
against the run comment. Older reports without retained identities and older
standalone triage results using a custom marker provide no readable guarantee.

If the validator selects another contract source after a triage brief was
published, publication stops. The stop has its own terminal identity; the
withdrawn brief's `done` identity is omitted from subsequent observations,
including when its standalone comment still exists. The run comment retains
both the stop and the withdrawal through later edits and host restarts. This
works with either the default result marker or a custom triage marker. The
stop's report write must succeed before publication completes and the claim
is released. Readers need the complete current comment set to observe that
withdrawal; an earlier observation of the brief alone cannot establish that
its publication will finish.

Exit status `0` means observation succeeded, including an empty result set;
`2` means invalid command arguments; `1` means unreadable or invalid input,
unsupported result data, or conflicting observations. Failures write a
diagnostic to standard error and no successful JSON. An empty set does not
prove completion or the absence of a question. In particular, an interrupted
run or one without an accepted result need not publish a terminal result.
Keep comment channels observable wherever the route has no readable terminal
question/stop guarantee.

The versioned command output is the supported external interface. Scriptorium
owns its implementation and presentation formats; consumers invoke their
installed Scriptorium command rather than copying or vendoring a reader.
Result production, workflow-state meanings, answer and continuation authority
keep their existing owners. Observation grants no authority to write, answer,
resume, label or merge.
