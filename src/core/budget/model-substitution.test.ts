import { describe, expect, it } from "vitest";

import { compareServedModel } from "./model-substitution";

describe("compareServedModel — the served model against the requested one", () => {
  it.each([
    ["nvidia/nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3-super-120b-a12b"],
    ["nvidia/nvidia/nemotron-3-super-120b-a12b", "nvidia/nvidia/nemotron-3-super-120b-a12b"],
    ["cc/claude-sonnet-5", "claude-sonnet-5"],
    ["no-think/cc/claude-sonnet-5", "claude-sonnet-5"],
    ["cc/claude-sonnet-5[1m]", "claude-sonnet-5"],
    ["claude-opus-5", "claude-opus-5"],
  ])("%s served as %s is the same model (gateway prefix only)", (requested, served) => {
    expect(compareServedModel(requested, served)).toEqual({ kind: "SAME" });
  });

  it.each([
    /* A concrete-looking id an operator combo or mapping redirects. */
    ["nvidia/nvidia/nemotron-3-super-120b-a12b", "claude-opus-5"],
    ["cc/claude-haiku-4-5", "claude-opus-5"],
    ["nvidia/nvidia/nemotron-3-super-120b-a12b", "nemotron-3-super-120b-a12b-v2"],
    /* A suffix match must be a whole path segment. */
    ["nvidia/my-claude-opus-5", "claude-opus-5"],
  ])("%s served as %s is a substitution", (requested, served) => {
    expect(compareServedModel(requested, served)).toEqual({ kind: "DIFFERENT_MODEL" });
  });

  it.each([
    ["auto/best-free", "claude-opus-5"],
    ["auto/claude-opus-5", "claude-opus-5"],
    ["openrouter/auto", "openrouter/auto"],
  ])("a requested meta-route %s never matches what it served (%s)", (requested, served) => {
    expect(compareServedModel(requested, served)).toEqual({ kind: "META_ROUTE_REQUESTED" });
  });
});
