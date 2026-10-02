import { describe, expect, it } from "vitest";

import { buildPipeline } from "./pipeline";
import { real } from "./truth";

const NOW = new Date("2026-10-02T12:00:00Z");

const stages = () =>
  buildPipeline({
    now: NOW,
    attempts: real([]),
    qualityJobs: real([]),
    escalatedJobs: real(0),
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

  /*
   * L'escalade N'EST PLUS une lacune : `escalatedJobs` est désormais une source à part entière
   * (port `listEscalated` -> loader cockpit). Cette assertion a été inversée volontairement : la
   * version précédente affirmait que le cockpit ne pouvait pas la lire, ce qui serait maintenant
   * la lie que ce fichier existe pour empêcher.
   */
  it("reads escalations from a real source instead of declaring them unreadable", () => {
    const count = stages().find((s) => s.key === "escalated")!.count;
    expect(count.kind).toBe("real");
  });

  it("keeps settlement an explicit gap rather than zero", () => {
    expect(stages().find((s) => s.key === "settlement")!.count.kind).not.toBe("real");
    expect(stages().find((s) => s.key === "settlement")!.tone).toBe("unknown");
  });
});
