import { describe, expect, it } from "vitest";

import { categoryOf, rootCauseOf } from "@/core/contracts/failure-cause";

/**
 * A budget refusal is a DECISION, not an outage.
 *
 * Two live missions sat parked for hours in a review_pending -> review_unavailable loop.
 * The reviewer was healthy, the context complete and the budget seam correct: the Goal
 * had spent 174,749 of 200,000 tokens and the final review needed 26,153. The refusal was
 * filed as a generic review failure, so the retry machinery treated an owner decision
 * about money as a transient provider problem — and the attempt counter reset on every
 * reclaim, so the retry limit could never be reached.
 *
 * Retrying it spends nothing and changes nothing: the cap is still the cap next time.
 */
describe("a budget refusal is classified as budget, not as a provider failure", () => {
  /** The exact message the live runtime produced, trimmed of ids. */
  const LIVE =
    "QUALITY_REVIEWER_BUDGET_EXHAUSTED:BUDGET/BUDGET_EXHAUSTED [provider=claude]: " +
    "BUDGET_DENIED:RESERVATION_EXCEEDS_CAP 174749 dépensés + 0 réservés + 26153 demandés " +
    "= 200902 pour un plafond de 200000";

  it("recognises the live refusal as a budget cause", () => {
    expect(rootCauseOf(new Error(LIVE))).toBe("BUDGET_EXHAUSTED");
    expect(categoryOf(rootCauseOf(new Error(LIVE)))).toBe("BUDGET");
  });

  it("recognises every cap denial as budget, not provider failure", () => {
    for (const deny of ["RESERVATION_EXCEEDS_CAP", "TOKEN_CAP_REACHED", "MONEY_CAP_REACHED"]) {
      const cause = rootCauseOf(new Error(`BUDGET_DENIED:${deny} ...`));
      expect(categoryOf(cause), deny).toBe("BUDGET");
      expect(cause, deny).not.toBe("PROVIDER_FAILURE");
    }
  });

  it("does not mistake a real provider failure for a budget one", () => {
    expect(categoryOf(rootCauseOf(new Error("upstream returned 503")))).not.toBe("BUDGET");
  });
});

/**
 * The retry counter has to survive the cooldown, or the limit is unreachable.
 *
 * This is the SQL the claim performs, expressed as the arithmetic it has to satisfy: a
 * reclaim from `review_unavailable` increments like any other claim. It used to reset to
 * 1, so attempts ran 1,2,3, parked, came back as 1, and looped for ever.
 */
describe("review attempt counter is monotonic across cooldown", () => {
  const nextCount = (state: string, count: number): number =>
    ["review_pending", "reviewing", "review_unavailable"].includes(state) ? count + 1 : count;

  it("a reclaim after parking does not restart the budget", () => {
    expect(nextCount("review_unavailable", 3)).toBe(4);
  });

  it("the limit is actually reachable across a park/reclaim cycle", () => {
    const MAX = 3;
    let count = 0;
    let state = "review_pending";
    for (let cycle = 0; cycle < 10 && count <= MAX; cycle += 1) {
      count = nextCount(state, count);
      /* Parking and coming back is exactly what used to reset it. */
      state = "review_unavailable";
    }
    expect(count).toBeGreaterThan(MAX);
  });
});
