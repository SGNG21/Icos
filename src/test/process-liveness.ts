/**
 * DID THIS PROCESS OUTLIVE THE REVOCATION? — asked so a ZOMBIE cannot answer yes.
 *
 * The property the cancellation proofs assert is that a descendant the worker spawned does
 * not survive the loss of its authority: it must not still be writing into a worktree
 * somebody else may now own. `process.kill(pid, 0)` was the probe, and it cannot answer
 * that question, because it succeeds for a process that is already dead.
 *
 * A killed grandchild whose parent died first is reparented to pid 1 and stays in the
 * table as a ZOMBIE until pid 1 reaps it. A zombie holds no memory, runs no code and can
 * write nothing — it is dead — but `kill(pid, 0)` returns success for it, because the pid
 * is still addressable. Under an init that reaps promptly the window is too short to see;
 * under a container pid 1 that never reaps orphans (which is the normal case for a
 * minimal entrypoint) it never closes, so the probe reported "still alive" for a process
 * the kill had already killed, and the proof failed where the behaviour was correct.
 *
 * So liveness is read from `/proc/<pid>/stat`, where the state character distinguishes
 * them, and `kill(pid, 0)` is kept only as the fallback where there is no `/proc`. This
 * STRENGTHENS the assertion rather than relaxing it: "not a zombie and not gone" is a
 * narrower claim than "the pid cannot be addressed".
 */
import { readFileSync } from "node:fs";

/** `Z` is a terminated process awaiting reaping; `X`/`x` is one being released. */
const DEAD_STATES: ReadonlySet<string> = new Set(["Z", "X", "x"]);

/**
 * True only if the process still EXISTS AND CAN RUN.
 *
 * False for a pid that is gone, and false for one that is dead but not yet reaped.
 */
export function processIsAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;

  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    /*
     * The second field is the executable name IN PARENTHESES and may itself contain
     * spaces or parentheses, so the state is read after the LAST `)` rather than by
     * splitting the line — which is the documented way to parse this file.
     */
    const afterName = stat.slice(stat.lastIndexOf(")") + 1).trim();
    const state = afterName.charAt(0);
    if (!state) return false;
    return !DEAD_STATES.has(state);
  } catch {
    /*
     * No `/proc` (macOS), or the entry vanished between the kill and the read. Vanished
     * is unambiguously dead; on a platform without `/proc` the signal probe is all there
     * is, and it is still correct whenever pid 1 reaps.
     */
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Waits for a process to stop running, up to `timeoutMs`, and reports whether it did.
 *
 * A kill is asynchronous: the signal is delivered, then the kernel tears the process
 * down. A fixed sleep either flakes or is slower than it needs to be, so the proofs poll
 * and keep their own assertion about what the answer must be.
 */
export async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!processIsAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
