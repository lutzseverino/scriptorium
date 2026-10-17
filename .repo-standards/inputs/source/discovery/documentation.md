# Discover documentation scope

`repo-standards adopt` drafts the documentation scope itself: the
`documentation` declaration's discovery script, the drafter this source ships,
runs read-only during inspection and proposes the declaration's scope entry.
`adopt` asks its unresolved questions in the terminal, or as the
`scope:documentation` field of its answers file, whose proposed answer is the
draft. Nobody runs the drafter by hand.

The `documentation` rules this source installs decide the draft's candidates: every file Git keeps under the `docs` documentation
root, the index of the root and of each directory under it, the development
guide, the repository root's glossary and context map, and each context
glossary that context map lists. Paths other declarations own, including
`docs/agents/project.md` under `project-agent-guidance`, and paths
Repository Standards reserves, stay out, and so does every `README.md` outside
the documentation roots, which the documentation check would read as a root's
index; such a README cannot enter this scope, even as a move source. If it is a
Project README, the `project-readmes` declaration's proposal covers it. During
an update from Repository Standards 6.x, the retired `adopt-standards` and
`standards-updates` skills stay out too, because the same run removes them.

Decide only the cases in its unresolved questions, resolving genuine membership
questions with the maintainer, and remove each question from the entry once it
is decided:

- Whether a directory is a documentation root. For each one that is, include
  its files, with a new index for each of its directories without one, as the
  draft does for `docs`. `docs` is always a root, and a documentation root never
  lies inside another.
- Whether a Markdown file outside the documentation roots is documentation that
  the scope must cover, such as a document to move into a category.
- Which category a file or directory directly under a root moves to.
- Whether another `GLOSSARY.md` or `GLOSSARY-MAP.md` is a glossary or context map
  of this repository.
- What becomes of a directory under a root without a file that Git keeps, a
  symbolic link under a root, or an entry that blocks a root or an index, such
  as a file named `docs`.
- Whether to commit the first content of a documentation root or of a directory
  under one that has none, in a separate reviewed change, so that its new index
  has the evidence Repository Standards requires.

Then add each intended new path that the work needs and the draft cannot know: a
move destination, with the index of any new directory; and a file whose link to
documentation needs repair. Keep all declarations' paths disjoint: a Project
README under a documentation root belongs to one declaration only. A move
requires authority for its source, destination, and affected link repairs.

If an update's previous documentation scope includes `docs/agents/project.md`,
use the fresh draft without it. The `project-agent-guidance` declaration now
owns that path; removing it from documentation scope preserves its content.

The draft does not decide membership by itself. The maintainer's request to
adopt or update is consent to the drafted and reviewed scope. Ask them to
confirm only when `adopt` asks its `confirmation` question.
