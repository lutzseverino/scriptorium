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
  // A remote's `uploadPack` cannot be overridden, so the transports that run
  // it or another command on the host are refused. The host reaches GitHub
  // over HTTPS; its local clone from the shared clone allows `file` itself.
  ["protocol.file.allow", "never"],
  ["protocol.ssh.allow", "never"],
  ["protocol.git.allow", "never"],
  ["protocol.ext.allow", "never"],
];

// The environment for every Git the host starts: it never prompts, and the
// settings above follow any command-line configuration already present.
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
  };
}
