import { describe, expect, it, vi } from "vitest";

import { CertifiedRuntimeExecutionHandoff } from "./certified-runtime-execution-handoff";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";
import type { CanonicalExecutionRequest } from "./governed-self-development-coordinator";

/*
 * DEFECT 25 LINK 2 — SELF-DEVELOPMENT MUST NOT BYPASS THE CERTIFIED PATH.
 *
 * `CanonicalExecutionHandoff` was an injected function, so self-development executed through
 * whatever a caller supplied. Composing the coordinator would not have fixed that — it would
 * still have skipped governed allocation, routing, the lease and recovery.
 *
 * These pin that the adapter ENTERS the certified path, READS what that path produced, and
 * REFUSES anything it cannot prove went through it.
 */

const TASK_ID = "sd-task-1";
const MISSION_ID = "sd-mission-1";
const WORKFLOW_ID = workflowIdForAttempt(TASK_ID, 1);
const WORKER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const request = (): CanonicalExecutionRequest => ({
  candidate: { id: "imp-1" } as CanonicalExecutionRequest["candidate"],
  missionId: MISSION_ID,
  missionTaskId: "sd-mt-1",
  taskId: TASK_ID,
  missionTask: { id: "sd-mt-1" } as CanonicalExecutionRequest["missionTask"],
});

function harness(
  over: {
    workspace?: Record<string, unknown> | null;
    attempt?: Record<string, unknown> | null;
    result?: Record<string, unknown> | null;
  } = {},
) {
  const run = vi.fn(async () => undefined);
  const workspace =
    over.workspace === undefined
      ? {
          workspaceId: "ws-1",
          workflowId: WORKFLOW_ID,
          releasedAt: null,
          leaseOwner: "coordinator-1",
          fencingToken: 3,
        }
      : over.workspace;

  const handoff = new CertifiedRuntimeExecutionHandoff({
    supervisor: { run },
    workspaces: { list: async () => (workspace ? [workspace] : []) } as never,
    dispatchAttempts: {
      getByWorkflowId: async () =>
        over.attempt === undefined ? { workerId: WORKER_ID } : over.attempt,
    } as never,
    executionResults: {
      getByWorkflowId: async () =>
        over.result === undefined ? { workflowId: WORKFLOW_ID, outcome: "success" } : over.result,
    } as never,
  });

  return { handoff, run };
}

describe("DEFECT 25 LINK 2 — certified runtime execution handoff", () => {
  it("ENTERS THE CERTIFIED PATH: it calls the supervisor, and decides nothing itself", async () => {
    const h = harness();

    const result = await h.handoff.execute(request());

    /*
     * The one entry point an ordinary autonomous mission uses. Allocation, routing, leasing,
     * dispatch and recovery all happen inside it, owned by the components CORE3 certifies.
     */
    expect(h.run).toHaveBeenCalledWith(MISSION_ID);
    expect(result.status).toBe("COMPLETED");
  });

  it("READS the lease the CERTIFIED path took, so integration is fenced by the same evidence", async () => {
    const h = harness();

    const result = await h.handoff.execute(request());

    if (result.status !== "COMPLETED") throw new Error("unreachable");
    expect(result.workspaceId).toBe("ws-1");
    expect(result.workspaceLease).toEqual({ owner: "coordinator-1", fencingToken: 3 });
    /* And the producer identity comes from the ROUTED worker, not from a caller. */
    expect(result.producerWorkerId).toBe(WORKER_ID);
  });

  it("THE BYPASS DETECTOR: no governed workspace means the certified path did not run", async () => {
    /*
     * A governed workspace is allocated during attempt preparation for every writer
     * (decision 0042). Its absence means the work went somewhere else — and a result produced
     * outside governance must never be reviewed, gated or integrated as though it had not.
     */
    const h = harness({ workspace: null });

    const result = await h.handoff.execute(request());

    expect(result.status).toBe("UNKNOWN");
    if (result.status !== "UNKNOWN") throw new Error("unreachable");
    expect(result.reason).toContain("NO_GOVERNED_WORKSPACE");
  });

  it("A WORKSPACE NOBODY HOLDS cannot authorise a later integration", async () => {
    const h = harness({
      workspace: { workspaceId: "ws-1", workflowId: WORKFLOW_ID, releasedAt: null, leaseOwner: null, fencingToken: 0 },
    });

    const result = await h.handoff.execute(request());
    expect(result.status).toBe("UNKNOWN");
    if (result.status !== "UNKNOWN") throw new Error("unreachable");
    expect(result.reason).toContain("NO_WORKSPACE_LEASE");
  });

  it("NO ROUTED WORKER means reviewer independence is unprovable, so it REFUSES", async () => {
    const h = harness({ attempt: { workerId: undefined } });

    const result = await h.handoff.execute(request());
    expect(result.status).toBe("UNKNOWN");
    if (result.status !== "UNKNOWN") throw new Error("unreachable");
    expect(result.reason).toContain("NO_ROUTED_WORKER");
  });

  it("NO RESULT YET IS NOT A FAILURE — it is simply not done", async () => {
    const h = harness({ result: null });

    const result = await h.handoff.execute(request());
    expect(result.status).toBe("UNKNOWN");
    if (result.status !== "UNKNOWN") throw new Error("unreachable");
    /* Still running, or recovery will reclaim it. Distinct from a governance failure. */
    expect(result.reason).toContain("NO_EXECUTION_RESULT");
  });

  it("A REPAIR IS THE SAME CERTIFIED PATH on the NEXT attempt, not another mechanism", async () => {
    const attempt2 = workflowIdForAttempt(TASK_ID, 2);
    const run = vi.fn(async () => undefined);
    const handoff = new CertifiedRuntimeExecutionHandoff({
      supervisor: { run },
      workspaces: {
        list: async () => [
          { workspaceId: "ws-2", workflowId: attempt2, releasedAt: null, leaseOwner: "o", fencingToken: 1 },
        ],
      } as never,
      dispatchAttempts: { getByWorkflowId: async () => ({ workerId: WORKER_ID }) } as never,
      executionResults: {
        getByWorkflowId: async () => ({ workflowId: attempt2, outcome: "success" }),
      } as never,
    });

    const result = await handoff.repair({
      ...request(),
      canonicalWorkflowId: WORKFLOW_ID,
      repairCandidate: {} as never,
      previousReview: {} as never,
    });

    expect(run).toHaveBeenCalledWith(MISSION_ID);
    if (result.status !== "COMPLETED") throw new Error("unreachable");
    /* Attempt 2's workspace — the same logical task continued, not a parallel one. */
    expect(result.workspaceId).toBe("ws-2");
  });
});
