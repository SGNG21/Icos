import { and, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { ExecutionGrant } from "@/core/g1";
import type { GrantRepository } from "@/server/g1/ports";
import type { Database } from "@/server/database/client";
import { executionGrantToRow, rowToExecutionGrant } from "@/server/database/mappers";
import { executionGrants } from "@/server/database/schema";

/**
 * GrantRepository PostgreSQL.
 *
 * Les grants sont stockés avec un TTL court et consommés atomiquement via
 * UPDATE conditionnel avec RETURNING pour garantir le single-use même en
 * cas d'accès concurrent (PostgreSQL MVCC + verrouillage de ligne).
 */
export class PostgresGrantRepository implements GrantRepository {
  constructor(private readonly db: Database | PostgresJsDatabase<Record<string, never>>) {}

  async save(grant: ExecutionGrant): Promise<void> {
    await this.db.insert(executionGrants).values(executionGrantToRow(grant));
  }

  async findById(id: string): Promise<ExecutionGrant | null> {
    const rows = await this.db
      .select()
      .from(executionGrants)
      .where(eq(executionGrants.id, id))
      .limit(1);

    return rows.length > 0 ? rowToExecutionGrant(rows[0]) : null;
  }

  /**
   * Consomme atomiquement un grant.
   *
   * Drizzle + PostgreSQL garantissent que la clause WHERE est évaluée
   * sous verrouillage de ligne : deux sessions concurrentes ne peuvent
   * pas consommer le même grant.
   */
  async consumeAtomically(id: string): Promise<boolean> {
    const rows = await this.db
      .update(executionGrants)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(executionGrants.id, id),
          isNull(executionGrants.consumedAt),
          sql`${executionGrants.expiresAt} > NOW()`,
        ),
      )
      .returning({ id: executionGrants.id });

    return rows.length > 0;
  }

  async listAvailable(tenantId: string): Promise<ExecutionGrant[]> {
    const rows = await this.db
      .select()
      .from(executionGrants)
      .where(
        and(
          eq(executionGrants.tenantId, tenantId),
          isNull(executionGrants.consumedAt),
          sql`${executionGrants.expiresAt} > NOW()`,
        ),
      );

    return rows.map(rowToExecutionGrant);
  }
}
