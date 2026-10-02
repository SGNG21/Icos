import { describe, expect, it, vi } from "vitest";

import type { CognitiveScope } from "@/core/cognitive/contracts";

import { LaunchedMissionStateSource } from "./current-state-source";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const clock = { now: () => NOW };

const scope = (overrides: Partial<CognitiveScope> = {}): CognitiveScope => ({
  tenantId: "tenant-1",
  userId: "user-1",
  clientId: null,
  projectId: null,
  ...overrides,
});

const goalRef = (overrides: Record<string, unknown> = {}) => ({
  id: "ref-1",
  kind: "goal_proposal",
  status: "launched",
  projectId: null,
  missionId: "mission-1",
  payload: { title: "Améliorer ICOS" },
  ...overrides,
});

describe("LaunchedMissionStateSource", () => {
  it("reads the CLIENT-LESS refs of the tenant when the scope has no client", async () => {
    // Un objectif interne ("Améliore ICOS") n'a pas de client. Avant ce correctif la source
    // retournait [] sans même interroger le ledger : l'état vivant était illisible.
    const refsForClient = vi.fn().mockResolvedValue([goalRef()]);
    const source = new LaunchedMissionStateSource(
      { refsForClient },
      { findById: async () => ({ status: "running" }) },
      clock,
    );

    const out = await source.candidates(scope());

    expect(refsForClient).toHaveBeenCalledWith("tenant-1", null, expect.any(Array));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ live: true, subject: "mission:mission-1" });
    expect(out[0]?.text).toContain("running");
  });

  it("still scopes to the client when there is one", async () => {
    const refsForClient = vi.fn().mockResolvedValue([]);
    const source = new LaunchedMissionStateSource({ refsForClient }, null, clock);

    await source.candidates(scope({ clientId: "client-9" }));

    expect(refsForClient).toHaveBeenCalledWith("tenant-1", "client-9", expect.any(Array));
  });

  it("does not claim `live` when the mission status cannot be read", async () => {
    const refsForClient = vi.fn().mockResolvedValue([goalRef()]);
    const source = new LaunchedMissionStateSource(
      { refsForClient },
      {
        findById: async () => {
          throw new Error("CORE3_DOWN");
        },
      },
      clock,
    );

    const out = await source.candidates(scope());

    expect(out).toHaveLength(1);
    expect(out[0]).not.toHaveProperty("live");
    expect(out[0]?.text).toContain("non disponible");
  });
});
