import { describe, expect, it } from "vitest";

import { cancelAssignment } from "./delegation";
import { TERMINAL_ASSIGNMENT_STATUSES, type WorkAssignment } from "./contracts";
import type { Principal } from "./governance";

/**
 * Withdrawing a delegation is the only exit that does not require the work to be done.
 *
 * Without it an assignment left `assigned` only by being executed and reviewed, so a
 * mission that failed early stranded its delegations for ever. Six stranded assignments
 * exhausted `maxParallelAssignments` and Chief stopped delegating entirely — a goal ran
 * undelegated not because delegation was optional but because the brains were, on paper,
 * still busy with finished work.
 */
const NOW = "2026-10-04T18:00:00.000Z";

const chief: Principal = {
  kind: "agent",
  id: "brain-chief",
  tenantId: "default",
  permissions: [],
} as Principal;

function assignment(overrides: Partial<WorkAssignment> = {}): WorkAssignment {
  return {
    tenantId: "default",
    assignmentId: "wfa-1",
    missionId: "m-1",
    taskId: "m-1:research",
    parentAssignmentId: null,
    supervisorAgentId: "brain-chief",
    assigneeAgentId: "brain-research",
    status: "assigned",
    version: 1,
    spec: { scope: {} },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as WorkAssignment;
}

describe("cancelAssignment", () => {
  it("the supervisor may withdraw work that was never executed", () => {
    const step = cancelAssignment(assignment(), chief, "MISSION_FAILED", NOW);

    expect(step.ok).toBe(true);
    if (step.ok) {
      expect(step.value.status).toBe("cancelled");
      expect(step.value.version).toBe(2);
    }
  });

  it("is reachable from every non-terminal status, not just one", () => {
    for (const status of ["assigned", "executing", "in_review", "changes_requested"] as const) {
      const step = cancelAssignment(assignment({ status }), chief, "MISSION_FAILED", NOW);
      expect(step.ok, `cancelling from ${status}`).toBe(true);
    }
  });

  it("refuses anyone who is not the delegant", () => {
    const assignee = { ...chief, id: "brain-research" } as Principal;
    const stranger = { ...chief, id: "brain-growth" } as Principal;

    /* A brain must not cancel its own assignment to escape review. */
    expect(cancelAssignment(assignment(), assignee, "nope", NOW)).toMatchObject({ ok: false });
    expect(cancelAssignment(assignment(), stranger, "nope", NOW)).toMatchObject({ ok: false });
  });

  it("refuses another tenant", () => {
    const other = { ...chief, tenantId: "someone-else" } as Principal;
    expect(cancelAssignment(assignment(), other, "nope", NOW)).toMatchObject({ ok: false });
  });

  it("refuses an unexplained withdrawal", () => {
    expect(cancelAssignment(assignment(), chief, "   ", NOW)).toMatchObject({ ok: false });
  });

  it("terminal stays terminal, so cancelling twice is refused", () => {
    for (const status of TERMINAL_ASSIGNMENT_STATUSES) {
      const step = cancelAssignment(assignment({ status }), chief, "MISSION_FAILED", NOW);
      expect(step.ok, `cancelling from ${status}`).toBe(false);
    }
  });

  it("cancelled counts as terminal, so capacity is actually given back", () => {
    expect(TERMINAL_ASSIGNMENT_STATUSES).toContain("cancelled");
  });
});
