import { describe, expect, it } from "vitest";

import { latestOf, observe } from "./observed";
import { missing, real } from "./truth";

const at = new Date("2026-10-20T00:00:00.000Z");
const base = { collectedAt: at, maxAgeMs: 30_000, source: "t" };

describe("observe", () => {
  it("ok : lue, horodatée, récente", () => {
    const o = observe({
      ...base,
      truth: real({ t: "2026-10-19T23:59:50.000Z" }),
      observedAt: (v) => v.t,
    });
    expect(o).toMatchObject({
      state: "ok",
      observedAt: "2026-10-19T23:59:50.000Z",
      data: { t: "2026-10-19T23:59:50.000Z" },
    });
    expect(o.errorCode).toBeUndefined();
    expect(o.collectedAt).toBe(at.toISOString());
  });

  it("stale : plus vieille que maxAgeMs, données conservées", () => {
    const o = observe({ ...base, truth: real("x"), observedAt: () => "2026-10-19T23:59:00.000Z" });
    expect(o).toMatchObject({ state: "stale", data: "x" });
  });

  it("sans seuil (maxAgeMs null) : jamais stale", () => {
    const o = observe({
      ...base,
      maxAgeMs: null,
      truth: real("x"),
      observedAt: () => "2020-01-01T00:00:00.000Z",
    });
    expect(o.state).toBe("ok");
  });

  it("degraded : lue mais sans horodatage source (fraîcheur improuvable), données conservées", () => {
    const o = observe({ ...base, truth: real(7), observedAt: () => null });
    expect(o).toMatchObject({
      state: "degraded",
      data: 7,
      observedAt: null,
      errorCode: "NO_SOURCE_TIMESTAMP",
    });
    const bad = observe({ ...base, truth: real(7), observedAt: () => "not a date" });
    expect(bad).toMatchObject({ state: "degraded", errorCode: "INVALID_SOURCE_TIMESTAMP" });
  });

  it("unavailable : lecture échouée ou non composée, data null, code assaini", () => {
    expect(
      observe({
        ...base,
        truth: missing("unknown", "x could not be read"),
        observedAt: () => null,
      }),
    ).toMatchObject({
      state: "unavailable",
      data: null,
      errorCode: "READ_FAILED",
    });
    expect(
      observe({ ...base, truth: missing("not_connected", "no db"), observedAt: () => null }),
    ).toMatchObject({
      state: "unavailable",
      errorCode: "NOT_CONNECTED",
    });
  });

  it("forbidden : une portée refusée n'est pas une absence", () => {
    const o = observe({
      ...base,
      truth: missing("not_available", "This source is visible to owner/admin scope only."),
      observedAt: () => null,
    });
    expect(o).toMatchObject({ state: "forbidden", data: null, errorCode: "FORBIDDEN_SCOPE" });
  });

  it("porte le tenant uniquement quand il est fourni", () => {
    expect(observe({ ...base, truth: real(1), observedAt: () => null }).tenantId).toBeUndefined();
    expect(
      observe({ ...base, tenantId: "default", truth: real(1), observedAt: () => null }).tenantId,
    ).toBe("default");
  });
});

describe("latestOf", () => {
  it("prend le plus récent, ignore null et dates illisibles", () => {
    expect(
      latestOf([null, "2026-01-01T00:00:00.000Z", new Date("2026-02-01T00:00:00.000Z"), "nope"]),
    ).toBe("2026-02-01T00:00:00.000Z");
    expect(latestOf([null, undefined])).toBeNull();
  });
});
