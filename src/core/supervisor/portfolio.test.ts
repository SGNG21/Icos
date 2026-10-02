import { describe, expect, it } from "vitest";

import { WORK_CLASSES, type WorkClass } from "./contracts";
import {
  DEFAULT_PORTFOLIO_POLICY,
  allocate,
  assertPortfolioPolicyCoherent,
  type PortfolioPolicy,
  type PortfolioState,
} from "./portfolio";

const NOW = new Date("2026-10-02T12:00:00.000Z");

const zeroed = (): Record<WorkClass, number> =>
  Object.fromEntries(WORK_CLASSES.map((c) => [c, 0])) as Record<WorkClass, number>;

const state = (over: Partial<PortfolioState> = {}): PortfolioState => ({
  windowStartedAt: NOW,
  active: zeroed(),
  computeSpent: zeroed(),
  ...over,
});

describe("allocate", () => {
  it("admits into an idle portfolio and shows its arithmetic", () => {
    const d = allocate(DEFAULT_PORTFOLIO_POLICY, state(), { class: "USER", computeUnits: 1 }, NOW);
    expect(d.admit).toBe(true);
    expect(d.evidence.policyVersion).toBe(DEFAULT_PORTFOLIO_POLICY.version);
    expect(d.evidence.slotsAvailable).toBeGreaterThan(0);
  });

  it("defers, never rejects, when a class is at its concurrency cap", () => {
    const active = zeroed();
    active.RESEARCH = DEFAULT_PORTFOLIO_POLICY.classes.RESEARCH.maxConcurrent;
    const d = allocate(
      DEFAULT_PORTFOLIO_POLICY,
      state({ active }),
      { class: "RESEARCH", computeUnits: 1 },
      NOW,
    );
    expect(d.admit).toBe(false);
    if (d.admit) throw new Error("unreachable");
    expect(d.defer).toBe(true);
    expect(d.reason).toBe("CLASS_CONCURRENCY");
    expect(d.retryAfterMs).toBeGreaterThan(0);
  });

  it("SUPERVISOR_BUDGET_EXHAUSTION defers to the next window boundary", () => {
    const computeSpent = zeroed();
    computeSpent.USER = DEFAULT_PORTFOLIO_POLICY.classes.USER.computeBudgetUnits;
    const halfway = new Date(NOW.getTime() + DEFAULT_PORTFOLIO_POLICY.windowMs / 2);
    const d = allocate(
      DEFAULT_PORTFOLIO_POLICY,
      state({ computeSpent }),
      { class: "USER", computeUnits: 1 },
      halfway,
    );
    expect(d.admit).toBe(false);
    if (d.admit) throw new Error("unreachable");
    expect(d.reason).toBe("COMPUTE_BUDGET");
    expect(d.retryAfterMs).toBe(DEFAULT_PORTFOLIO_POLICY.windowMs / 2);
  });

  it("keeps the global pool at least as large as the sum of reservations", () => {
    // Over-subscribed reservations would deadlock the pool for every class at once.
    const totalReserved = WORK_CLASSES.reduce(
      (sum, c) => sum + DEFAULT_PORTFOLIO_POLICY.classes[c].reserved,
      0,
    );
    expect(DEFAULT_PORTFOLIO_POLICY.globalMaxConcurrent).toBeGreaterThanOrEqual(totalReserved);
  });

  it("never starves a lower class: reserved slots are not takeable", () => {
    const policy = DEFAULT_PORTFOLIO_POLICY;
    // Load the pool with the two classes that can legitimately hold the most.
    const active = zeroed();
    active.USER = policy.classes.USER.maxConcurrent; // 4
    active.CLIENT = policy.classes.CLIENT.maxConcurrent; // 4
    active.REVENUE = policy.classes.REVENUE.maxConcurrent; // 2

    // MAINTENANCE has run nothing: its reservation is a floor and must still admit it.
    const reservedDraw = allocate(
      policy,
      state({ active }),
      { class: "MAINTENANCE", computeUnits: 1 },
      NOW,
    );
    expect(reservedDraw.admit).toBe(true);

    // Once MAINTENANCE is at its reservation it competes for the shared pool like anyone
    // else, and the pool is gone.
    active.MAINTENANCE = policy.classes.MAINTENANCE.reserved;
    const pooledDraw = allocate(
      policy,
      state({ active }),
      { class: "MAINTENANCE", computeUnits: 1 },
      NOW,
    );
    expect(pooledDraw.admit).toBe(false);
    if (pooledDraw.admit) throw new Error("unreachable");
    expect(pooledDraw.reason).toBe("GLOBAL_CONCURRENCY");
  });

  it("reservations already consumed do not block the global pool", () => {
    const policy: PortfolioPolicy = { ...DEFAULT_PORTFOLIO_POLICY, globalMaxConcurrent: 8 };
    // Every other class is already using its reservation; nothing is held back for them.
    const active = zeroed();
    for (const c of WORK_CLASSES) {
      if (c !== "USER") active[c] = policy.classes[c].reserved;
    }
    const totalActive = WORK_CLASSES.reduce((s, c) => s + active[c], 0);
    const d = allocate(policy, state({ active }), { class: "USER", computeUnits: 1 }, NOW);
    expect(totalActive).toBeLessThan(policy.globalMaxConcurrent);
    expect(d.admit).toBe(true);
  });

  it("is deterministic", () => {
    const s = state();
    const a = allocate(DEFAULT_PORTFOLIO_POLICY, s, { class: "CLIENT", computeUnits: 2 }, NOW);
    const b = allocate(DEFAULT_PORTFOLIO_POLICY, s, { class: "CLIENT", computeUnits: 2 }, NOW);
    expect(a).toEqual(b);
  });

  it("gives every class a reserved slot, so none can be squeezed out by policy", () => {
    for (const c of WORK_CLASSES) {
      expect(DEFAULT_PORTFOLIO_POLICY.classes[c].reserved).toBeGreaterThanOrEqual(1);
    }
  });

  it("resets the compute window once it has elapsed", () => {
    const computeSpent = zeroed();
    computeSpent.USER = DEFAULT_PORTFOLIO_POLICY.classes.USER.computeBudgetUnits;
    const afterWindow = new Date(NOW.getTime() + DEFAULT_PORTFOLIO_POLICY.windowMs + 1);
    const d = allocate(
      DEFAULT_PORTFOLIO_POLICY,
      state({ computeSpent }),
      { class: "USER", computeUnits: 1 },
      afterWindow,
    );
    expect(d.admit).toBe(true);
  });
});

describe("allocate — reservations must not starve the only class with demand (review I5)", () => {
  it("lets a class reach its own maxConcurrent when every other class is idle", () => {
    const policy = DEFAULT_PORTFOLIO_POLICY;
    const active = zeroed();
    // Walk USER up to its advertised cap with nothing else running anywhere.
    for (let n = 0; n < policy.classes.USER.maxConcurrent; n += 1) {
      active.USER = n;
      const d = allocate(policy, state({ active }), { class: "USER", computeUnits: 1 }, NOW);
      expect({ n, admit: d.admit }).toEqual({ n, admit: true });
    }
    // And stops at it.
    active.USER = policy.classes.USER.maxConcurrent;
    const over = allocate(policy, state({ active }), { class: "USER", computeUnits: 1 }, NOW);
    expect(over.admit).toBe(false);
    if (over.admit) throw new Error("unreachable");
    expect(over.reason).toBe("CLASS_CONCURRENCY");
  });

  it("admits a class drawing within its own reservation even when the pool is full", () => {
    const policy = DEFAULT_PORTFOLIO_POLICY;
    const active = zeroed();
    active.USER = policy.classes.USER.maxConcurrent;
    active.CLIENT = policy.classes.CLIENT.maxConcurrent;
    active.REVENUE = policy.classes.REVENUE.maxConcurrent;
    // SECURITY has run nothing and is inside its own reservation: it must still get in.
    const d = allocate(policy, state({ active }), { class: "SECURITY", computeUnits: 1 }, NOW);
    expect(d.admit).toBe(true);
  });

  it("still refuses a class that is beyond its reservation when the pool is exhausted", () => {
    const policy = DEFAULT_PORTFOLIO_POLICY;
    const active = zeroed();
    for (const c of WORK_CLASSES) active[c] = policy.classes[c].maxConcurrent;
    const d = allocate(policy, state({ active }), { class: "RESEARCH", computeUnits: 1 }, NOW);
    expect(d.admit).toBe(false);
  });

  it("leaves a shared pool above the sum of reservations", () => {
    const totalReserved = WORK_CLASSES.reduce(
      (s, c) => s + DEFAULT_PORTFOLIO_POLICY.classes[c].reserved,
      0,
    );
    expect(DEFAULT_PORTFOLIO_POLICY.globalMaxConcurrent).toBeGreaterThan(totalReserved);
  });
});

describe("assertPortfolioPolicyCoherent (review M3)", () => {
  it("accepts the shipped default", () => {
    expect(() => assertPortfolioPolicyCoherent(DEFAULT_PORTFOLIO_POLICY)).not.toThrow();
  });

  it("refuses an over-subscribed pool that would deadlock every class", () => {
    expect(() =>
      assertPortfolioPolicyCoherent({ ...DEFAULT_PORTFOLIO_POLICY, globalMaxConcurrent: 2 }),
    ).toThrow(/reserved/i);
  });

  it("refuses a reservation larger than the class's own cap", () => {
    expect(() =>
      assertPortfolioPolicyCoherent({
        ...DEFAULT_PORTFOLIO_POLICY,
        classes: {
          ...DEFAULT_PORTFOLIO_POLICY.classes,
          RESEARCH: { maxConcurrent: 1, reserved: 3, computeBudgetUnits: 100 },
        },
      }),
    ).toThrow(/reserved/i);
  });
});
