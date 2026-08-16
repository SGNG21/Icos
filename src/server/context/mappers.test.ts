import { describe, expect, it } from "vitest";

import { RepositoryMappingError } from "@/server/database/errors";
import { missionContextToRow, rowToMissionContext } from "@/server/database/mappers";
import type { missionContexts } from "@/server/database/schema";

import { makeMissionContext } from "./testing/fixtures";

type MissionContextRow = typeof missionContexts.$inferSelect;

/** Construit une ligne SQL cohérente à partir d'un MissionContext. */
function rowFor(
  context: ReturnType<typeof makeMissionContext>,
  createdAt = new Date("2026-07-27T10:05:00.000Z"),
): MissionContextRow {
  const insert = missionContextToRow(context, createdAt);
  return {
    tenantId: insert.tenantId,
    missionId: insert.missionId,
    version: insert.version,
    payload: insert.payload,
    builtAt: insert.builtAt as Date,
    createdAt: insert.createdAt as Date,
  };
}

describe("MissionContext mappers", () => {
  it("round-trip : contexte → ligne → contexte", () => {
    const context = makeMissionContext({ version: 2 });
    const row = rowFor(context);
    expect(rowToMissionContext(row)).toEqual(context);
  });

  it("missionContextToRow : dérive les colonnes de clé du contexte", () => {
    const context = makeMissionContext({
      tenantId: "tenant-beta",
      missionId: "mission-042",
      version: 5,
      builtAt: "2026-07-27T09:00:00.000Z",
    });
    const createdAt = new Date("2026-07-27T09:00:01.000Z");
    const insert = missionContextToRow(context, createdAt);

    expect(insert.tenantId).toBe("tenant-beta");
    expect(insert.missionId).toBe("mission-042");
    expect(insert.version).toBe(5);
    expect(insert.builtAt).toEqual(new Date("2026-07-27T09:00:00.000Z"));
    expect(insert.createdAt).toBe(createdAt);
    expect(insert.payload).toEqual(context);
  });

  it("fail-closed : payload invalide (champ superflu) lève RepositoryMappingError", () => {
    const context = makeMissionContext({ version: 0 });
    const row = rowFor(context);
    // Corruption : un champ d'autorité s'est glissé dans le payload persisté.
    (row.payload as Record<string, unknown>).executionGrant = "granted";

    expect(() => rowToMissionContext(row)).toThrow(RepositoryMappingError);
  });

  it("fail-closed : clé de ligne incohérente avec le payload (tenant altéré)", () => {
    const context = makeMissionContext({ tenantId: "tenant-alpha", version: 0 });
    const row = rowFor(context);
    // La colonne indexée diverge du payload → altération/corruption détectée.
    row.tenantId = "tenant-attacker";

    expect(() => rowToMissionContext(row)).toThrow(RepositoryMappingError);
  });

  it("fail-closed : version de colonne incohérente avec le payload", () => {
    const context = makeMissionContext({ version: 3 });
    const row = rowFor(context);
    row.version = 4;

    expect(() => rowToMissionContext(row)).toThrow(RepositoryMappingError);
  });

  it("fail-closed : missionId de colonne incohérent avec le payload", () => {
    const context = makeMissionContext({ missionId: "mission-001", version: 0 });
    const row = rowFor(context);
    row.missionId = "mission-999";

    expect(() => rowToMissionContext(row)).toThrow(RepositoryMappingError);
  });

  it("le message d'erreur ne divulgue pas le contenu de la ligne", () => {
    const context = makeMissionContext({ version: 0, confirmedObjective: "SECRET-XYZ" });
    const row = rowFor(context);
    row.version = 9;

    try {
      rowToMissionContext(row);
      expect.unreachable("aurait dû lever");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositoryMappingError);
      expect((error as Error).message).not.toContain("SECRET-XYZ");
    }
  });
});
