import { describe, expect, it } from "vitest";

import { buildPipeline, integrationBacklog, leaseState, type WorkspaceFact } from "./pipeline";
import { missing, real } from "./truth";

const NOW = new Date("2026-09-29T12:00:00Z");

const ws = (id: string, status: string, over: Partial<WorkspaceFact> = {}): WorkspaceFact => ({
  id,
  slug: id,
  workerId: "w1",
  missionId: "m1",
  taskId: "t1",
  status,
  branch: `ws/${id}`,
  leaseOwner: null,
  leaseExpiresAt: null,
  fencingToken: 1,
  sourceCommit: null,
  updatedAt: NOW.toISOString(),
  releasedAt: null,
  ...over,
});

const qc = (state: string) => ({
  workflowId: `wf-${state}`,
  missionId: "m1",
  missionTaskId: "mt1",
  taskId: "t1",
  executionAttempt: 1,
  reviewAttemptCount: 0,
  state,
  action: null,
  lastError: null,
  updatedAt: NOW.toISOString(),
});

describe("pipeline", () => {
  it("counts the integration backlog from the workspace registry only", () => {
    const backlog = integrationBacklog(
      real([ws("a", "ready_for_integration"), ws("b", "integrating"), ws("c", "working")]),
    );
    expect(backlog).toMatchObject({ kind: "real", value: 2 });
    expect(integrationBacklog(missing("unknown", "down")).kind).toBe("unknown");
  });

  it("unknown sources stay unknown, never green", () => {
    const { stages } = buildPipeline({
      now: NOW,
      attempts: missing("unknown", "x"),
      qualityJobs: missing("unknown", "x"),
      workspaces: missing("not_available", "no manager"),
    });
    for (const s of stages) {
      expect(s.count.kind).not.toBe("real");
      expect(s.tone).toBe("unknown");
    }
  });

  it("settlement and recovery are explicit gaps, not zero", () => {
    const { stages } = buildPipeline({
      now: NOW,
      attempts: real([]),
      qualityJobs: real([]),
      workspaces: real([]),
    });
    expect(stages.find((s) => s.key === "settlement")!.count.kind).toBe("not_connected");
    expect(stages.find((s) => s.key === "recovery")!.count.kind).toBe("not_available");
    expect(stages.find((s) => s.key === "gate")!.tone).toBe("ok");
  });

  it("raises reviewer outage, blocked workspace and expired lease alerts", () => {
    const { stages, alerts } = buildPipeline({
      now: NOW,
      attempts: real([]),
      qualityJobs: real([qc("review_unavailable"), qc("review_pending")]),
      workspaces: real([
        ws("blk", "blocked"),
        ws("old", "working", { leaseOwner: "sup-1", leaseExpiresAt: "2026-09-29T11:00:00Z" }),
        ws("ok", "working", { leaseOwner: "sup-1", leaseExpiresAt: "2026-09-29T13:00:00Z" }),
      ]),
    });
    expect(stages.find((s) => s.key === "reviewer-outage")).toMatchObject({ tone: "critical" });
    expect(alerts.map((a) => a.id).sort()).toEqual([
      "reviewer-unavailable",
      "workspace-blocked-blk",
      "workspace-lease-expired-old",
    ]);
  });

  it("lease state is judged against the clock", () => {
    expect(leaseState(ws("x", "working"), NOW)).toBe("none");
    expect(
      leaseState(
        ws("x", "working", { leaseOwner: "o", leaseExpiresAt: "2026-09-29T12:00:01Z" }),
        NOW,
      ),
    ).toBe("held");
  });
});

describe("pipeline flow vs history", () => {
  it("released workspaces are history: excluded from flow stages, backlog and alerts", () => {
    const released = { releasedAt: "2026-09-29T10:00:00Z" };
    const { stages, alerts } = buildPipeline({
      now: NOW,
      attempts: real([]),
      qualityJobs: real([]),
      workspaces: real([
        ws("old-ok", "accepted", released),
        ws("old-blk", "blocked", released),
        ws("old-int", "integrating", released),
        ws("live", "accepted"),
      ]),
    });
    expect(stages.find((s) => s.key === "accepted")!.count).toMatchObject({ value: 1 });
    expect(stages.find((s) => s.key === "blocked")!.count).toMatchObject({ value: 0 });
    expect(stages.find((s) => s.key === "gate")!.count).toMatchObject({ value: 0 });
    expect(alerts).toHaveLength(0);
  });

  it("only dispatched attempts count as dispatched; escalations are an explicit gap", () => {
    const attempts = real([{ state: "prepared" }, { state: "dispatched" }] as never[]);
    const { stages } = buildPipeline({
      now: NOW,
      attempts,
      qualityJobs: real([]),
      workspaces: real([]),
    });
    expect(stages.find((s) => s.key === "execution")!.count).toMatchObject({ value: 1 });
    expect(stages.find((s) => s.key === "escalated")!.count.kind).toBe("not_available");
  });
});
