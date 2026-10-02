import { describe, expect, it } from "vitest";

import { buildPipeline } from "./pipeline";
import { real } from "./truth";

const NOW = new Date("2026-10-02T12:00:00Z");

const stages = () =>
  buildPipeline({
    now: NOW,
    attempts: real([]),
    qualityJobs: real([]),
    workspaces: real([]),
  }).stages;

const reasonOf = (key: string): string => {
  const count = stages().find((s) => s.key === key)!.count;
  if (count.kind === "real") throw new Error(`${key} is real; this test is about its gap`);
  return count.reason;
};

/**
 * A stale reason is a lie the cockpit tells with a straight face. These two were checked
 * against the repository at this base and must not drift back.
 */
describe("pipeline gaps state the verified reason", () => {
  it("does not claim settlement lives on an unmerged branch (defect 36 is an ancestor of HEAD)", () => {
    const reason = reasonOf("settlement");
    expect(reason).not.toMatch(/branch/i);
    expect(reason).not.toMatch(/not integrated/i);
    expect(reason).toMatch(/settleAccepted/);
    expect(reason).toMatch(/counter/i);
  });

  it("names the listable escalation query and why the cockpit source still misses it", () => {
    const reason = reasonOf("escalated");
    expect(reason).toMatch(/listEscalated/);
    expect(reason).toMatch(/listPending/);
  });

  it("keeps both as explicit gaps rather than zero", () => {
    for (const key of ["settlement", "escalated"]) {
      expect(stages().find((s) => s.key === key)!.count.kind).not.toBe("real");
      expect(stages().find((s) => s.key === key)!.tone).toBe("unknown");
    }
  });
});
