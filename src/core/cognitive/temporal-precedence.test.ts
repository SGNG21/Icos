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
    expect(result.excluded).toEqual([{ ref: "memory:m1", reason: "stale" }]);
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
