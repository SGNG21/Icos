import { describe, expect, it } from "vitest";

import { loadEnv } from "@/config/env";

import { createContainer } from "./container";
import { PersistenceConfigError, resolvePersistence } from "./persistence";

describe("resolvePersistence", () => {
  it("développement sans PERSISTENCE → memory", () => {
    expect(resolvePersistence(loadEnv({ NODE_ENV: "development" }))).toBe("memory");
  });

  it("test sans PERSISTENCE → memory", () => {
    expect(resolvePersistence(loadEnv({ NODE_ENV: "test" }))).toBe("memory");
  });

  it("production sans PERSISTENCE → erreur", () => {
    expect(() => resolvePersistence(loadEnv({ NODE_ENV: "production" }))).toThrow(
      PersistenceConfigError,
    );
  });

  it("PERSISTENCE=memory → memory", () => {
    expect(resolvePersistence(loadEnv({ PERSISTENCE: "memory" }))).toBe("memory");
  });

  it("PERSISTENCE=postgres → postgres (sélection, pas de repli)", () => {
    expect(resolvePersistence(loadEnv({ PERSISTENCE: "postgres" }))).toBe("postgres");
  });
});

describe("loadEnv PERSISTENCE", () => {
  it("rejette une valeur inconnue", () => {
    expect(() => loadEnv({ PERSISTENCE: "mongodb" })).toThrow();
  });

  it("traite une chaîne vide comme absente", () => {
    expect(loadEnv({ PERSISTENCE: "" }).PERSISTENCE).toBeUndefined();
  });
});

describe("createContainer (sélection de backend)", () => {
  it("PERSISTENCE=memory → container mémoire fonctionnel", async () => {
    const container = await createContainer({ env: loadEnv({ PERSISTENCE: "memory" }) });
    expect((await container.agents.list()).length).toBeGreaterThan(0);
  });

  it("PERSISTENCE=postgres sans DATABASE_URL → erreur, jamais de repli mémoire", async () => {
    await expect(
      createContainer({ env: loadEnv({ PERSISTENCE: "postgres" }) }),
    ).rejects.toBeInstanceOf(PersistenceConfigError);

    // Confirmation explicite : aucun container mémoire n'est renvoyé.
    let container: unknown = null;
    try {
      container = await createContainer({ env: loadEnv({ PERSISTENCE: "postgres" }) });
    } catch (error) {
      expect((error as PersistenceConfigError).code).toBe("persistence_config_invalid");
    }
    expect(container).toBeNull();
  });

  it("production sans PERSISTENCE → rejet, sans repli mémoire", async () => {
    await expect(
      createContainer({ env: loadEnv({ NODE_ENV: "production" }) }),
    ).rejects.toBeInstanceOf(PersistenceConfigError);
  });
});
