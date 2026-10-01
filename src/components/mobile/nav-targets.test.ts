import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { NAV_HREF, type NavKey } from "./mobile-nav";

/**
 * REGRESSION — real Android, 2026-10-01. Tapping Missions, Alerts or Profile left
 * the app: the hrefs were derived as `/${item.key}`, so they pointed at /missions,
 * /alerts and /profile, which have NO page. The phone got a 404, and any page that
 * did render showed a 401 from its own protected API fetch — which looked like an
 * auth regression but was not: auth was correct, the destinations did not exist.
 *
 * A dead tab is invisible in a unit suite and obvious on a phone, so this asserts
 * the one thing that was actually wrong: every destination resolves to a real page.
 */

/** App Router: a route is served when a `page.tsx` sits at its path. */
function pageFileFor(href: string): string {
  const segments = href.split("/").filter(Boolean);
  return ["src/app", ...segments, "page.tsx"].join("/");
}

describe("mobile navigation targets", () => {
  it("every tab points at a route that has a page", () => {
    const missing: string[] = [];
    for (const [key, href] of Object.entries(NAV_HREF)) {
      if (!existsSync(pageFileFor(href))) missing.push(`${key} -> ${href} (${pageFileFor(href)})`);
    }
    expect(missing).toEqual([]);
  });

  it("covers all five tabs, with no empty or relative href", () => {
    const keys: NavKey[] = ["home", "missions", "voice", "alerts", "profile"];
    expect(Object.keys(NAV_HREF).sort()).toEqual([...keys].sort());
    for (const href of Object.values(NAV_HREF)) {
      expect(href.startsWith("/")).toBe(true);
      expect(href).not.toBe("");
      expect(href).not.toContain("//");
    }
  });

  /** The three routes that did not exist, named so a re-regression is unmistakable. */
  it("no tab points at the three routes that never existed", () => {
    const dead = ["/missions", "/alerts", "/profile"];
    for (const href of Object.values(NAV_HREF)) expect(dead).not.toContain(href);
    // And they are still absent, so this test keeps its meaning.
    for (const href of dead) expect(existsSync(pageFileFor(href))).toBe(false);
  });

  it("keeps /voice exactly as it is, since that path is proven on a real phone", () => {
    expect(NAV_HREF.voice).toBe("/voice");
    expect(existsSync("src/app/voice/page.tsx")).toBe(true);
  });
});
