/**
 * Seed the durable client directory (decision 0062). Idempotent: a second run reports
 * `duplicate` for every fact and changes nothing.
 *
 * Usage: tsx scripts/seed-client-knowledge.ts <postgres-url> [tenantId]
 *
 * Writes only what the repository establishes (see client-directory-seed.ts) and prints
 * everything the brief asks for that the repository does NOT establish, so missing business
 * data is reported instead of invented.
 */
import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity";
import { seedClientDirectory } from "@/server/cognitive/client-directory-seed";
import { PostgresCognitiveMemoryStore } from "@/server/cognitive/memory-store";
import { createDatabase } from "@/server/database/client";

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url)
    throw new Error("usage: tsx scripts/seed-client-knowledge.ts <postgres-url> [tenantId]");
  const tenantId = process.argv[3] ?? CURRENT_SINGLE_TENANT_ID;
  const handle = createDatabase(url);
  try {
    const report = await seedClientDirectory(new PostgresCognitiveMemoryStore(handle.db), tenantId);
    console.log(`SEEDED_ENTITIES ${report.entities}`);
    for (const f of report.facts) console.log(`FACT ${f.subjectKey} ${f.outcome}`);
    console.log("MISSING_BUSINESS_DATA:");
    for (const m of report.missing) console.log(`  - ${m}`);
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
