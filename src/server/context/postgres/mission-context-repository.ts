import { and, desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { MissionContext } from "@/core/context/contract";
import type { Database } from "@/server/database/client";
import { uniqueConstraintName } from "@/server/database/errors";
import {
  missionContextToRow,
  rowToMissionContext,
} from "@/server/database/mappers";
import { missionContexts } from "@/server/database/schema";

import type {
  MissionContextRepository,
  SaveContextResult,
  SaveMissionContextInput,
} from "../ports";
import { validateSaveInput } from "../validate-save";

/**
 * MissionContextRepository PostgreSQL — snapshots versionnés immuables.
 *
 * Concurrence FAIL-CLOSED :
 * - la clé primaire composite `(tenant_id, mission_id, version)` empêche
 *   physiquement deux lignes de partager une version ;
 * - une course perdue à l'INSERT remonte en `23505 unique_violation`, mappée en
 *   `version_conflict` (jamais un last-write-wins).
 *
 * Isolation : toute lecture filtre par `tenant_id` ET `mission_id` (défense
 * IDOR). Le « latest » est dérivé de `ORDER BY version DESC LIMIT 1`.
 */
export class PostgresMissionContextRepository
  implements MissionContextRepository
{
  constructor(
    private readonly db: Database | PostgresJsDatabase<Record<string, never>>,
    /** Horloge de persistance injectable (déterminisme des tests). */
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async save(input: SaveMissionContextInput): Promise<SaveContextResult> {
    const pre = validateSaveInput(input.context, input.expectedVersion);
    if (!pre.ok) {
      return pre;
    }
    const context = pre.context;

    // Compare le latest attendu au latest réel (writer périmé/régressif).
    const latest = await this.latestVersion(context.tenantId, context.missionId);
    if (input.expectedVersion !== latest) {
      return { ok: false, reason: "stale_version" };
    }

    // INSERT append-only. Une course concurrente sur la même version viole la
    // clé primaire composite → `23505` → conflit explicite.
    try {
      await this.db
        .insert(missionContexts)
        .values(missionContextToRow(context, this.clock()));
    } catch (error) {
      if (uniqueConstraintName(error) !== null) {
        return { ok: false, reason: "version_conflict" };
      }
      throw error;
    }

    return { ok: true, context };
  }

  private async latestVersion(
    tenantId: string,
    missionId: string,
  ): Promise<number | null> {
    const rows = await this.db
      .select({ version: missionContexts.version })
      .from(missionContexts)
      .where(
        and(
          eq(missionContexts.tenantId, tenantId),
          eq(missionContexts.missionId, missionId),
        ),
      )
      .orderBy(desc(missionContexts.version))
      .limit(1);

    return rows.length > 0 ? rows[0].version : null;
  }

  async findLatest(
    tenantId: string,
    missionId: string,
  ): Promise<MissionContext | null> {
    const rows = await this.db
      .select()
      .from(missionContexts)
      .where(
        and(
          eq(missionContexts.tenantId, tenantId),
          eq(missionContexts.missionId, missionId),
        ),
      )
      .orderBy(desc(missionContexts.version))
      .limit(1);

    return rows.length > 0 ? rowToMissionContext(rows[0]) : null;
  }

  async findVersion(
    tenantId: string,
    missionId: string,
    version: number,
  ): Promise<MissionContext | null> {
    const rows = await this.db
      .select()
      .from(missionContexts)
      .where(
        and(
          eq(missionContexts.tenantId, tenantId),
          eq(missionContexts.missionId, missionId),
          eq(missionContexts.version, version),
        ),
      )
      .limit(1);

    return rows.length > 0 ? rowToMissionContext(rows[0]) : null;
  }
}
