import { describe, expect, it } from "vitest";

import { CircuitBreaker } from "./circuit-breaker";

const options = {
  failureThreshold: 3,
  cooldownMs: 1_000,
  hardCooldownMs: 10_000,
  maxRetryAfterMs: 5_000,
};

function breaker() {
  let now = 0;
  const b = new CircuitBreaker(options, () => now);
  return { b, advance: (ms: number) => void (now += ms) };
}

describe("CircuitBreaker", () => {
  it("opens after N consecutive counted failures, not before", () => {
    const { b } = breaker();
    b.onFailure("UPSTREAM");
    b.onFailure("TIMEOUT");
    expect(b.current).toBe("closed");
    b.onFailure("UNAVAILABLE");
    expect(b.snapshot()).toMatchObject({
      state: "open",
      consecutiveFailures: 3,
      lastFailureClass: "UNAVAILABLE",
      lastFailureAt: 0,
      cooldownUntil: 1_000,
    });
    expect(b.tryAcquire()).toBe(false);
  });

  it("a success resets the count", () => {
    const { b } = breaker();
    b.onFailure("UPSTREAM");
    b.onFailure("UPSTREAM");
    b.onSuccess();
    b.onFailure("UPSTREAM");
    expect(b.current).toBe("closed");
    expect(b.snapshot().lastSuccessAt).toBe(0);
  });

  it("after cooldown: exactly one trial; success closes, failure re-opens", () => {
    const { b, advance } = breaker();
    for (let i = 0; i < 3; i++) b.onFailure("UPSTREAM");
    advance(1_000);
    expect(b.tryAcquire()).toBe(true);
    expect(b.current).toBe("half_open");
    expect(b.tryAcquire()).toBe(false); // one trial at a time
    b.onFailure("UPSTREAM");
    expect(b.snapshot()).toMatchObject({ state: "open", cooldownUntil: 2_000 });
    advance(1_000);
    expect(b.tryAcquire()).toBe(true);
    b.onSuccess();
    expect(b.snapshot()).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
      cooldownUntil: null,
    });
  });

  it("auth / configuration failures open at once with the long cooldown", () => {
    for (const failure of ["AUTH_FAILED", "CONFIG_INVALID"] as const) {
      const { b } = breaker();
      b.onFailure(failure);
      expect(b.snapshot()).toMatchObject({ state: "open", cooldownUntil: 10_000 });
    }
  });

  it("a rate limit with Retry-After opens for that long, bounded", () => {
    const { b } = breaker();
    b.onFailure("RATE_LIMITED", 3);
    expect(b.snapshot().cooldownUntil).toBe(3_000);
    const { b: capped } = breaker();
    capped.onFailure("RATE_LIMITED", 3_600);
    expect(capped.snapshot().cooldownUntil).toBe(5_000);
  });

  it("an abort is not evidence: it never counts and it releases a trial", () => {
    const { b, advance } = breaker();
    b.onFailure("ABORTED");
    expect(b.snapshot().consecutiveFailures).toBe(0);
    for (let i = 0; i < 3; i++) b.onFailure("UPSTREAM");
    advance(1_000);
    expect(b.tryAcquire()).toBe(true);
    b.onNeutral();
    expect(b.tryAcquire()).toBe(true); // the trial is available again
  });

  it("`available` answers without reserving the trial", () => {
    const { b, advance } = breaker();
    for (let i = 0; i < 3; i++) b.onFailure("UPSTREAM");
    expect(b.available).toBe(false);
    advance(1_000);
    expect(b.available).toBe(true);
    expect(b.available).toBe(true);
    expect(b.tryAcquire()).toBe(true);
  });
});
