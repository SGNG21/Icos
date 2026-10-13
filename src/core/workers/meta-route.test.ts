import { describe, expect, it } from "vitest";

import { isMetaRoute, META_ROUTE_PREFIX } from "./meta-route";

describe("isMetaRoute — decision 0078 §3", () => {
  it("names the prefix once", () => {
    expect(META_ROUTE_PREFIX).toBe("auto/");
  });

  it.each([
    "auto/best-free",
    "auto/coding:free",
    "auto/best-chat",
    "auto/claude-sonnet-5",
    "auto/",
  ])("%s is a meta-route", (id) => {
    expect(isMetaRoute(id)).toBe(true);
  });

  it.each([
    "cc/claude-sonnet-5",
    "nvidia/nemotron-ultra",
    "claude-opus-5",
    "auto",
    "autonomous/x",
    "automatic-model",
    "x/auto/y",
    "AUTO/best-free",
    " auto/best-free",
    "",
  ])("%j is not a meta-route", (id) => {
    expect(isMetaRoute(id)).toBe(false);
  });
});
