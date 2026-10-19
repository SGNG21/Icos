import { describe, expect, it } from "vitest";

import { FixedWindowRateLimiter } from "./rate-limit";

describe("FixedWindowRateLimiter", () => {
  it("autorise jusqu'à la limite puis refuse avec un délai de reprise", () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter(3, 60_000, () => now);
    expect([1, 2, 3].map(() => limiter.check("u").allowed)).toEqual([true, true, true]);
    now = 45_000;
    expect(limiter.check("u")).toEqual({ allowed: false, retryAfterSeconds: 15 });
    expect(limiter.check("other").allowed).toBe(true); // par utilisateur
    now = 60_000;
    expect(limiter.check("u").allowed).toBe(true); // nouvelle fenêtre
  });

  it("borne la mémoire au nombre maximal de clés", () => {
    const limiter = new FixedWindowRateLimiter(1, 60_000, () => 0, 10);
    for (let i = 0; i < 100; i += 1) limiter.check(`user-${i}`);
    expect(
      (limiter as unknown as { windows: Map<string, unknown> }).windows.size,
    ).toBeLessThanOrEqual(10);
  });
});
