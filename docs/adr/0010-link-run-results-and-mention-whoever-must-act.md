# Link run results and mention whoever must act

The default run comment no longer copies the latest run result. It shows a
lead line (a status marker, the pass's state, and who must act when a person
must), one line of phase states, and one line per finished phase with its
run result's lead line, the first line of the result's text, and a link to the
result comment. When a person must act, the run comment shows the question in
an alert, and the action comment mentions that person: the issue's author for
a reporter state, and otherwise the logins in `comments.mention`, by default
the repository's owner when that owner is a user. The result comment's frame
moves the AI disclosure to a footer with the run facts, so a result's first
visible line is its own lead line.

Every run result is already posted as its own comment on the same issue, so
the copy doubled the run comment (7,600 of
[Repo Canon #881](https://github.com/lutzseverino/repo-canon/issues/881)'s
8,149 characters on 2026-11-13) and hid
[Repo Canon #796](https://github.com/lutzseverino/repo-canon/issues/796)'s
owner decision at the bottom of a collapsed block that changed without
notifying anyone. Mentions reverse the 2026-11-03 decision that the factory
mentions nobody, as recorded in
[the message specification](https://github.com/lutzseverino/scriptorium/issues/196):
the owner said on 2026-11-13
that "if the factory wants to talk to the owner it can tag it or directly
address it", approved the mockups, then answered "Agreed to all" and "Agreed".
Keeping results only inside the run comment was rejected, because the
validator ties readiness to the Agent Brief's own comment and revision.

## Consequences

- The `run` template gains `icon` and, within a phase, `icon` and `summary`;
  `run` and `action` gain `mention`; `status` names the running phase. The
  `result` name stays for custom templates, which keep working; only the
  default stops copying the result.
- Hold and close comments also lead with their outcome, and the hold reader
  accepts its earlier lines.
- The footer disclosure needs a Repo Canon release whose issue-contract
  validator accepts it before adopters run a host carrying it.
