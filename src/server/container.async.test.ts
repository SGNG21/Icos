import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getContainer } from "./container";

const CONTAINER_KEY = "__icosContainerPromise__";

function resetContainer(): void {
  delete (globalThis as Record<string, unknown>)[CONTAINER_KEY];
}

describe("getContainer (singleton globalThis)", () => {
  const savedPersistence = process.env.PERSISTENCE;

  beforeEach(() => {
    resetContainer();
    delete process.env.PERSISTENCE; // développement/test → memory
  });

  afterEach(() => {
    resetContainer();
    if (savedPersistence === undefined) {
      delete process.env.PERSISTENCE;
    } else {
      process.env.PERSISTENCE = savedPersistence;
    }
  });

  it("deux appels concurrents réussis renvoient la même instance", async () => {
    const [a, b] = await Promise.all([getContainer(), getContainer()]);
    expect(a).toBe(b);
  });

  it("une initialisation rejetée n'est pas figée dans globalThis, et une nouvelle tentative réussit", async () => {
    // Force un échec : backend postgres non implémenté.
    process.env.PERSISTENCE = "postgres";
    await expect(getContainer()).rejects.toBeTruthy();

    // Le cache global a été purgé.
    expect((globalThis as Record<string, unknown>)[CONTAINER_KEY]).toBeUndefined();

    // Après correction de la configuration, une nouvelle tentative réussit.
    delete process.env.PERSISTENCE;
    const container = await getContainer();
    expect((await container.agents.list()).length).toBeGreaterThan(0);
  });
});
