import type {
  CommandRunner,
  GateCommandContext,
  GateDatabase,
  GateDatabaseSession,
} from "./integration-gate";

/** In-memory command runner that simulates successful execution. */
export class InMemoryCommandRunner implements CommandRunner {
  async run(
    command: string[],
    _ctx: GateCommandContext,
  ): Promise<{ code: number; output: string }> {
    return { code: 0, output: `Simulated success: ${command.join(" ")}` };
  }
}

/**
 * In-memory gate database: a session that names a database nobody serves. The steps it
 * accompanies are simulated (no process runs), so nothing ever connects.
 */
export class InMemoryGateDatabase implements GateDatabase {
  readonly opened: string[] = [];
  readonly closed: string[] = [];

  async open(): Promise<GateDatabaseSession> {
    const name = `icos_test_gate_memory_${this.opened.length}`;
    this.opened.push(name);
    return {
      database: name,
      env: { ICOS_TEST_DATABASE_URL: `postgres://${name}@127.0.0.1:5432/${name}` },
      readWritePaths: [],
      secrets: [],
      wrap: (command) => [...command],
      refusals: () => [],
      close: async () => void this.closed.push(name),
    };
  }
}