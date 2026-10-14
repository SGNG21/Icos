import { describe, expect, it } from "vitest";

import { isMetaRoute, META_ROUTE_PREFIX, PROVIDER_AUTO_ROUTES } from "./meta-route";

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

  it("auto[1m] is still bare automatic routing once the extended-context marker is peeled", () => {
    expect(isMetaRoute("auto[1m]")).toBe(true);
    expect(isMetaRoute("auto/best-free[1m]")).toBe(true);
  });
});

describe("isMetaRoute — provider-side automatic models (gateway registry, exact match)", () => {
  it.each([
    "openrouter/auto",
    "openrouter/free",
    "openrouter/openrouter/auto",
    "openrouter/openrouter/free",
    "factory/auto",
    "trae/auto",
    "tr/auto",
    "tr/work",
    "dify/auto",
    "cursor/auto",
    "cu/auto",
    "charm-hyper/hyper/auto",
    "orcarouter/orcarouter/auto",
    "kilo-gateway/kilo-auto/frontier",
    "kg/kilo-auto/free",
    "kg/openrouter/free",
    "kilocode/openrouter/free",
    "cl/openrouter/free",
    "dgrid/dgridai/free",
    "bzl/auto:free",
    "pplx-web/pplx-auto",
    "adp-web/adapta-one",
  ])("%s is a meta-route (the upstream picks the model)", (id) => {
    expect(isMetaRoute(id)).toBe(true);
  });

  it.each([
    "no-think/openrouter/auto",
    "claude/openrouter/auto",
    "no-think/claude/cursor/auto",
    "openrouter/auto[1m]",
  ])("%s is a meta-route once the gateway's wrappers and markers are peeled", (id) => {
    expect(isMetaRoute(id)).toBe(true);
  });

  it.each([
    "./auto",
    "../auto",
    "src/auto",
    "/auto",
    "my-openrouter/auto",
    "openrouter/auto-x",
    "openrouter/autopilot",
    "OpenRouter/auto",
    "openrouter/Auto",
    "openrouter/auto/x",
    "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
    "nvidia/nvidia/nemotron-3-super-120b-a12b",
    "cursor/claude-sonnet-5",
    "kilo-auto/frontier",
    "trae/auto ",
  ])("%j is not a meta-route (exact match only)", (id) => {
    expect(isMetaRoute(id)).toBe(false);
  });

  it("every listed route is `<prefix>/<model>`, never a bare word or a path", () => {
    for (const route of PROVIDER_AUTO_ROUTES) {
      expect(route).toMatch(/^[a-z][a-z0-9-]*\/[^\s]+$/);
      expect(route.startsWith(".")).toBe(false);
    }
  });
});
