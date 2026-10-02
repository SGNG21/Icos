import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { missing, real } from "@/features/cockpit/truth";
import { buildMobileHome, type MobileHomeInput, type Section } from "@/features/mobile/home";
import type { ObjectiveLine } from "@/features/mobile/load";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
}));

const { MobileHome } = await import("./home");
const { ApprovalsPanel } = await import("@/components/features/approvals-panel");

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

const session = { user: { name: "Geoffrey", email: "owner@example.com" }, roles: ["owner"] };

const baseInput: MobileHomeInput = {
  generatedAt: "2026-10-02T10:05:00.000Z",
  health: { level: "healthy", reasons: [] },
  scope: "global",
  missions: real([]),
  focus: null,
  workers: real([]),
  timeline: real([]),
  alerts: [],
  approvals: real([]),
  canDecideApprovals: true,
  canDecideProposals: true,
  workforce: real({ total: 0, byStatus: {} }),
  supervisor: real([]),
  dispatchLedger: real([]),
  canConverse: true,
};

const line = (over: Partial<ObjectiveLine> = {}): ObjectiveLine => ({
  id: "g1",
  title: "Livrer le portail client",
  state: "EXECUTING",
  phase: "EXECUTION",
  missionId: "m1",
  blockedReason: null,
  humanDecisionRequired: false,
  progress: real("2/5 tâches réglées"),
  result: real("APPROVE: critères remplis"),
  cost: missing("not_available", "Aucun relevé de dépense n'existe dans ICOS.", "BR-05"),
  ...over,
});

const connected = (items: ObjectiveLine[]): Section<ObjectiveLine> => ({
  state: items.length ? "CONNECTED" : "EMPTY",
  items,
  reason: null,
  requirement: null,
});

const render = (objectives?: Section<ObjectiveLine>) =>
  html(h(MobileHome, { session, model: { ...buildMobileHome(baseInput), objectives } }));

describe("the objective read model reaches the phone", () => {
  it("states the objective, its progress and the LAST RESULT ICOS produced", () => {
    const out = render(connected([line()]));
    expect(out).toContain("Objectifs d&#x27;ICOS");
    expect(out).toContain("Livrer le portail client");
    expect(out).toContain("EXECUTING");
    expect(out).toContain("2/5 tâches réglées");
    expect(out).toContain("APPROVE: critères remplis");
  });

  it("shows COST as a labelled hole: never hidden, never a number", () => {
    const out = render(connected([line()]));
    expect(out).toContain("Coût");
    expect(out).toContain("NOT AVAILABLE");
    expect(out).toContain("Aucun relevé de dépense n&#x27;existe dans ICOS.");
    expect(out).not.toMatch(/Coût<\/span><span[^>]*>0/);
  });

  it("tells 'no objective' apart from 'cannot read the objectives'", () => {
    const empty = render(connected([]));
    expect(empty).toContain("Aucun objectif enregistré dans ICOS.");
    expect(empty).not.toContain("INCONNU");

    const unreadable = render({
      state: "UNKNOWN",
      items: [],
      reason: "Objectifs could not be read from ICOS.",
      requirement: null,
    });
    expect(unreadable).toContain("INCONNU");
    expect(unreadable).toContain("Objectifs could not be read from ICOS.");
    expect(unreadable).not.toContain("Aucun objectif enregistré dans ICOS.");
  });

  it("never passes a missing read model off as 'no objectives'", () => {
    const out = render(undefined);
    expect(out).not.toContain("Aucun objectif enregistré dans ICOS.");
    expect(out).toContain("n&#x27;a pas été fourni à cette page.");
  });

  it("marks a human decision and a blockage in words, not by colour", () => {
    const out = render(
      connected([line({ humanDecisionRequired: true, blockedReason: "revue en attente" })]),
    );
    expect(out).toContain("Décision humaine requise");
    expect(out).toContain("Blocage");
    expect(out).toContain("revue en attente");
  });
});

/**
 * A screen reader walks headings. Adding a sub-block to a section is where heading order
 * usually breaks, so the order is asserted rather than assumed.
 */
describe("heading order stays walkable", () => {
  it("never skips a level, and nests objective titles under their sub-heading", () => {
    const out = render(connected([line(), line({ id: "g2", title: "Second objectif" })]));
    const levels = [...out.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1);
    }
    expect(levels).toContain(4);
  });
});

describe("an unfillable approval queue says so", () => {
  it("renders NON CONNECTÉE instead of a calm 'nothing pending'", () => {
    const out = html(h(ApprovalsPanel, { initialActions: [], agents: [] }));
    expect(out).toContain("NON CONNECTÉE");
    expect(out).not.toContain("Aucune action en attente d’approbation.");
  });
});
