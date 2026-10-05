import { describe, expect, it } from "vitest";

import { classifyCandidate, decideAgainstExisting } from "@/core/cognitive/writeback-rules";
import type { MemoryRecord } from "@/core/cognitive/contracts";

import {
  missionOutcomeCandidate,
  recordMissionSettlement,
  type MissionSettlementFact,
} from "./mission-memory";

const fact: MissionSettlementFact = {
  missionId: "m-1",
  goalId: "goal-1",
  title: "Analyse de l'état d'ICOS",
  outcome: "succeeded",
  reviewVerdict: "APPROVE",
  resultRef: "branch icos/worker/m-1",
  clientId: "lds-renov",
  projectId: null,
  settledAt: "2026-10-05T09:00:00.000Z",
};

describe("mission memory (decision 0067 item 8)", () => {
  it("a settlement becomes one SYSTEM_OBSERVED, active, long-term episodic fact in the goal's scope", () => {
    const c = missionOutcomeCandidate(fact);
    expect(c).toMatchObject({
      type: "episodic",
      subjectKey: "mission.m-1.outcome",
      epistemic: "SYSTEM_OBSERVED",
      originTrust: "trusted",
      missionId: "m-1",
      retention: "long_term",
      provenance: { sourceType: "mission", sourceId: "m-1" },
    });
    expect(c.content).toContain("réussie");
    expect(c.content).toContain("revue APPROVE");
    expect(c.content).toContain("branch icos/worker/m-1");
    const cls = classifyCandidate(c);
    expect(cls).toMatchObject({ ok: true, status: "active", statementKind: "fact" });
  });

  it("replaying the same settlement is a duplicate, never a second record", () => {
    const c = missionOutcomeCandidate(fact);
    const existing = {
      id: "mem-1",
      type: c.type,
      subjectKey: c.subjectKey,
      content: c.content,
      status: "active",
      epistemic: c.epistemic,
      confidence: 1,
    } as unknown as MemoryRecord;
    expect(decideAgainstExisting(c, "active", [existing])).toEqual({
      kind: "duplicate",
      existingId: "mem-1",
    });
  });

  it("writes under the tenant and the goal's client, and a store failure is reported, not thrown", async () => {
    const writes: unknown[] = [];
    const ok = await recordMissionSettlement(
      {
        write: async (scope, candidate) => {
          writes.push({ scope, candidate });
          return { kind: "accepted", record: {} as MemoryRecord };
        },
      },
      "tenant-1",
      "owner",
      fact,
    );
    expect(ok.kind).toBe("accepted");
    expect(writes[0]).toMatchObject({
      scope: { tenantId: "tenant-1", userId: "owner", clientId: "lds-renov", projectId: null },
    });
    const failed = await recordMissionSettlement(
      {
        write: async () => {
          throw new Error("db down");
        },
      },
      "tenant-1",
      "owner",
      fact,
    );
    expect(failed).toMatchObject({ kind: "rejected", reason: "write_failed: db down" });
  });
});
