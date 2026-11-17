// The host's silent-wait bound for platform reads, shared with the required-
// check gate (ADR 0016). It is policy, not a repository or host setting.
export const silentWaitMinutes = 60;
export const silentWaitMilliseconds = silentWaitMinutes * 60 * 1000;
