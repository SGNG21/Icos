import { describe, expect, it } from "vitest";

import type { AuditEntry } from "@/core/contracts/audit";

import { interventionDetails, interventionLedger, isIntervention } from "./intervention";

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  id: over.id ?? "a1",
  eventType: over.eventType ?? "action.decided",
  actor: over.actor ?? { kind: "human", id: "u1" },
  details: over.details ?? {},
  occurredAt: "2026-10-11T18:00:00.000Z",
  createdAt: "2026-10-11T18:00:00.000Z",
});

describe("intervention ledger (BR-07) — debt is what is tagged, never the proxy", () => {
  it("tags carry the flag and a reason code", () => {
    expect(interventionDetails("APPROVAL_DECISION")).toEqual({
      intervention: true,
      interventionReason: "APPROVAL_DECISION",
    });
  });

  it("only a HUMAN entry with the flag is an intervention", () => {
    expect(isIntervention(entry({ details: interventionDetails("CONTROL_COMMAND") }))).toBe(true);
    expect(isIntervention(entry({ details: {} }))).toBe(false);
    expect(
      isIntervention(
        entry({
          actor: { kind: "system", id: "icos" },
          details: interventionDetails("CONTROL_COMMAND"),
        }),
      ),
    ).toBe(false);
  });

  it("counts tagged debt by reason and by mission, proxies apart, auth never", () => {
    const ledger = interventionLedger([
      entry({ id: "1", details: { ...interventionDetails("APPROVAL_DECISION"), missionId: "m1" } }),
      entry({ id: "2", details: { ...interventionDetails("APPROVAL_DECISION"), missionId: "m1" } }),
      entry({
        id: "3",
        eventType: "control.command.executed",
        details: interventionDetails("CONTROL_COMMAND"),
      }),
      entry({ id: "4", eventType: "human_user.role_changed", details: {} }),
      entry({ id: "5", eventType: "auth.login.succeeded", details: {} }),
      entry({ id: "6", actor: { kind: "system", id: "icos" }, eventType: "task.transitioned" }),
    ]);
    expect(ledger).toEqual({
      tagged: 3,
      untaggedProxy: 1,
      byReason: { APPROVAL_DECISION: 2, CONTROL_COMMAND: 1, MANUAL_TRANSITION: 0 },
      missionsWithDebt: 1,
    });
  });
});
