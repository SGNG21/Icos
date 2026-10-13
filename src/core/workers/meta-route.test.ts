import { describe, expect, it } from "vitest";

import { isMetaRoute, META_ROUTE_PREFIX } from "./meta-route";

describe("isMetaRoute — decision 0078 §3", () => {
  it("names the prefix once", () => {
    expect(META_ROUTE_PREFIX).toBe("auto/");
  });

  it.each([
    "auto",
    "auto/",
    "auto/best-free",
    "auto/coding:free",
    "auto/best-chat",
    "auto/claude-sonnet-5",
  ])("%s is a meta-route (bare automatic routing or an auto/* combo)", (id) => {
    expect(isMetaRoute(id)).toBe(true);
  });

  it.each([
    "no-think/auto",
    "no-think/auto/best-free",
    "no-think/no-think/auto/best-free",
    "claude/auto/best-free",
    "no-think/claude/auto/best-free",
    "claude/no-think/auto/coding:free",
    "claude/combo/anything",
    "no-think/claude/combo/my-team-combo",
  ])("%s is a meta-route once the gateway's wrappers are peeled", (id) => {
    expect(isMetaRoute(id)).toBe(true);
  });

  it.each([
    "cc/claude-sonnet-5",
    "claude/claude-sonnet-5",
    "no-think/cc/claude-sonnet-5",
    "nvidia/nemotron-ultra",
    "claude-opus-5",
    "autonomous/x",
    "automatic-model",
    "auto-model",
    "x/auto/y",
    "openrouter/auto",
    "combo/x",
    "AUTO/best-free",
    "Auto",
    " auto/best-free",
    "no-think/",
    "claude/",
    "",
  ])("%j is not a meta-route", (id) => {
    expect(isMetaRoute(id)).toBe(false);
  });
});
