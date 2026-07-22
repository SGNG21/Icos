import { migrate } from "drizzle-orm/postgres-js/migrator";

import type { Database } from "./client";

/**
 * Applique les migrations SQL du dossier `drizzle/` sur une base (vide ou
 * existante). Utilisé par les tests d'intégration et par le script `db:migrate`.
 */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: "drizzle" });
}
