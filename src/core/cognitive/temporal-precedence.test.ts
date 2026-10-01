import { describe, expect, it } from "vitest";

import { applyTemporalPrecedence, selectContext, type ContextCandidate } from "./context-selection";

/**
 * TEMPORAL_PRECEDENCE (decision 0063): a live reading of the current state outranks any
 * remembered claim about the same subject. The memory row is not modified — it simply does not
 * enter this turn's prompt, with reason `stale`.
 */
const now = new Date("2026-10-01T12:00:00.000Z");

const base = {
  anchored: false,
  entityIds: [] as readonly string[],
  confidence: 1,
  epistemic: null,
  trust: "trusted",
} as const;

const remembered = (ref: string, text: string, subject?: string): ContextCandidate => ({
  ...base,
  stage: "episodic",
  kind: "memory",
  ref,
  text,
  occurredAt: "2026-09-01T09:00:00.000Z",
  subject,
});

/** What the SYSTEM is (phone lane, decision 0062): `runtime` stage, no subject. */
const runtimeFact = (ref: string, text: string, subject?: string): ContextCandidate => ({
  ...base,
  stage: "runtime",
  kind: "runtime_state",
  ref,
  text,
  occurredAt: now.toISOString(),
  epistemic: "TOOL_CONFIRMED",
  anchored: true,
  subject,
});

const live = (ref: string, text: string, subject: string): ContextCandidate => ({
  ...base,
  stage: "current",
  kind: "current_state",
  ref,
  text,
  occurredAt: now.toISOString(),
  subject,
  live: true,
  anchored: true,
});

describe("TEMPORAL_PRECEDENCE", () => {
  it("drops a stale memory when a live reading speaks about the same subject", () => {
    const { kept, stale } = applyTemporalPrecedence([
      remembered("memory:m1", "la mission audit SEO est en cours", "mission:mi_7"),
      live("mission:mi_7", "Mission « audit SEO » — état courant : completed", "mission:mi_7"),
    ]);
    expect(kept.map((c) => c.ref)).toEqual(["mission:mi_7"]);
    expect(stale).toEqual([{ ref: "memory:m1", reason: "stale" }]);
  });

  it("keeps memories about OTHER subjects untouched", () => {
    const { kept, stale } = applyTemporalPrecedence([
      remembered("memory:m1", "mission A en cours", "mission:mi_1"),
      remembered("memory:m2", "mission B en cours", "mission:mi_2"),
      live("mission:mi_1", "Mission A — état courant : failed", "mission:mi_1"),
    ]);
    expect(kept.map((c) => c.ref).sort()).toEqual(["memory:m2", "mission:mi_1"]);
    expect(stale).toEqual([{ ref: "memory:m1", reason: "stale" }]);
  });

  it("leaves everything alone when there is no live reading (no live source wired)", () => {
    const candidates = [
      remembered("memory:m1", "mission A en cours", "mission:mi_1"),
      remembered("memory:m2", "autre fait"),
    ];
    const { kept, stale } = applyTemporalPrecedence(candidates);
    expect(kept).toHaveLength(2);
    expect(stale).toEqual([]);
  });

  it("does not drop a memory that carries no subject", () => {
    const { kept } = applyTemporalPrecedence([
      remembered("memory:m1", "préférence du client"),
      live("mission:mi_1", "Mission A — état courant : completed", "mission:mi_1"),
    ]);
    expect(kept.map((c) => c.ref).sort()).toEqual(["memory:m1", "mission:mi_1"]);
  });

  it("selectContext reports the stale exclusion and never ranks the stale item", () => {
    const result = selectContext(
      [
        remembered("memory:m1", "mission audit en cours", "mission:mi_7"),
        live("mission:mi_7", "Mission « audit » — état courant : completed", "mission:mi_7"),
      ],
      "où en est la mission audit ?",
      new Set<string>(),
      { tokenBudget: 1_000, maxSensitivity: "sensitive" },
      now,
    );
    expect(result.items.map((i) => i.ref)).toEqual(["mission:mi_7"]);
    expect(result.excluded).toContainEqual({ ref: "memory:m1", reason: "stale" });
    expect(result.items.map((i) => i.ref)).not.toContain("memory:m1");
  });

  it("a live item is relevant on its own: current state is never gated out as irrelevant", () => {
    const result = selectContext(
      [live("mission:mi_9", "Mission « refonte » — état courant : running", "mission:mi_9")],
      "bonjour",
      new Set<string>(),
      { tokenBudget: 1_000, maxSensitivity: "sensitive" },
      now,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].reason).toContain("current_state");
  });
});

/**
 * THE TWO LIVE AUTHORITIES, TOGETHER.
 *
 * Central integration reconciled two mechanisms that two parallel lanes had invented
 * independently off the same baseline, each for "live state outranks memory":
 *
 *   - `runtime` / `runtime_state` (decision 0062) — what the SYSTEM is: which capabilities
 *     are connected, what is running. Weight 0.9.
 *   - `current` / `current_state` (decision 0063) — what the resolved client's WORK is,
 *     read live from CORE3, plus `applyTemporalPrecedence`. Weight 0.6.
 *
 * Both survived the merge, they share ONE `STAGE_WEIGHT`, ONE `CONTEXT_ITEM_KINDS` and ONE
 * selection pass — and before this block nothing exercised them together: each lane's own
 * tests only ever saw its own mechanism. These are the joint properties the merge must keep.
 */
describe("the two live authorities coexist without shadowing each other", () => {
  const SYSTEM = runtimeFact("runtime:capability.workers", "Workers enregistrés : 0");
  const WORK = live("mission:mi_7", "Mission « audit » — état courant : running", "mission:mi_7");

  it("keeps BOTH in the prompt: neither mechanism removes the other", () => {
    const result = selectContext(
      [SYSTEM, WORK],
      "où en est l'audit, et de quoi es-tu capable ?",
      new Set<string>(),
      { tokenBudget: 1_000, maxSensitivity: "sensitive" },
      now,
    );
    expect(result.items.map((i) => i.ref).sort()).toEqual([
      "mission:mi_7",
      "runtime:capability.workers",
    ]);
    expect(result.excluded).toEqual([]);
  });

  it("lets each authority supersede a memory in its own lane, in one pass", () => {
    const result = selectContext(
      [
        remembered("memory:m1", "la mission audit est terminée", "mission:mi_7"),
        // Anchored so it is relevant: the point here is that a stale self-description is
        // OUTRANKED by the measurement, not that it is gated out as off-topic.
        { ...remembered("memory:m2", "ICOS n'est pas connecté à CORE3"), anchored: true },
        SYSTEM,
        WORK,
      ],
      "où en est l'audit ?",
      new Set<string>(),
      { tokenBudget: 1_000, maxSensitivity: "sensitive" },
      now,
    );
    // The subject-matched memory is superseded by the live work reading...
    expect(result.excluded).toContainEqual({ ref: "memory:m1", reason: "stale" });
    expect(result.items.map((i) => i.ref)).not.toContain("memory:m1");
    // ...while the subjectless stale self-description survives selection and is instead
    // outranked, which is the runtime stage's own mechanism (0.9 vs episodic 0.2).
    const order = result.items.map((i) => i.ref);
    expect(order).toContain("memory:m2");
    expect(order.indexOf("runtime:capability.workers")).toBeLessThan(order.indexOf("memory:m2"));
  });

  it("REGRESSION GUARD: a runtime fact that gains a subject must not be dropped as stale", () => {
    /*
     * `applyTemporalPrecedence` drops any non-`live` candidate whose subject a `live` item
     * claims. Runtime facts are safe today only because the two builders set no `subject`
     * (`self-model.ts`, `operational-state.ts`). `OperationalStateSource` already emits
     * per-mission prose, so one added field would make lane D silently suppress lane B's
     * authority — a measured fact replaced by nothing. If this test ever fails, the fix is
     * to treat `runtime_state` as live, NOT to delete this guard.
     */
    const subjected = runtimeFact(
      "runtime:mission.mi_7",
      "Mission ouverte « audit » — statut running",
      "mission:mi_7",
    );
    const { kept, stale } = applyTemporalPrecedence([subjected, WORK]);
    expect(stale).toEqual([]);
    expect(kept.map((c) => c.ref).sort()).toEqual(["mission:mi_7", "runtime:mission.mi_7"]);
  });
});
