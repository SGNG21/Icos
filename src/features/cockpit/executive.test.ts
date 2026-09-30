import { describe, expect, it } from "vitest";

import type { AuditEntry } from "@/core/contracts";

import { notConnectedBusiness } from "./business";
import { buildExecutiveView } from "./executive";
import { notConnectedWorkforce } from "./workforce";
import { buildCockpitSnapshot, type CockpitSources } from "./snapshot";
import { missing, real } from "./truth";

const NOW = new Date("2026-09-29T12:00:00Z");
const base: CockpitSources = {
  now: NOW,
  backend: "postgres",
  scope: "global",
  tasks: real([]),
  missions: real([]),
  workers: real([]),
  activeAssignments: real([]),
  attempts: real([]),
  pendingApprovals: real(0),
  audit: real([]),
  qualityJobs: real([]),
  workspaces: real([]),
};

const entry = (i: number, kind: "agent" | "human" | "system", hoursAgo: number): AuditEntry =>
  ({
    id: `a${i}`,
    eventType: "task.created",
    actor: { kind, id: `${kind}-1` },
    occurredAt: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
    createdAt: NOW.toISOString(),
  }) as AuditEntry;

describe("executive view", () => {
  it("business data ICOS does not hold is NOT_CONNECTED, never zero", async () => {
    const v = buildExecutiveView(
      buildCockpitSnapshot(base),
      base.audit,
      await notConnectedWorkforce.read(),
      await notConnectedBusiness.read(),
    );
    for (const k of ["proposals", "digitalWorkforce", "business"] as const)
      expect(v[k].kind).toBe("not_connected");
  });

  it("counts autonomous vs human actions over the FULL audit window, not the capped timeline", async () => {
    const audit = real([
      ...Array.from({ length: 60 }, (_, i) => entry(i, "agent", 1)),
      entry(100, "human", 2),
      entry(101, "system", 30), // outside 24h
    ]);
    const v = buildExecutiveView(
      buildCockpitSnapshot({ ...base, audit }),
      audit,
      await notConnectedWorkforce.read(),
      await notConnectedBusiness.read(),
    );
    expect(v.autonomousActions24h).toMatchObject({ kind: "real", value: 60 });
    expect(v.humanActions24h).toMatchObject({ kind: "real", value: 1 });
  });

  it("an unreadable mission source leaves objectives and blockers unknown", async () => {
    const s = { ...base, missions: missing<never>("unknown", "down") };
    const v = buildExecutiveView(
      buildCockpitSnapshot(s),
      base.audit,
      await notConnectedWorkforce.read(),
      await notConnectedBusiness.read(),
    );
    expect(v.objectives.kind).toBe("unknown");
    expect(v.blockers.kind).toBe("unknown");
  });
});
