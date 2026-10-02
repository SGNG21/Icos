import { describe, expect, it } from "vitest";

import {
  MODEL_ALLOWLIST_UNRESTRICTED,
  decideModel,
  isModelAllowed,
  modelAllowlist,
  narrowModelAllowlist,
  requestedComputePolicySchema,
  resolveModelAllowlist,
  type MissionModelAllowlist,
} from "@/core/autonomy/model-allowlist";

describe("mission model allowlist", () => {
  /*
   * Headline test. An empty allowlist is a deliberate "nothing may run",
   * not an absent restriction. A two-state selector with a permissive
   * fallback is the fail-open defect this repository has already been burned
   * by, so emptiness must deny.
   */
  it("denies EVERY model when the allowlist is empty", () => {
    const empty = modelAllowlist([]);

    expect(isModelAllowed(empty, "claude-opus-4-5")).toBe(false);
    expect(isModelAllowed(empty, "anything-at-all")).toBe(false);
    expect(decideModel(empty, { modelId: "claude-opus-4-5" })).toEqual({
      allowed: false,
      reason: "MODEL_ALLOWLIST_EMPTY",
    });
  });

  it("treats 'unrestricted' as a distinct explicit state, never as empty", () => {
    expect(MODEL_ALLOWLIST_UNRESTRICTED.mode).toBe("unrestricted");
    expect(modelAllowlist([]).mode).toBe("allowlist");

    expect(isModelAllowed(MODEL_ALLOWLIST_UNRESTRICTED, "claude-opus-4-5")).toBe(true);
    expect(decideModel(MODEL_ALLOWLIST_UNRESTRICTED, { modelId: "whatever" })).toEqual({
      allowed: true,
      reason: "MODEL_ALLOWLIST_UNRESTRICTED",
    });
  });

  /*
   * Absence is converted to the explicit unrestricted state at ONE named
   * boundary. The decision function itself never fails open.
   */
  it("converts an absent restriction to the explicit unrestricted state only via resolveModelAllowlist", () => {
    expect(resolveModelAllowlist(undefined)).toBe(MODEL_ALLOWLIST_UNRESTRICTED);
    expect(resolveModelAllowlist(null)).toBe(MODEL_ALLOWLIST_UNRESTRICTED);

    const restricted = modelAllowlist(["claude-haiku-4-5"]);
    expect(resolveModelAllowlist(restricted)).toBe(restricted);
  });

  it("denies when the allowlist value itself is missing or malformed", () => {
    for (const broken of [undefined, null, {}, { mode: "whatever" }, "unrestricted"]) {
      expect(decideModel(broken as unknown as MissionModelAllowlist, { modelId: "m" })).toEqual({
        allowed: false,
        reason: "MODEL_ALLOWLIST_MISSING",
      });
    }
  });

  it("permits exactly the listed model ids", () => {
    const allowlist = modelAllowlist(["claude-haiku-4-5", "claude-sonnet-4-5"]);

    expect(isModelAllowed(allowlist, "claude-haiku-4-5")).toBe(true);
    expect(isModelAllowed(allowlist, "claude-sonnet-4-5")).toBe(true);
    expect(isModelAllowed(allowlist, "claude-opus-4-5")).toBe(false);
    expect(decideModel(allowlist, { modelId: "claude-opus-4-5" })).toEqual({
      allowed: false,
      reason: "MODEL_NOT_IN_ALLOWLIST",
    });
  });

  it("compares model ids exactly: a near-miss is refused, never normalised", () => {
    const allowlist = modelAllowlist(["claude-haiku-4-5"]);

    for (const nearMiss of [
      "Claude-Haiku-4-5",
      "CLAUDE-HAIKU-4-5",
      "claude-haiku-4.5",
      "claude-haiku-4-5 ",
      " claude-haiku-4-5",
      "claude-haiku",
      "claude-haiku-4-5-20260101",
      "anthropic/claude-haiku-4-5",
    ]) {
      expect(isModelAllowed(allowlist, nearMiss)).toBe(false);
    }
  });

  it("refuses a blank or non-string model id", () => {
    const allowlist = modelAllowlist(["claude-haiku-4-5"]);

    for (const bad of ["", "   ", undefined, null, 42]) {
      expect(decideModel(allowlist, { modelId: bad as unknown as string })).toEqual({
        allowed: false,
        reason: "MODEL_ID_INVALID",
      });
    }
  });

  describe("optional provider restriction", () => {
    it("requires the provider to be listed when providers are restricted", () => {
      const allowlist = modelAllowlist(["claude-haiku-4-5"], ["anthropic"]);

      expect(
        decideModel(allowlist, { modelId: "claude-haiku-4-5", providerId: "anthropic" }),
      ).toEqual({ allowed: true, reason: "MODEL_ALLOWED" });
      expect(
        decideModel(allowlist, { modelId: "claude-haiku-4-5", providerId: "bedrock" }),
      ).toEqual({
        allowed: false,
        reason: "PROVIDER_NOT_IN_ALLOWLIST",
      });
    });

    it("fails closed when providers are restricted but no provider is supplied", () => {
      const allowlist = modelAllowlist(["claude-haiku-4-5"], ["anthropic"]);

      expect(decideModel(allowlist, { modelId: "claude-haiku-4-5" })).toEqual({
        allowed: false,
        reason: "PROVIDER_NOT_IN_ALLOWLIST",
      });
    });

    it("denies everything when the provider list is present but empty", () => {
      const allowlist = modelAllowlist(["claude-haiku-4-5"], []);

      expect(
        decideModel(allowlist, { modelId: "claude-haiku-4-5", providerId: "anthropic" }),
      ).toEqual({ allowed: false, reason: "MODEL_ALLOWLIST_EMPTY" });
    });

    it("ignores the supplied provider when providers are not restricted", () => {
      const allowlist = modelAllowlist(["claude-haiku-4-5"]);

      expect(isModelAllowed(allowlist, "claude-haiku-4-5")).toBe(true);
      expect(
        decideModel(allowlist, { modelId: "claude-haiku-4-5", providerId: "anything" }).allowed,
      ).toBe(true);
    });
  });

  it("rejects a blank or non-string entry at construction rather than storing it", () => {
    expect(() => modelAllowlist(["claude-haiku-4-5", ""])).toThrow(/MODEL_ALLOWLIST_INVALID/);
    expect(() => modelAllowlist(["claude-haiku-4-5", "  "])).toThrow(/MODEL_ALLOWLIST_INVALID/);
    expect(() => modelAllowlist([42 as unknown as string])).toThrow(/MODEL_ALLOWLIST_INVALID/);
    expect(() => modelAllowlist(["a"], ["" as string])).toThrow(/MODEL_ALLOWLIST_INVALID/);
  });

  it("does not alias duplicate entries away silently but stays decidable", () => {
    const allowlist = modelAllowlist(["claude-haiku-4-5", "claude-haiku-4-5"]);

    expect(isModelAllowed(allowlist, "claude-haiku-4-5")).toBe(true);
  });

  it("is immune to later mutation of the caller's array", () => {
    const ids = ["claude-haiku-4-5"];
    const allowlist = modelAllowlist(ids);

    ids.push("claude-opus-4-5");

    expect(isModelAllowed(allowlist, "claude-opus-4-5")).toBe(false);
  });
});

describe("narrowModelAllowlist — réduction seulement", () => {
  /*
   * HEADLINE TEST (P0-F). Une politique de goal ne peut QUE réduire. Demander un
   * modèle que le système n'autorise pas est REFUSÉ — jamais accordé, jamais en
   * silence : l'id refusé est nommé dans le rapport.
   */
  it("REFUSES a model the system does not already permit, never grants it", () => {
    const system = modelAllowlist(["claude-haiku-4-5"]);

    const narrowed = narrowModelAllowlist(system, { allowedModels: ["gpt-5-unbounded"] });

    expect(narrowed.refused).toEqual(["modelIds:gpt-5-unbounded"]);
    expect(isModelAllowed(narrowed.allowlist, "gpt-5-unbounded")).toBe(false);
    /* Et rien n'a été accordé en échange : l'intersection est vide, donc tout est refusé. */
    expect(isModelAllowed(narrowed.allowlist, "claude-haiku-4-5")).toBe(false);
  });

  it("REFUSES a provider the system does not already permit", () => {
    const system = modelAllowlist(["m1"], ["omniroute"]);

    const narrowed = narrowModelAllowlist(system, {
      allowedModels: ["m1"],
      allowedProviders: ["direct-vendor"],
    });

    expect(narrowed.refused).toEqual(["providerIds:direct-vendor"]);
    expect(isModelAllowed(narrowed.allowlist, "m1", "direct-vendor")).toBe(false);
    expect(isModelAllowed(narrowed.allowlist, "m1", "omniroute")).toBe(false);
  });

  it("keeps the subset a goal is entitled to and drops only what it is not", () => {
    const system = modelAllowlist(["cheap", "expensive"]);

    const narrowed = narrowModelAllowlist(system, { allowedModels: ["cheap", "forbidden"] });

    expect(narrowed.refused).toEqual(["modelIds:forbidden"]);
    expect(isModelAllowed(narrowed.allowlist, "cheap")).toBe(true);
    expect(isModelAllowed(narrowed.allowlist, "expensive")).toBe(false);
    expect(isModelAllowed(narrowed.allowlist, "forbidden")).toBe(false);
  });

  it("lets a goal narrow an UNRESTRICTED system set (that is still a reduction)", () => {
    const narrowed = narrowModelAllowlist(MODEL_ALLOWLIST_UNRESTRICTED, {
      allowedModels: ["cheap"],
    });

    expect(narrowed.refused).toEqual([]);
    expect(isModelAllowed(narrowed.allowlist, "cheap")).toBe(true);
    expect(isModelAllowed(narrowed.allowlist, "anything-else")).toBe(false);
  });

  it("returns the system set UNCHANGED when the goal requests nothing", () => {
    const system = modelAllowlist(["cheap"]);

    expect(narrowModelAllowlist(system, undefined)).toEqual({ allowlist: system, refused: [] });
    expect(narrowModelAllowlist(system, {})).toEqual({ allowlist: system, refused: [] });
    expect(narrowModelAllowlist(MODEL_ALLOWLIST_UNRESTRICTED, null)).toEqual({
      allowlist: MODEL_ALLOWLIST_UNRESTRICTED,
      refused: [],
    });
  });

  it("inherits the system models when the goal narrows providers only", () => {
    const system = modelAllowlist(["cheap", "expensive"], ["omniroute", "direct-vendor"]);

    const narrowed = narrowModelAllowlist(system, { allowedProviders: ["omniroute"] });

    expect(narrowed.refused).toEqual([]);
    expect(isModelAllowed(narrowed.allowlist, "cheap", "omniroute")).toBe(true);
    expect(isModelAllowed(narrowed.allowlist, "cheap", "direct-vendor")).toBe(false);
  });

  /*
   * Fermé par défaut. « Seulement ces fournisseurs » sur un système qui autorise TOUT
   * modèle n'est pas exprimable : le résultat serait soit un deny-all silencieux, soit
   * un ensemble de modèles non borné. On refuse la politique sous-spécifiée.
   */
  it("REFUSES a provider-only policy when the system restricts no model", () => {
    expect(() =>
      narrowModelAllowlist(MODEL_ALLOWLIST_UNRESTRICTED, { allowedProviders: ["omniroute"] }),
    ).toThrow(/MODEL_ALLOWLIST_INVALID/);
  });

  it("refuses an empty goal model list as deny-all rather than as 'no restriction'", () => {
    const narrowed = narrowModelAllowlist(modelAllowlist(["cheap"]), { allowedModels: [] });

    expect(narrowed.refused).toEqual([]);
    expect(narrowed.allowlist.mode).toBe("allowlist");
    expect(isModelAllowed(narrowed.allowlist, "cheap")).toBe(false);
  });

  it("refuses a malformed goal policy instead of coercing it", () => {
    expect(() =>
      narrowModelAllowlist(MODEL_ALLOWLIST_UNRESTRICTED, {
        allowedModels: ["  "],
      }),
    ).toThrow(/MODEL_ALLOWLIST_INVALID/);
  });
});

describe("requestedComputePolicySchema", () => {
  it("accepts an absent policy and both axes", () => {
    expect(requestedComputePolicySchema.safeParse({}).success).toBe(true);
    expect(
      requestedComputePolicySchema.safeParse({
        allowedModels: ["cheap"],
        allowedProviders: ["omniroute"],
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown field and a blank id", () => {
    expect(requestedComputePolicySchema.safeParse({ allowAnything: true }).success).toBe(false);
    expect(requestedComputePolicySchema.safeParse({ allowedModels: [""] }).success).toBe(false);
    expect(requestedComputePolicySchema.safeParse({ allowedModels: "cheap" }).success).toBe(false);
  });
});
