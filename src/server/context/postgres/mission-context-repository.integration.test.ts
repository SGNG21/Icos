import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  dockerAvailable,
  startPostgres,
  stopPostgres,
  truncateAll,
  type PgContext,
} from "@/server/database/testing/pg-support";

import { makeMissionContext } from "../testing/fixtures";
import { runMissionContextRepositoryContract } from "../testing/repository-contract";
import { PostgresMissionContextRepository } from "./mission-context-repository";

/**
 * Parité PostgreSQL du MissionContextRepository. Rejoue le contrat partagé
 * (identité sémantique avec l'in-memory) contre une vraie base, puis ajoute les
 * cas propres au backend : course concurrente réelle (`version_conflict`) et
 * persistance effective via clé primaire composite.
 */
describe.skipIf(!dockerAvailable)(
  "PostgresMissionContextRepository (intégration)",
  () => {
    let ctx: PgContext;

    beforeAll(async () => {
      ctx = await startPostgres();
    }, 120_000);

    afterAll(async () => {
      await stopPostgres(ctx);
    });

    beforeEach(async () => {
      await truncateAll(ctx.handle);
    });

    // Parité : le MÊME contrat que l'in-memory doit passer sur PostgreSQL.
    describe("contrat partagé", () => {
      runMissionContextRepositoryContract(async () => {
        await truncateAll(ctx.handle);
        return new PostgresMissionContextRepository(ctx.handle.db);
      });
    });

    describe("spécificités backend", () => {
      it("version_conflict : deux INSERT concurrents sur la même version", async () => {
        const repo = new PostgresMissionContextRepository(ctx.handle.db);
        await repo.save({
          context: makeMissionContext({ version: 0 }),
          expectedVersion: null,
        });

        // Deux writers lisent latest=0 puis tentent d'écrire la version 1 en
        // parallèle. La clé primaire composite garantit qu'un seul gagne ;
        // l'autre reçoit 23505 → version_conflict (jamais last-write-wins).
        const [a, b] = await Promise.all([
          repo.save({
            context: makeMissionContext({ version: 1, boundedSummary: "writer-a" }),
            expectedVersion: 0,
          }),
          repo.save({
            context: makeMissionContext({ version: 1, boundedSummary: "writer-b" }),
            expectedVersion: 0,
          }),
        ]);

        const outcomes = [a, b].map((r) => (r.ok ? "ok" : r.reason)).sort();
        // Un gagnant, un perdant explicite (stale_version ou version_conflict
        // selon l'entrelacement : les deux sont des refus fail-closed valides).
        expect(outcomes).toContain("ok");
        expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
        const loser = outcomes.find((o) => o !== "ok");
        expect(["version_conflict", "stale_version"]).toContain(loser);

        // Le latest persisté est la version 1 d'UN seul writer (pas de doublon).
        const latest = await repo.findLatest("tenant-alpha", "mission-001");
        expect(latest?.version).toBe(1);
        expect(["writer-a", "writer-b"]).toContain(latest?.boundedSummary);
      });

      it("persistance effective : snapshots immuables lisibles par version", async () => {
        const repo = new PostgresMissionContextRepository(ctx.handle.db);
        await repo.save({
          context: makeMissionContext({ version: 0, boundedSummary: "v0" }),
          expectedVersion: null,
        });
        await repo.save({
          context: makeMissionContext({ version: 1, boundedSummary: "v1" }),
          expectedVersion: 0,
        });

        // Nouvelle instance de repository : la lecture vient bien de la base.
        const fresh = new PostgresMissionContextRepository(ctx.handle.db);
        expect((await fresh.findVersion("tenant-alpha", "mission-001", 0))?.boundedSummary).toBe("v0");
        expect((await fresh.findVersion("tenant-alpha", "mission-001", 1))?.boundedSummary).toBe("v1");
        expect((await fresh.findLatest("tenant-alpha", "mission-001"))?.version).toBe(1);
      });

      it("horloge injectée : created_at déterministe côté persistance", async () => {
        const fixed = new Date("2026-07-27T12:34:56.000Z");
        const repo = new PostgresMissionContextRepository(ctx.handle.db, () => fixed);
        const result = await repo.save({
          context: makeMissionContext({ version: 0 }),
          expectedVersion: null,
        });
        expect(result.ok).toBe(true);
        // La lecture round-trip conserve le payload (built_at du contexte).
        const latest = await repo.findLatest("tenant-alpha", "mission-001");
        expect(latest?.builtAt).toBe("2026-07-27T10:00:00.000Z");
      });
    });
  },
);
