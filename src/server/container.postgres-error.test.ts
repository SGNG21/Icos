import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "@/config/env";
import { GET as getAgents } from "@/app/api/agents/route";

import { createContainer, getContainer, resetContainer } from "./container";

const savedPersistence = process.env.PERSISTENCE;
const savedUrl = process.env.DATABASE_URL;

function restoreEnv(): void {
  if (savedPersistence === undefined) delete process.env.PERSISTENCE;
  else process.env.PERSISTENCE = savedPersistence;
  if (savedUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedUrl;
}

describe("container postgres — chemins d'erreur (sans Docker)", () => {
  afterEach(async () => {
    await resetContainer();
    restoreEnv();
  });

  it("memory ignore DATABASE_URL et n'ouvre aucune connexion", async () => {
    const container = await createContainer({
      env: loadEnv({ PERSISTENCE: "memory", DATABASE_URL: "postgres://bad:5432/x" }),
    });
    expect((await container.agents.list()).length).toBeGreaterThan(0);
    await container.close();
  });

  it("route → 503 persistence_unavailable si la base est injoignable (aucun fallback)", async () => {
    process.env.PERSISTENCE = "postgres";
    process.env.DATABASE_URL = "postgres://icos:icos@127.0.0.1:1/icos";
    await resetContainer();

    const response = await getAgents();
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("persistence_unavailable");
    // Aucun détail SQL/URL/hôte exposé.
    expect(body.error.message).not.toContain("127.0.0.1");
    expect(JSON.stringify(body)).not.toContain("postgres://");
  });
});
