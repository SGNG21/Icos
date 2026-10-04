/**
 * WHICH ORCHESTRATOR RUNS THIS, decided before dispatch and never inferred.
 *
 * The orchestrator used to be chosen by asking "does this worker's runtime have an
 * executor adapter configured?". That made executor CONFIGURATION choose orchestration:
 * declaring `ICOS_WORKER_EXEC_COMMANDS` so that `tools.governed` could stop lying moved
 * every mission task off Temporal and into the in-process executor, silently, with no
 * code change and no decision recorded anywhere. A durable multi-step mission started
 * running on a path that cannot survive a process restart.
 *
 * Orchestrator and executor are different questions:
 *
 *   orchestrator = temporal    executor = hermes     (a durable mission task)
 *   orchestrator = in_process  executor = hermes     (a bounded interactive call)
 *
 * The executor is configuration. The orchestrator is a property of the WORK, so it is
 * declared on the dispatch and the router only reads it.
 */
export const EXECUTION_CLASSES = [
  /**
   * Bounded, short-lived work belonging to the conversation: a read-only tool call, a
   * search, a small inspection. Low latency matters and durability does not, because
   * there is no mission lifecycle to survive.
   */
  "INTERACTIVE_COMMAND",
  /**
   * Mission work: a task in a DAG, with retries, review, correction and settlement. It
   * must survive this process dying, so it is orchestrated durably.
   */
  "DURABLE_MISSION_TASK",
] as const;

export type ExecutionClass = (typeof EXECUTION_CLASSES)[number];

/** Who ran it. Recorded, never inferred after the fact. */
export const ORCHESTRATORS = ["in_process", "temporal"] as const;
export type Orchestrator = (typeof ORCHESTRATORS)[number];

/**
 * The ONE mapping, and it is total.
 *
 * No fallback in either direction: a durable mission task may not quietly run in process
 * because an adapter happened to exist, and an interactive command may not open a
 * workflow because one happened to be reachable. Promotion from interactive to mission is
 * a deliberate act that creates a Goal — not something the dispatch seam does on its own.
 */
export function orchestratorFor(executionClass: ExecutionClass): Orchestrator {
  return executionClass === "DURABLE_MISSION_TASK" ? "temporal" : "in_process";
}

/**
 * Fails closed. An unclassified dispatch is a bug in the caller, and guessing would
 * reintroduce exactly the silent switch this exists to prevent — the dangerous direction
 * being a durable mission landing on the non-durable path.
 */
export function requireExecutionClass(value: unknown): ExecutionClass {
  if (typeof value === "string" && (EXECUTION_CLASSES as readonly string[]).includes(value)) {
    return value as ExecutionClass;
  }
  throw new Error(
    `EXECUTION_CLASS_REQUIRED: dispatch must declare one of ${EXECUTION_CLASSES.join(", ")}`,
  );
}
