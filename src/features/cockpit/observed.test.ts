import { describe, expect, it } from "vitest";

import { FORBIDDEN_SCOPE_REQUIREMENT, latestOf, observe, scopeRefused } from "./observed";
import { missing, real } from "./truth";

const at = new Date("2026-10-20T00:00:00.000Z");
const base = { collectedAt: at, maxAgeMs: 30_000, source: "t" };

describe("observe", () => {
  it("ok : lue, horodatée, récente, complète", () => {
    const o = observe({
      ...base,
      truth: real({ t: "2026-10-19T23:59:50.000Z" }),
      observedAt: (v) => v.t,
    });
    expect(o).toMatchObject({ state: "ok", observedAt: "2026-10-19T23:59:50.000Z" });
    expect(o.errorCode).toBeUndefined();
    expect(o.collectedAt).toBe(at.toISOString());
  });

  it("stale : plus vieille que maxAgeMs, données conservées", () => {
    const o = observe({ ...base, truth: real("x"), observedAt: () => "2026-10-19T23:59:00.000Z" });
    expect(o).toMatchObject({ state: "stale", data: "x" });
    expect(o.errorCode).toBeUndefined();
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

  it("degraded : lue mais sans horodatage source ; EMPTY_SOURCE quand la valeur est vide", () => {
    expect(observe({ ...base, truth: real(7), observedAt: () => null })).toMatchObject({
      state: "degraded",
      data: 7,
      errorCode: "NO_SOURCE_TIMESTAMP",
    });
    expect(
      observe({ ...base, truth: real([]), observedAt: () => null, empty: (v) => v.length === 0 }),
    ).toMatchObject({ state: "degraded", errorCode: "EMPTY_SOURCE" });
    expect(observe({ ...base, truth: real(7), observedAt: () => "not a date" })).toMatchObject({
      state: "degraded",
      errorCode: "INVALID_SOURCE_TIMESTAMP",
    });
  });

  it("dérive d'horloge : un horodatage source dans le futur n'est pas frais", () => {
    const future = observe({
      ...base,
      truth: real("x"),
      observedAt: () => "2026-10-20T05:00:00.000Z",
    });
    expect(future).toMatchObject({ state: "degraded", errorCode: "FUTURE_SOURCE_TIMESTAMP" });
    // Une avance d'une poignée de secondes (horloges légèrement désynchronisées) reste ok.
    expect(
      observe({ ...base, truth: real("x"), observedAt: () => "2026-10-20T00:00:30.000Z" }).state,
    ).toBe("ok");
  });

  it("degraded partiel : une sous-source illisible dégrade une lecture fraîche avec son code", () => {
    const o = observe({
      ...base,
      truth: real("x"),
      observedAt: () => "2026-10-19T23:59:59.000Z",
      degradedCode: "LEDGER_UNAVAILABLE",
    });
    expect(o).toMatchObject({ state: "degraded", errorCode: "LEDGER_UNAVAILABLE", data: "x" });
    // Périmée ET partielle : stale l'emporte, le code reste porté.
    const s = observe({
      ...base,
      truth: real("x"),
      observedAt: () => "2026-10-19T23:00:00.000Z",
      degradedCode: "LEDGER_UNAVAILABLE",
    });
    expect(s).toMatchObject({ state: "stale", errorCode: "LEDGER_UNAVAILABLE" });
    expect(
      observe({ ...base, truth: real("x"), observedAt: () => null, degradedCode: null }).state,
    ).toBe("degraded");
  });

  it("unavailable : lecture échouée ou non composée, data null, code assaini", () => {
    expect(
      observe({
        ...base,
        truth: missing("unknown", "x could not be read"),
        observedAt: () => null,
      }),
    ).toMatchObject({ state: "unavailable", data: null, errorCode: "READ_FAILED" });
    expect(
      observe({ ...base, truth: missing("not_connected", "no db"), observedAt: () => null }),
    ).toMatchObject({ state: "unavailable", errorCode: "NOT_CONNECTED" });
  });

  it("forbidden : décidé par le marqueur structuré, jamais par le texte de la raison", () => {
    expect(observe({ ...base, truth: scopeRefused("X"), observedAt: () => null })).toMatchObject({
      state: "forbidden",
      data: null,
      errorCode: "FORBIDDEN_SCOPE",
    });
    expect(scopeRefused("X")).toMatchObject({ requirement: FORBIDDEN_SCOPE_REQUIREMENT });
    // Une phrase qui parle de portée sans le marqueur n'est qu'une absence.
    expect(
      observe({
        ...base,
        truth: missing("not_available", "visible to owner/admin scope only"),
        observedAt: () => null,
      }).state,
    ).toBe("unavailable");
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
