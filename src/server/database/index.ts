import { createDatabase, type DatabaseHandle } from "./client";
import * as schema from "./schema";

/** Database connection handle */
let _dbHandle: DatabaseHandle | null = null;

/** Get or create the database connection */
export async function getDb(): Promise<DatabaseHandle> {
  if (!_dbHandle) {
    const url = process.env.DATABASE_URL || "postgresql://localhost:5432/icos";
    _dbHandle = createDatabase(url);
  }
  return _dbHandle;
}

/** Export schema for use in other modules */
export { schema };

/** For testing - reset the connection */
export function resetDb(): void {
  if (_dbHandle) {
    _dbHandle.close().catch(() => {});
    _dbHandle = null;
  }
}
