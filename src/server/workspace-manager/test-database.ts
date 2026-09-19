import postgres from "postgres";

import {
  TEST_DATABASE_URL,
  assertSafeTestDatabaseUrl,
} from "@/server/database/test-database-guard";

import { assertWorkerDatabaseName } from "./guards";

/** Une DB de test par workspace : jamais partagée, jamais la live. */
export interface TestDatabaseProvisioner {
  create(name: string): Promise<void>;
  drop(name: string): Promise<void>;
}

/** URL de la DB d'un worker, sur le même serveur/identifiants que la base de test commune. */
export function workerDatabaseUrl(name: string, baseUrl: string = TEST_DATABASE_URL): string {
  assertWorkerDatabaseName(name);
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  assertSafeTestDatabaseUrl(url.toString());
  return url.toString();
}

export class PostgresTestDatabaseProvisioner implements TestDatabaseProvisioner {
  constructor(private readonly baseUrl: string = TEST_DATABASE_URL) {}

  private async admin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
    const url = new URL(this.baseUrl);
    url.pathname = "/postgres";
    const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      return await fn(sql);
    } finally {
      await sql.end();
    }
  }

  async create(name: string): Promise<void> {
    assertWorkerDatabaseName(name);
    await this.admin(async (sql) => {
      const found = await sql`select 1 from pg_database where datname = ${name}`;
      if (found.length === 0) await sql.unsafe(`create database "${name}"`);
    });
  }

  async drop(name: string): Promise<void> {
    assertWorkerDatabaseName(name);
    await this.admin((sql) => sql.unsafe(`drop database if exists "${name}" with (force)`));
  }

  /** Base vierge (pour prouver qu'une migration s'applique depuis zéro). */
  async reset(name: string): Promise<void> {
    await this.drop(name);
    await this.create(name);
  }
}
