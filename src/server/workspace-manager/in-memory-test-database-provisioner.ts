import type { TestDatabaseProvisioner } from "./test-database";

/** In-memory test database provisioner for memory-backed containers. */
export class InMemoryTestDatabaseProvisioner implements TestDatabaseProvisioner {
  private databases = new Set<string>();

  async create(name: string): Promise<void> {
    this.databases.add(name);
  }

  async drop(name: string): Promise<void> {
    this.databases.delete(name);
  }
}