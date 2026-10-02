import { describe, expect, it } from "vitest";

import {
  MODEL_ALLOWLIST_UNRESTRICTED,
  decideModel,
  isModelAllowed,
  modelAllowlist,
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
