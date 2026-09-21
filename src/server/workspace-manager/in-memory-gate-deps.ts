import type { CommandRunner, GateDatabase } from "./integration-gate";

/** In-memory command runner that simulates successful execution. */
export class InMemoryCommandRunner implements CommandRunner {
  async run(
    command: string[],
    ctx: { cwd: string; env: NodeJS.ProcessEnv },
  ): Promise<{ code: number; output: string }> {
    return { code: 0, output: `Simulated success: ${command.join(" ")}` };
  }
}

/** In-memory gate database that simulates database operations. */
export class InMemoryGateDatabase implements GateDatabase {
  async reset(name: string): Promise<void> {
    // No-op for in-memory
  }
}