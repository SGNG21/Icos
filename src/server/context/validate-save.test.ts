import { describe, expect, it } from "vitest";

import type { MissionContext } from "@/core/context/contract";

import { makeMissionContext } from "./testing/fixtures";
import { validateSaveInput } from "./validate-save";

describe("validateSaveInput (pure)", () => {
  it("accepte un premier write (expectedVersion null, version 0)", () => {
    const context = makeMissionContext({ version: 0 });
    const result = validateSaveInput(context, null);
    expect(result).toEqual({ ok: true, context });
  });

  it("accepte un append (expectedVersion n, version n+1)", () => {
    const context = makeMissionContext({ version: 3 });
    const result = validateSaveInput(context, 2);
    expect(result).toEqual({ ok: true, context });
  });

  it("normalise via le schéma : applique les defaults et fige la sortie", () => {
    // On omet les champs à default (.default([])) : le schéma les matérialise.
    const partial = {
      tenantId: "tenant-alpha",
      missionId: "mission-001",
      version: 0,
      confirmedObjective: "Objectif confirmé.",
      boundedSummary: "Résumé borné.",
      builtAt: "2026-07-27T10:00:00.000Z",
      builtByLabel: "builder",
    } as unknown as MissionContext;

    const result = validateSaveInput(partial, null);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.confirmedConstraints).toEqual([]);
      expect(result.context.assumptions).toEqual([]);
      expect(result.context.openQuestions).toEqual([]);
      expect(result.context.memoryReferences).toEqual([]);
    }
  });

  it("version_mismatch : version != (expectedVersion ?? -1) + 1", () => {
    // Premier write mais version 1.
    expect(validateSaveInput(makeMissionContext({ version: 1 }), null)).toEqual({
      ok: false,
      reason: "version_mismatch",
    });
    // Trou : expectedVersion 0 exige 1, on fournit 2.
    expect(validateSaveInput(makeMissionContext({ version: 2 }), 0)).toEqual({
      ok: false,
      reason: "version_mismatch",
    });
    // Régression : expectedVersion 5 exige 6, on fournit 5.
    expect(validateSaveInput(makeMissionContext({ version: 5 }), 5)).toEqual({
      ok: false,
      reason: "version_mismatch",
    });
  });

  it("invalid_context : champ superflu ressemblant à une autorité (fail-closed)", () => {
    const context = {
      ...makeMissionContext({ version: 0 }),
      executionGrant: true,
    } as unknown as MissionContext;
    expect(validateSaveInput(context, null)).toEqual({
      ok: false,
      reason: "invalid_context",
    });
  });

  it("invalid_context : champ d'approbation superflu (Stored Context ≠ Approval)", () => {
    const context = {
      ...makeMissionContext({ version: 0 }),
      approvalStatus: "granted",
    } as unknown as MissionContext;
    expect(validateSaveInput(context, null)).toEqual({
      ok: false,
      reason: "invalid_context",
    });
  });

  it("invalid_context : version négative rejetée par les bornes du schéma", () => {
    const context = makeMissionContext({ version: -1 });
    // version=-1 échoue d'abord au schéma (nonnegative) → invalid_context,
    // et non version_mismatch : la validité structurelle prime.
    expect(validateSaveInput(context, -2)).toEqual({
      ok: false,
      reason: "invalid_context",
    });
  });

  it("invalid_context : objectif vide viole la borne min(1)", () => {
    const context = makeMissionContext({ version: 0, confirmedObjective: "" });
    expect(validateSaveInput(context, null)).toEqual({
      ok: false,
      reason: "invalid_context",
    });
  });

  it("l'ordre de priorité est schéma d'abord, version ensuite", () => {
    // Contexte invalide (champ superflu) ET version incohérente : on doit
    // obtenir invalid_context, jamais version_mismatch (fail-closed structurel).
    const context = {
      ...makeMissionContext({ version: 9 }),
      grant: "x",
    } as unknown as MissionContext;
    expect(validateSaveInput(context, 0)).toEqual({
      ok: false,
      reason: "invalid_context",
    });
  });
});
