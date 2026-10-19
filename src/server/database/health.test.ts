import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import { createDatabaseHealth } from "./health";

function fakeSql(behaviour: "ok" | "error" | "hang") {
  const cancel = vi.fn();
  const sql = (() => {
    const promise =
      behaviour === "ok"
        ? Promise.resolve([{ ok: 1 }])
        : behaviour === "error"
          ? Promise.reject(new Error("password authentication failed for user icos at host db"))
          : new Promise(() => {});
    return Object.assign(promise, { cancel });
  }) as unknown as Sql;
  return { sql, cancel };
}

describe("createDatabaseHealth", () => {
  it("mesure un SELECT 1 réussi", async () => {
    const { sql } = fakeSql("ok");
    expect(await createDatabaseHealth(sql).ping(500)).toMatchObject({ ok: true });
  });

  it("masque le message du driver en cas d'erreur", async () => {
    const { sql } = fakeSql("error");
    const result = await createDatabaseHealth(sql).ping(500);
    expect(result).toMatchObject({ ok: false, error: "error" });
    expect(JSON.stringify(result)).not.toMatch(/password|icos|host/);
  });

  it("annule la requête au-delà du délai", async () => {
    const { sql, cancel } = fakeSql("hang");
    expect(await createDatabaseHealth(sql).ping(20)).toMatchObject({ ok: false, error: "timeout" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
