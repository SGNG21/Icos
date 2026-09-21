import { execFile } from "node:child_process";
import type { CommandRunner, GateDatabase } from "./integration-gate";

/** PostgreSQL-backed command runner that executes commands in the workspace. */
export class PostgresCommandRunner implements CommandRunner {
  run(
    command: string[],
    ctx: { cwd: string; env: NodeJS.ProcessEnv },
  ): Promise<{ code: number; output: string }> {
    const [bin, ...args] = command;
    return new Promise((resolve) => {
      execFile(
        bin!,
        args,
        { ...ctx, maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60_000 },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
          resolve({ code, output: `${stdout}\n${stderr}`.trim() });
        },
      );
    });
  }
}

/** PostgreSQL-backed gate database. */
export class PostgresGateDatabase implements GateDatabase {
  async reset(name: string): Promise<void> {
    // This will be called by IntegrationGate to reset the test database
    // The actual database operations are handled by the TestDatabaseProvisioner
    // This is a no-op since the provisioner handles it
  }
}