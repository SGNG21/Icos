/**
 * Vérification LECTURE SEULE du ledger Drizzle (`drizzle.__drizzle_migrations`)
 * contre le journal + les fichiers SQL : mêmes lignes (hash = sha256 du fichier,
 * created_at = `when`), donc un futur `migrate()` ne rejouera rien. N'exécute
 * jamais `migrate()` et n'écrit rien.
 *
 * Usage : pnpm db:verify-ledger <postgres-url>
 */
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) throw new Error("usage: db:verify-ledger <postgres-url>");
  const expected = readMigrationFiles({ migrationsFolder: "drizzle" });
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql<{ hash: string; created_at: string }[]>`
      select hash, created_at from drizzle.__drizzle_migrations order by id`;
    const problems: string[] = [];
    if (rows.length !== expected.length) {
      problems.push(`ledger has ${rows.length} rows, journal has ${expected.length}`);
    }
    expected.forEach((e, i) => {
      const r = rows[i];
      if (!r) return void problems.push(`missing row ${i + 1} (when=${e.folderMillis})`);
      if (Number(r.created_at) !== e.folderMillis) problems.push(`row ${i + 1}: created_at differs`);
      if (r.hash !== e.hash) problems.push(`row ${i + 1}: hash differs`);
    });
    if (problems.length) {
      console.error(`LEDGER_MISMATCH\n${problems.join("\n")}`);
      process.exitCode = 1;
    } else {
      console.log(`LEDGER_OK ${rows.length} rows match the journal; migrate() would apply nothing`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
