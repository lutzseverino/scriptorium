// Host Git treats every Git directory as untrusted: a sandbox can write its
// run clone's hooks and configuration, which the host later runs Git in.
// Command-line scope overrides the repository's own configuration, and the
// environment carries it to every Git process the host starts and to each
// Git those processes start.
const untrusted: [key: string, value: string][] = [
  // Hooks, in `.git/hooks` or wherever the clone points `core.hooksPath`.
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  // An empty value drops the helpers configured so far; the host adds its
  // own GitHub helper on the command line, after these.
  ["credential.helper", ""],
  ["core.askPass", ""],
  ["core.sshCommand", "ssh"],
  ["core.alternateRefsCommand", ""],
  // A fetch starts automatic maintenance, whose `gc` runs the clone's
  // `gc.recentObjectsHook` commands, a list no value can empty.
  ["maintenance.auto", "false"],
];

// The environment for every Git the host starts: it never prompts, the
// settings above follow any command-line configuration already present, and
// it reaches remotes over HTTPS alone. A remote's `uploadPack`, `vcs` helper
// or `insteadOf` rewrite cannot be overridden, and a planted
// `protocol.<name>.allow` outranks configured protocol policy, so only the
// environment's allow-list keeps a repointed remote from running a command.
export function hostGitEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const present = environment.GIT_CONFIG_COUNT || "0";
  if (!/^\d+$/.test(present))
    throw new Error(`GIT_CONFIG_COUNT is not a count: ${present}`);
  const start = Number(present);
  return {
    ...environment,
    ...Object.fromEntries(
      untrusted.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${start + index}`, key],
        [`GIT_CONFIG_VALUE_${start + index}`, value],
      ]),
    ),
    GIT_CONFIG_COUNT: `${start + untrusted.length}`,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "https",
  };
}

// The environment for a host Git call that reads a local repository the host
// owns, never a run clone: it allows the `file` transport alone.
// Seam (deferred): host Git transport carve-outs; consumers: prepareRunClone, runner checkouts (2); extract at 3.
export function localGitEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return { ...environment, GIT_ALLOW_PROTOCOL: "file" };
}
