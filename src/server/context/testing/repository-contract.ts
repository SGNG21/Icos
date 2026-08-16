import { expect, it } from "vitest";

import type { MissionContextRepository } from "../ports";
import { makeMissionContext } from "./fixtures";

/**
 * Contrat de comportement PARTAGÉ par tous les backends de
 * `MissionContextRepository` (in-memory + PostgreSQL). Exécuté par chaque suite
 * afin de garantir une sémantique STRICTEMENT identique (parité testée).
 *
 * Ne couvre QUE ce qui est déterministe sur les deux backends. La course
 * concurrente réelle (`version_conflict`) est spécifique à PostgreSQL et testée
 * séparément dans la suite d'intégration.
 *
 * `makeRepo` est appelé une fois par `it` : chaque cas part d'un store vierge.
 */
export function runMissionContextRepositoryContract(
  makeRepo: () => MissionContextRepository | Promise<MissionContextRepository>,
): void {
  it("premier write : version 0 avec expectedVersion null", async () => {
    const repo = await makeRepo();
    const context = makeMissionContext({ version: 0 });

    const result = await repo.save({ context, expectedVersion: null });

    expect(result).toEqual({ ok: true, context });
    expect(await repo.findLatest("tenant-alpha", "mission-001")).toEqual(context);
    expect(await repo.findVersion("tenant-alpha", "mission-001", 0)).toEqual(context);
  });

  it("append monotone : v0 puis v1, latest dérivé du MAX(version)", async () => {
    const repo = await makeRepo();
    const v0 = makeMissionContext({ version: 0, boundedSummary: "v0" });
    const v1 = makeMissionContext({ version: 1, boundedSummary: "v1" });

    expect((await repo.save({ context: v0, expectedVersion: null })).ok).toBe(true);
    expect((await repo.save({ context: v1, expectedVersion: 0 })).ok).toBe(true);

    expect(await repo.findLatest("tenant-alpha", "mission-001")).toEqual(v1);
    // Les versions antérieures restent lisibles (append-only, immuable).
    expect(await repo.findVersion("tenant-alpha", "mission-001", 0)).toEqual(v0);
    expect(await repo.findVersion("tenant-alpha", "mission-001", 1)).toEqual(v1);
  });

  it("stale_version : expectedVersion null alors qu'un latest existe", async () => {
    const repo = await makeRepo();
    await repo.save({ context: makeMissionContext({ version: 0 }), expectedVersion: null });

    // Writer périmé : croit être le premier (expectedVersion null ⇒ version 0),
    // mais un latest=0 existe déjà. Le payload est valide (version 0 cohérente
    // avec expectedVersion null) : le refus vient bien de stale_version, pas de
    // version_mismatch.
    const result = await repo.save({
      context: makeMissionContext({ version: 0, boundedSummary: "doublon" }),
      expectedVersion: null,
    });

    expect(result).toEqual({ ok: false, reason: "stale_version" });
  });

  it("stale_version : expectedVersion en retard sur le latest réel", async () => {
    const repo = await makeRepo();
    await repo.save({ context: makeMissionContext({ version: 0 }), expectedVersion: null });
    await repo.save({ context: makeMissionContext({ version: 1 }), expectedVersion: 0 });

    // Le writer attend latest=0 mais le latest réel est 1.
    const result = await repo.save({
      context: makeMissionContext({ version: 1 }),
      expectedVersion: 0,
    });

    expect(result).toEqual({ ok: false, reason: "stale_version" });
    // L'état persisté n'a pas régressé.
    expect((await repo.findLatest("tenant-alpha", "mission-001"))?.version).toBe(1);
  });

  it("version_mismatch : le payload ne porte pas (expectedVersion + 1)", async () => {
    const repo = await makeRepo();
    await repo.save({ context: makeMissionContext({ version: 0 }), expectedVersion: null });

    // expectedVersion=0 exige version=1 ; le payload porte 2 (trou) → refus.
    const result = await repo.save({
      context: makeMissionContext({ version: 2 }),
      expectedVersion: 0,
    });

    expect(result).toEqual({ ok: false, reason: "version_mismatch" });
  });

  it("version_mismatch : premier write dont la version n'est pas 0", async () => {
    const repo = await makeRepo();

    const result = await repo.save({
      context: makeMissionContext({ version: 1 }),
      expectedVersion: null,
    });

    expect(result).toEqual({ ok: false, reason: "version_mismatch" });
  });

  it("invalid_context : champ d'autorité superflu rejeté (fail-closed)", async () => {
    const repo = await makeRepo();
    const context = {
      ...makeMissionContext({ version: 0 }),
      // Champ ressemblant à une autorité : `.strict()` doit le refuser.
      executionGrant: "granted",
    } as unknown as ReturnType<typeof makeMissionContext>;

    const result = await repo.save({ context, expectedVersion: null });

    expect(result).toEqual({ ok: false, reason: "invalid_context" });
    // Rien n'a été persisté.
    expect(await repo.findLatest("tenant-alpha", "mission-001")).toBeNull();
  });

  it("isolation tenant : findLatest/findVersion filtrent par tenant (anti-IDOR)", async () => {
    const repo = await makeRepo();
    const alpha = makeMissionContext({ tenantId: "tenant-alpha", version: 0 });
    const beta = makeMissionContext({ tenantId: "tenant-beta", version: 0 });

    await repo.save({ context: alpha, expectedVersion: null });
    await repo.save({ context: beta, expectedVersion: null });

    expect(await repo.findLatest("tenant-alpha", "mission-001")).toEqual(alpha);
    expect(await repo.findLatest("tenant-beta", "mission-001")).toEqual(beta);
    // Un tenant ne voit jamais la mission d'un autre, même id de mission identique.
    expect(await repo.findVersion("tenant-alpha", "mission-001", 0)).toEqual(alpha);
    expect(await repo.findVersion("tenant-beta", "mission-001", 0)).toEqual(beta);
    expect(alpha).not.toEqual(beta);
  });

  it("isolation tenant : deux tenants versionnent la même mission indépendamment", async () => {
    const repo = await makeRepo();
    // Même missionId, tenants distincts : les flux de versions sont séparés.
    await repo.save({
      context: makeMissionContext({ tenantId: "tenant-alpha", version: 0 }),
      expectedVersion: null,
    });
    // Le premier write de tenant-beta reste version 0 (pas de stale_version croisé).
    const result = await repo.save({
      context: makeMissionContext({ tenantId: "tenant-beta", version: 0 }),
      expectedVersion: null,
    });

    expect(result.ok).toBe(true);
  });

  it("isolation mission : deux missions du même tenant versionnent indépendamment", async () => {
    const repo = await makeRepo();
    await repo.save({
      context: makeMissionContext({ missionId: "mission-001", version: 0 }),
      expectedVersion: null,
    });
    const result = await repo.save({
      context: makeMissionContext({ missionId: "mission-002", version: 0 }),
      expectedVersion: null,
    });

    expect(result.ok).toBe(true);
    expect(await repo.findLatest("tenant-alpha", "mission-002")).not.toBeNull();
  });

  it("findLatest/findVersion : null pour une mission ou une version absente", async () => {
    const repo = await makeRepo();
    expect(await repo.findLatest("tenant-alpha", "mission-404")).toBeNull();
    expect(await repo.findVersion("tenant-alpha", "mission-404", 0)).toBeNull();

    await repo.save({ context: makeMissionContext({ version: 0 }), expectedVersion: null });
    // La version 7 n'existe pas.
    expect(await repo.findVersion("tenant-alpha", "mission-001", 7)).toBeNull();
  });
}
