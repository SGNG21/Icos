import { describe, expect, it } from "vitest";

import { WORK_CLASSES, type WorkClass } from "./contracts";
import {
  DEFAULT_PORTFOLIO_POLICY,
  allocate,
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
    // Fill the global pool with USER work, leaving only other classes' reservations.
    const policy: PortfolioPolicy = DEFAULT_PORTFOLIO_POLICY;
    const reservedElsewhere = WORK_CLASSES.filter((c) => c !== "USER").reduce(
      (sum, c) => sum + policy.classes[c].reserved,
      0,
    );
    const active = zeroed();
    active.USER = policy.globalMaxConcurrent - reservedElsewhere;

    const user = allocate(policy, state({ active }), { class: "USER", computeUnits: 1 }, NOW);
    expect(user.admit).toBe(false);
    if (user.admit) throw new Error("unreachable");
    expect(user.reason).toBe("GLOBAL_CONCURRENCY");

    const security = allocate(policy, state({ active }), { class: "SECURITY", computeUnits: 1 }, NOW);
    expect(security.admit).toBe(true);
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
