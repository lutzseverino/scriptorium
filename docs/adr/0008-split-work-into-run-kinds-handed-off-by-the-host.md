# Split work into run kinds handed off by the host

The factory runs three run kinds, triage, implement and review, each turned on
per repository, each started by its own trigger and each running the skill the
factory configuration maps to it; implement alone is the minimum and behaves
as one run did before. Kinds hand off through state labels and the platform's
artifacts (the Agent Brief, a draft pull request, a review), and every run
ends by leaving a run result that the host, not the agent, posts in the
factory's frame and turns into labels and the run comment. The owner chose
this on 2026-11-03 so that the agent that reviews a change never wrote it, so
that the triage run can read untrusted issue text with a read-only credential,
and so that a comment and its label can never disagree. One run per issue,
self-reviewing and merging, was rejected because nothing independent checked
it without a person; letting agents keep posting their own final comments was
rejected because the frame, marker and label then depended on the prompt.

## Consequences

- Scriptorium owns the mechanism: run kinds, triggers and their trust check,
  the sandbox, per-kind credentials, the run result, the run comment and the
  factory's machine labels. Skills and their rules own what each run does, and
  no skill is bundled. Policy text such as the hold checks leaves the run
  prompt; the host passes facts instead.
- Credential scope is fixed per kind and is not configuration: triage is
  read-only and only review may merge. Skills, models and providers are
  configuration.
- The run comment replaces the pause, failure and awaiting-merge comments, so
  [ADR 0005](0005-default-the-factorys-own-comment-wording.md)'s per-comment
  templates become one run template and one action template; a fresh comment
  is posted only when a person must act.
