import type { MissionContext } from "@/core/context/contract";

/**
 * Fabrique un MissionContext valide pour les tests. Overrides superficiels.
 * N'introduit JAMAIS de champ d'autorité : le contrat 1A `.strict()` le
 * refuserait de toute façon.
 */
export function makeMissionContext(
  overrides: Partial<MissionContext> = {},
): MissionContext {
  return {
    tenantId: "tenant-alpha",
    missionId: "mission-001",
    version: 0,
    confirmedObjective: "Livrer le rapport trimestriel validé.",
    confirmedConstraints: [],
    assumptions: [],
    openQuestions: [],
    boundedSummary: "Livrer le rapport trimestriel validé.",
    memoryReferences: [],
    builtAt: "2026-07-27T10:00:00.000Z",
    builtByLabel: "context-builder-test",
    ...overrides,
  };
}
