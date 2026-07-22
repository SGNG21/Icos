import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  sql: Sql;
  close: () => Promise<void>;
}

export interface CreateDatabaseOptions {
  /** Taille du pool. Modérée par défaut ; réduire en environnement serverless. */
  max?: number;
}

/**
 * Crée un client PostgreSQL et l'instance Drizzle associée.
 *
 * Aucune connexion réseau n'est établie tant qu'une requête n'est pas émise
 * (postgres.js se connecte paresseusement). Réservé au runtime Node.js ; ne
 * jamais importer depuis un module client. La sélection du backend et la
 * mémoïsation applicative relèvent du container (Lot 2A-2b) : ce module n'est
 * instancié que lorsque `PERSISTENCE=postgres`.
 */
export function createDatabase(url: string, options: CreateDatabaseOptions = {}): DatabaseHandle {
  const sql = postgres(url, {
    max: options.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    close: () => sql.end({ timeout: 5 }),
  };
}
