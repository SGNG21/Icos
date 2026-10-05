/**
 * MAY THIS PROGRAM RUN AT ALL? A question about the executable, and only that.
 *
 * It used to be answered, accidentally, by the credential table: the activity refused any
 * command absent from `EXECUTOR_ACCESS`, so a map of "which secrets may this agent read"
 * was doubling as "which binaries may ICOS execute". Two concerns in one table is how
 * both get the wrong answer — widening the executable set to let a governed writer run
 * would have handed it somebody else's credentials, and the two hardcoded names were
 * silently the reason no writer could run at all.
 *
 * So executable authority lives here, separately, and DEFAULT DENY: a command is
 * refused unless the deployment has explicitly allowed it. Appearing in
 * `ICOS_WORKER_EXEC_COMMANDS` is a declaration of HOW to invoke a program, not a
 * decision that it may be invoked.
 *
 * FROZEN AT LOAD. The allowlist is read once, when this module is first imported, and
 * never re-read. Anything that later mutates the environment — a workflow payload
 * handled in-process, a compromised activity, a test helper — cannot widen it, because
 * nothing reads the variable again.
 */

/** Parsed once. A later `process.env` write cannot reach it. */
const ALLOWED: ReadonlySet<string> = Object.freeze(
  new Set(parseAllowlist(process.env.ICOS_WORKER_EXECUTABLE_ALLOWLIST)),
) as ReadonlySet<string>;

function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  } catch {
    /*
     * An unreadable policy is not an empty policy in spirit, but it must be in effect:
     * guessing would let a typo silently authorise everything or nothing, and of the two
     * only "nothing" is safe.
     */
    return [];
  }
}

/**
 * Shell interpreters invoked with an inline program. `bash -c '…'` turns a structured
 * argv into a string the policy cannot inspect: whatever the allowlist said, what
 * actually runs is arbitrary. Allowing the interpreter would allow everything it can
 * spawn, so the combination is refused outright even when the interpreter is allowed —
 * a shell SCRIPT by path is fine, an inline one is not.
 */
const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const INLINE_FLAGS: ReadonlySet<string> = new Set(["-c", "--command"]);

export interface ExecutableDecision {
  readonly allowed: boolean;
  /** Stable code, safe to persist. Never contains an argument value. */
  readonly reason: string;
}

function basename(command: string): string {
  const parts = command.split("/");
  return parts[parts.length - 1] ?? command;
}

/**
 * Deterministic, and matched on BOTH the full path and the bare program name, so a
 * deployment may allow `/usr/local/bin/hermes` or just `hermes` without the policy
 * silently depending on which form the declaration happened to use.
 */
export function decideExecutable(command: string, args: readonly string[]): ExecutableDecision {
  if (!command) return { allowed: false, reason: "EXECUTABLE_UNDECLARED" };

  if (ALLOWED.size === 0) {
    return { allowed: false, reason: "EXECUTABLE_POLICY_EMPTY" };
  }

  const name = basename(command);
  if (!ALLOWED.has(command) && !ALLOWED.has(name)) {
    return { allowed: false, reason: "EXECUTABLE_NOT_ALLOWED" };
  }

  if (SHELLS.has(name) && args.some((arg) => INLINE_FLAGS.has(arg))) {
    return { allowed: false, reason: "EXECUTABLE_INLINE_SHELL_REFUSED" };
  }

  return { allowed: true, reason: "EXECUTABLE_ALLOWED" };
}

/** What the audit records. Never an argument value: arguments carry the prompt. */
export function executableAuditView(
  command: string,
  decision: ExecutableDecision,
): Record<string, string> {
  return { executable: basename(command), executableDecision: decision.reason };
}
