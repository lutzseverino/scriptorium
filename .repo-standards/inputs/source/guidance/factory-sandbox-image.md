# Factory toolchain image adoption guidance

Target only the adopting repository's `.factory/Dockerfile`, with no directory
targets, and bring it into line with the `factory-sandbox-image` rules. The
factory profile installs it for a repository that a factory serves.

When the repository still has a `.sandcastle/Dockerfile` from an earlier Repo
Canon release, write `.factory/Dockerfile` from its toolchain lines, the lines
after Repo Canon's base, following the rules for the base and delivery runtime.
Leave out the old base's agent tooling and user setup.

If the toolchain needs a different Node.js major from the one the installed
`babysit` scripts support, ask the maintainer how to provide both requirements,
and assess the declaration as `blocked` until they answer. When the development
guide names a tool without enough detail to install it, such as a missing
version that matters, ask the maintainer, and assess the declaration as
`blocked` until they answer.

Assess `factory-sandbox-image` as `satisfied` once the file meets its rules,
citing the development guide's lines for each toolchain tool and the installed
`.agents/skills/babysit/SKILL.md` for Node.js. No check reads the file; whether
it installs the right toolchain is an agent judgment. The installed workflow's
build behavior is described in the
[sandbox image workflow development guide](../docs/development/sandbox-image-workflow.md).
