import { describe, expect, it, vi } from "vitest";

import type { HighLevelGoal, HighLevelGoalInput } from "@/core/contracts/high-level-goal";
import { DEFAULT_PRIORITY_POLICY, classifyObjective } from "@/core/supervisor/priority";

import { CanonicalGoalLauncher } from "./mission-gateway";

/**
 * INTAKE CLASSIFICATION at the canonical launch seam (lane X6).
 *
 * `CanonicalGoalLauncher.launch` is the one point where the raw text of an approved
 * proposal becomes a durable server-side goal carrying `icos.*`. These tests read the
 * metadata it builds and then run the FROZEN metadata classifier over it, so they prove the
 * whole chain text -> `icos.source` -> `WorkClass`, not just the half this lane wrote.
 */

const BASE_GOAL = {
  id: "g-1",
  constraints: [],
  successCriteria: [],
  priority: 3,
  riskLevel: "reversible",
  allowedCapabilities: [],
  forbiddenCapabilities: [],
  humanApprovalPolicy: "always",
  createdAt: "2026-10-01T00:00:00.000Z",
} as const;

const request = {
  refId: "ref-1",
  conversationId: "c-1",
  turnId: "t-1",
  approvedBy: "geoffrey",
  approval: "human" as const,
  clientId: null as string | null,
  projectId: null as string | null,
};

/** Captures what the launcher asked the normalizer for: the metadata IT decided. */
const launch = async (
  proposal: { title: string; objective: string } & Record<string, unknown>,
  overrides: Partial<typeof request> = {},
) => {
  const normalize = vi.fn(
    (input: HighLevelGoalInput): HighLevelGoal =>
      ({
        ...BASE_GOAL,
        ...input,
        /* Mirrors the real normalizer closely enough for HighLevelGoalSchema to accept it. */
        rawInput: `${input.title}: ${input.objective}`,
        normalizedIntent: input.objective.trim(),
        metadata: input.metadata ?? {},
      }) as HighLevelGoal,
  );
  const instance = new CanonicalGoalLauncher({
    goalNormalizer: { normalize } as never,
    goalPlanner: {
      plan: () => ({ goalId: "g-1", missionTitle: "t", missionObjective: "o", tasks: [] }),
    } as never,
    goalPreviewStore: { store: vi.fn(async () => undefined) } as never,
    goalRepository: { getById: vi.fn(async () => null) } as never,
    scheduler: {
      enqueue: vi.fn(async () => ({ job: { id: "j", missionId: "m" }, created: true })),
    } as never,
  });

  const result = await instance.launch(
    { constraints: [], successCriteria: [], riskLevel: "reversible", ...proposal } as never,
    { ...request, ...overrides },
  );

  const input = normalize.mock.calls[0]![0];
  const goal = normalize.mock.results[0]!.value as HighLevelGoal;
  return {
    result,
    input,
    metadata: goal.metadata,
    workClass: classifyObjective(DEFAULT_PRIORITY_POLICY, goal).class,
  };
};

describe("CanonicalGoalLauncher — server-asserted work class", () => {
  /* --- "Améliore ICOS" must actually arrive -------------------------------- */
  it.each([
    "Améliore ICOS",
    "ameliore icos",
    "AMÉLIORE ICOS",
    "Améliore ICOS pendant 2 heures",
    "Optimise ICOS",
    "Renforce ICOS",
    "Harden ICOS",
    "ICOS doit être amélioré",
  ])("classifies %j as SELF_IMPROVEMENT and asserts it on the goal", async (text) => {
    const { metadata, workClass } = await launch({ title: text, objective: text });

    expect(metadata["icos.source"]).toBe("self_development");
    expect(workClass).toBe("SELF_IMPROVEMENT");
  });

  it("reads the title too: the detail may sit in the objective", async () => {
    const { workClass } = await launch({
      title: "Améliore ICOS",
      objective: "tu as deux heures, fais ce qui te semble le plus utile",
    });
    expect(workClass).toBe("SELF_IMPROVEMENT");
  });

  /* --- UNKNOWN stays UNKNOWN ---------------------------------------------- */
  it.each([
    "Trouve-moi des prospects dans le BTP",
    "Rédige le compte rendu de la réunion de lundi",
    "Quelle est la météo",
    "Améliore la plaquette commerciale",
    "",
  ])(
    "does NOT promote %j: an unclear objective is never guessed into self-modification",
    async (text) => {
      const { metadata, workClass } = await launch({
        title: text || "sans titre",
        objective: text || "sans objet",
      });

      expect(metadata["icos.source"]).toBe("cognitive_conversation");
      expect(workClass).not.toBe("SELF_IMPROVEMENT");
    },
  );

  it("does not read a signal that spans the title/objective boundary", async () => {
    /*
     * Regression: joining title and objective with ": " made them ONE sentence to the
     * classifier, whose proximity rules only break on `. ; ! ?`. "Optimise la plaquette"
     * then sat 14 characters from "ICOS" and an unrelated request classified
     * SELF_IMPROVEMENT — the misrouting this lane exists to avoid.
     */
    const { metadata, workClass } = await launch({
      title: "Optimise la plaquette",
      objective: "ICOS doit rendre un PDF",
    });

    expect(metadata["icos.source"]).toBe("cognitive_conversation");
    expect(workClass).not.toBe("SELF_IMPROVEMENT");
  });

  it("leaves an AMBIGUOUS objective unpromoted: self and client signals both read", async () => {
    const { metadata, workClass } = await launch({
      title: "Améliore ICOS pour le client LDS",
      objective: "Améliore ICOS pour le client LDS",
    });

    expect(metadata["icos.source"]).toBe("cognitive_conversation");
    expect(workClass).not.toBe("SELF_IMPROVEMENT");
  });

  it("refuses to promote under a client scope, whatever the sentence says", async () => {
    const { metadata, workClass } = await launch(
      { title: "Améliore ICOS", objective: "Améliore ICOS" },
      { clientId: "lds" },
    );

    expect(metadata["icos.source"]).toBe("cognitive_conversation");
    expect(metadata["icos.clientId"]).toBe("lds");
    expect(workClass).not.toBe("SELF_IMPROVEMENT");
  });

  /* --- TRUST BOUNDARY ------------------------------------------------------ */
  it("ignores a work class the payload tries to assert for itself", async () => {
    /*
     * `launch` receives the stored proposal payload through a CAST, not a parse, so extra
     * keys can physically arrive here. None of them may be believed: the class is derived
     * from the text and from nothing else.
     */
    const { metadata, workClass } = await launch({
      title: "Trouve-moi des prospects",
      objective: "prospection",
      workClass: "SELF_IMPROVEMENT",
      metadata: { "icos.source": "self_development" },
      "icos.source": "self_development",
    });

    expect(metadata["icos.source"]).toBe("cognitive_conversation");
    expect(workClass).not.toBe("SELF_IMPROVEMENT");
  });

  it("ignores a payload-asserted class even when it agrees with the text", async () => {
    const { metadata } = await launch({
      title: "Améliore ICOS",
      objective: "Améliore ICOS",
      metadata: { "icos.clientId": "lds", invented: "1" },
    });

    /* Derived, not copied: no key the payload supplied survives. */
    expect(metadata["icos.source"]).toBe("self_development");
    expect(metadata["icos.clientId"]).toBeUndefined();
    expect(metadata.invented).toBeUndefined();
  });

  it("writes the class on the reserved namespace only, and nowhere a caller could aim", async () => {
    const { metadata } = await launch({ title: "Améliore ICOS", objective: "Améliore ICOS" });

    /* Unprefixed `source` is PROVENANCE (it did come from a conversation), not the class. */
    expect(metadata.source).toBe("cognitive_conversation");
    expect(Object.keys(metadata).filter((k) => k.startsWith("icos."))).toEqual(["icos.source"]);
  });

  /* --- the human gate is untouched ---------------------------------------- */
  it("still demands human approval on every launched goal", async () => {
    const { input, result } = await launch({
      title: "Améliore ICOS",
      objective: "Améliore ICOS",
    });

    expect(input.humanApprovalPolicy).toBe("always");
    expect(result).toMatchObject({ status: "launched" });
  });
});

describe("the asserted value matches the frozen priority policy", () => {
  it("still routes `icos.source: self_development` to SELF_IMPROVEMENT", () => {
    /*
     * The launcher writes the literal `self_development`. If the policy ever renames that
     * key or value, this fails LOUDLY here rather than silently misclassifying every
     * self-improvement goal as RESEARCH.
     */
    expect(
      DEFAULT_PRIORITY_POLICY.classification.find((r) => r.class === "SELF_IMPROVEMENT")?.when,
    ).toEqual({ metadataKey: "icos.source", equals: "self_development" });
  });
});
