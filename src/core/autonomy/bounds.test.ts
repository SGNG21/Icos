import { describe, expect, it } from "vitest";

import {
  AUTONOMY_BOUNDS_CEILING,
  requestedBoundsSchema,
  resolveBounds,
  type RuntimeBounds,
} from "@/core/autonomy/bounds";

describe("autonomy runtime bounds", () => {
  it("returns the ceiling verbatim when nothing is requested", () => {
    for (const requested of [undefined, {}]) {
      const resolved = resolveBounds(requested);

      expect(resolved.bounds).toEqual(AUTONOMY_BOUNDS_CEILING);
      expect(resolved.clamped).toEqual([]);
    }
  });

  it("keeps the historical hardcoded values as the policy ceiling", () => {
    expect(AUTONOMY_BOUNDS_CEILING).toEqual({
      maxCycles: 100,
      maxRuntimeMs: 60 * 60 * 1000,
      maxStagnationCycles: 3,
      maxReplans: 5,
    });
  });

  it("accepts a narrowing request field by field", () => {
    const resolved = resolveBounds({
      maxCycles: 20,
      maxRuntimeMs: 30 * 60 * 1000,
      maxReplans: 2,
      maxStagnationCycles: 1,
    });

    expect(resolved.bounds).toEqual({
      maxCycles: 20,
      maxRuntimeMs: 30 * 60 * 1000,
      maxReplans: 2,
      maxStagnationCycles: 1,
    });
    expect(resolved.clamped).toEqual([]);
  });

  it("narrows only the requested fields and keeps the ceiling for the rest", () => {
    const resolved = resolveBounds({ maxCycles: 5 });

    expect(resolved.bounds).toEqual({
      ...AUTONOMY_BOUNDS_CEILING,
      maxCycles: 5,
    });
  });

  /*
   * The "never grant yourself more authority" invariant.
   */
  it("clamps a widening request to the ceiling AND reports every clamped field", () => {
    const resolved = resolveBounds({
      maxCycles: 100_000,
      maxRuntimeMs: 24 * 60 * 60 * 1000,
      maxReplans: 999,
      maxStagnationCycles: 50,
    });

    expect(resolved.bounds).toEqual(AUTONOMY_BOUNDS_CEILING);
    expect([...resolved.clamped].sort()).toEqual([
      "maxCycles",
      "maxReplans",
      "maxRuntimeMs",
      "maxStagnationCycles",
    ]);
  });

  it("reports only the fields that were actually clamped", () => {
    const resolved = resolveBounds({ maxCycles: 101, maxReplans: 1 });

    expect(resolved.bounds.maxCycles).toBe(AUTONOMY_BOUNDS_CEILING.maxCycles);
    expect(resolved.bounds.maxReplans).toBe(1);
    expect(resolved.clamped).toEqual(["maxCycles"]);
  });

  it("clamps against an injected ceiling, not the policy default", () => {
    const tighter: RuntimeBounds = {
      maxCycles: 2,
      maxRuntimeMs: 1_000,
      maxReplans: 0,
      maxStagnationCycles: 1,
    };

    const resolved = resolveBounds({ maxCycles: 50 }, tighter);

    expect(resolved.bounds).toEqual(tighter);
    expect(resolved.clamped).toEqual(["maxCycles"]);
  });

  describe("rejects invalid requests instead of coercing them", () => {
    const invalid: Array<[string, unknown]> = [
      ["zero cycles", { maxCycles: 0 }],
      ["negative cycles", { maxCycles: -1 }],
      ["zero runtime", { maxRuntimeMs: 0 }],
      ["negative replans", { maxReplans: -1 }],
      ["zero stagnation", { maxStagnationCycles: 0 }],
      ["NaN", { maxCycles: Number.NaN }],
      ["Infinity", { maxRuntimeMs: Number.POSITIVE_INFINITY }],
      ["non-integer", { maxCycles: 2.5 }],
      ["numeric string", { maxCycles: "20" }],
      ["null", { maxCycles: null }],
      ["unknown field", { maxCyles: 20 }],
      ["not an object", 20],
    ];

    for (const [label, request] of invalid) {
      it(label, () => {
        expect(() => resolveBounds(request)).toThrow(/AUTONOMY_BOUNDS_INVALID/);
      });
    }
  });

  it("accepts the DB CHECK boundary values (cycles>=1, replans>=0, runtime>=1, stagnation>=1)", () => {
    const resolved = resolveBounds({
      maxCycles: 1,
      maxRuntimeMs: 1,
      maxReplans: 0,
      maxStagnationCycles: 1,
    });

    expect(resolved.bounds).toEqual({
      maxCycles: 1,
      maxRuntimeMs: 1,
      maxReplans: 0,
      maxStagnationCycles: 1,
    });
  });

  it("rejects a ceiling that itself violates the durable CHECK constraints", () => {
    expect(() => resolveBounds({}, { ...AUTONOMY_BOUNDS_CEILING, maxCycles: 0 })).toThrow(
      /AUTONOMY_BOUNDS_CEILING_INVALID/,
    );
  });

  it("exposes a schema whose every field is optional", () => {
    expect(requestedBoundsSchema.safeParse({}).success).toBe(true);
    expect(requestedBoundsSchema.safeParse({ maxReplans: 0 }).success).toBe(true);
  });

  it("does not mutate the caller's request or the ceiling", () => {
    const request = { maxCycles: 100_000 };
    const ceiling = { ...AUTONOMY_BOUNDS_CEILING };

    resolveBounds(request, ceiling);

    expect(request).toEqual({ maxCycles: 100_000 });
    expect(ceiling).toEqual(AUTONOMY_BOUNDS_CEILING);
  });
});
