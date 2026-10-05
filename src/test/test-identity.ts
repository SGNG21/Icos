/**
 * IDENTITY FOR TESTS THAT REACH A GLOBAL NAMESPACE.
 *
 * A fixed `const TASK_A = "d36taska"` was harmless while mission work ran on the
 * in-process executor: every test built its own executor, so two tests using the same id
 * could not see each other. Temporal is not like that. A workflow id is GLOBAL to the
 * namespace and PERSISTENT past the execution that used it — a closed workflow keeps its
 * id for the whole retention period — so `icos-task-d36taska` is one single name shared
 * by:
 *
 *   - every test case in the file, because they all derive it from the same constant;
 *   - every RERUN of the suite, because the server remembers the previous run;
 *   - every process running the suite at once, because the namespace is shared.
 *
 * The second case is the one that bites hardest: the first test of a fresh run passes,
 * and from then on every test collides with the closed workflow its predecessor left
 * behind. The dispatcher now refuses such a collision instead of reporting a false
 * success (see `temporal-existing-execution.ts`), which turns a silent hang into a loud
 * failure — but a loud failure in all but the first test is still a broken suite.
 *
 * The fix belongs in the TESTS, not in production identity semantics: `icos-task-<taskId>`
 * is the right production key, and weakening it to make reruns pass would throw away the
 * idempotency the whole durable path rests on. So tests namespace the inputs instead.
 *
 * WHAT MAKES AN IDENTITY UNIQUE HERE:
 *
 *   testRunId   one per process, so two runs and two concurrent processes never meet;
 *   testCaseId  one per case, so cases inside a file never meet;
 *   taskId      the business name the test actually cares about ("a", "b", "mt-a");
 *   attempt     supplied by the PRODUCTION helper, never spelled out here.
 *
 * WHAT IS NOT RANDOM: the names a test asks for. `ids.task("a")` returns the same string
 * every time it is called within a case, so business assertions stay exactly as
 * deterministic as they were — the uniqueness is in the namespace, never in the assertion.
 *
 * AND NOTHING HERE CLEANS TEMPORAL. Correctness must not depend on a cleanup step that a
 * crashed run never reaches; a fresh namespace per run is what makes leftover state
 * irrelevant rather than merely unlikely.
 */
import { randomBytes } from "node:crypto";

import { workflowIdForAttempt } from "@/server/execution/workflow-id";

/**
 * ONE PER PROCESS, computed once.
 *
 * `pid` alone is not enough: process ids are recycled, and two runs minutes apart can
 * share one. The random suffix is what makes a collision across processes and across
 * reruns not merely improbable but irrelevant.
 *
 * Lowercase base36 so the result satisfies `idSchema` (`[a-z0-9][a-z0-9_-]+`) and is safe
 * as a path segment — test workers write `src/<taskId>/…` inside their worktree.
 */
const TEST_RUN_ID = `${process.pid.toString(36)}${randomBytes(4).toString("hex")}`;

/** What the current process will namespace every identity with. Exposed for diagnostics. */
export function testRunId(): string {
  return TEST_RUN_ID;
}

export interface TestIdentity {
  /** This process's namespace. Same for every case in the run. */
  readonly runId: string;
  /** This case's namespace within the run. */
  readonly caseId: string;

  /**
   * A task id nothing else in the namespace can hold. Deterministic for a given `name`
   * within this identity, so a test may ask for it as often as it likes.
   */
  task(name: string): string;

  /** A mission task id (the DB row), distinct from the task id it belongs to. */
  missionTask(name: string): string;

  /** This case's mission id. */
  mission(name?: string): string;

  /**
   * The workflow id for a task and attempt — delegated to the PRODUCTION helper, so a
   * test can never accidentally assert a workflow-id shape that production does not use.
   */
  workflow(taskId: string, attempt: number): string;

  /** A label safe to use for a task queue, branch slug or similar. */
  label(name: string): string;
}

/**
 * The identity for ONE test case.
 *
 * `fileLabel` keeps failures readable (it is what shows up in a workflow id when a test
 * does fail); `caseLabel` separates cases within the file. Both are shortened, because a
 * Temporal workflow id is capped at 255 characters and `icos-task-` plus an attempt
 * suffix is already part of the budget.
 */
export function testIdentity(fileLabel: string, caseLabel: string): TestIdentity {
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24);

  const file = slug(fileLabel);
  const caseId = slug(caseLabel) || "case";
  /*
   * `-` only, never `_`: the prefix ends up inside `icos-task-<id>` and in filesystem
   * paths, and one separator everywhere keeps both readable.
   */
  const prefix = `${file}-${TEST_RUN_ID}-${caseId}`;

  return {
    runId: TEST_RUN_ID,
    caseId,
    task: (name) => `${prefix}-${slug(name)}`,
    missionTask: (name) => `${prefix}-mt-${slug(name)}`,
    mission: (name) => `${prefix}-${name ? slug(name) : "mission"}`,
    workflow: (taskId, attempt) => workflowIdForAttempt(taskId, attempt),
    label: (name) => `${prefix}-${slug(name)}`,
  };
}

/**
 * A per-file factory, so a suite writes `const ids = identities("d36")` once and then
 * `ids.forCase("two-task-dag")` in each case — or in a `beforeEach`, which is what makes
 * a RETRIED case get a fresh namespace instead of colliding with its own first run.
 */
export function identities(fileLabel: string): {
  forCase(caseLabel: string): TestIdentity;
} {
  return { forCase: (caseLabel: string) => testIdentity(fileLabel, caseLabel) };
}

/**
 * A counter-backed namespace for a suite that cannot easily name its cases.
 *
 * Deliberately second-best: a named case is self-documenting in a failure message and a
 * numbered one is not. It exists so converting a long file never has to invent a label
 * for a case whose `it(...)` title is a paragraph.
 */
export function sequentialIdentities(fileLabel: string): { next(): TestIdentity } {
  let n = 0;
  return {
    next: () => {
      n += 1;
      return testIdentity(fileLabel, `c${n}`);
    },
  };
}
