/**
 * TWO TRIVIAL WORKFLOWS, so the DISPATCHER's conflict semantics can be proven against a
 * REAL Temporal server rather than a mock of one.
 *
 * The subject under test here is the adapter, not the governed writer: what a workflow id
 * already refers to, and whether a handle may be trusted. The workflow TYPE is
 * configuration the dispatcher is told (`TEMPORAL_WORKFLOW_TYPE`), so pointing it at a
 * workflow that does nothing but stay open — or nothing but finish — is the honest way to
 * put a real server into each of the states the decision has to tell apart. A mock cannot
 * prove that `FAIL` really raises AlreadyStarted on this server version, or that a memo
 * survives a payload round-trip; only the server can.
 *
 * NOT A SECOND EXECUTOR. Neither workflow runs work, reports a result, or touches ICOS.
 * They cannot settle anything, so no production path can reach a result through them, and
 * the real `runIcosTask` remains the only workflow that executes a mission task.
 */
import { condition } from "@temporalio/workflow";

/** Closes immediately: the CLOSED side of the decision. */
export async function probeCompletes(): Promise<string> {
  return "probe-completed";
}

/**
 * Never closes on its own: the OPEN side.
 *
 * Bounded anyway, so a test that fails to terminate it cannot leave an execution running
 * in the namespace for the whole retention period.
 */
export async function probeStaysOpen(): Promise<string> {
  await condition(() => false, "10 minutes");
  return "probe-timed-out";
}
