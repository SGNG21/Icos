import { afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";

import { createDatabase } from "@/server/database/client";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { PostgresRecoveryUnitRepository } from "@/server/recovery/postgres-recovery-unit-repository";
import { describeRecoveryUnitRepositoryContract } from "@/server/recovery/recovery-unit-repository.contract";

const handle = createDatabase(TEST_DATABASE_URL);
afterAll(() => handle.close());
beforeEach(async () => {
  await handle.db.execute(sql.raw("TRUNCATE TABLE recovery_units"));
});

describeRecoveryUnitRepositoryContract(
  "PostgreSQL",
  async () => new PostgresRecoveryUnitRepository(handle.db),
);
