import type { GateDatabase } from "./integration-gate";

/*
 * The gate's command runner is `SandboxedCommandRunner` (sandboxed-command-runner.ts). The
 * `execFile` runner that lived here inherited the server's whole environment and ran
 * worker-authored code unconfined (P0); it is gone, not deprecated.
 */

/** PostgreSQL-backed gate database. */
export class PostgresGateDatabase implements GateDatabase {
  async reset(name: string): Promise<void> {
    // This will be called by IntegrationGate to reset the test database
    // The actual database operations are handled by the TestDatabaseProvisioner
    // This is a no-op since the provisioner handles it
  }
}