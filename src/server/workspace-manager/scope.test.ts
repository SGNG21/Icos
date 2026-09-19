import { describe, expect, it } from "vitest";

import { checkScope, matchesAny, normalizeScope, scopesOverlap } from "./scope";

const scope = normalizeScope({
  owns: ["src/server/memory/**", "test/memory/**", "docs/memory.md"],
  shared: ["src/server/system/production-services.ts", "drizzle/meta/_journal.json"],
  forbidden: ["secrets/**"],
});

describe("matchesAny", () => {
  it("gère **, * et les chemins exacts", () => {
    expect(matchesAny("src/a/b/c.ts", ["src/**"])).toBe(true);
    expect(matchesAny("src/a.ts", ["src/*.ts"])).toBe(true);
    expect(matchesAny("src/a/b.ts", ["src/*.ts"])).toBe(false);
    expect(matchesAny("a.ts", ["**/a.ts"])).toBe(true);
    expect(matchesAny("x/y/a.ts", ["**/a.ts"])).toBe(true);
    expect(matchesAny("docs/x/y.md", ["docs/"])).toBe(true);
    expect(matchesAny("srcx/a.ts", ["src/**"])).toBe(false);
    expect(matchesAny("a.b", ["a.b"])).toBe(true);
    expect(matchesAny("axb", ["a.b"])).toBe(false);
  });
});

describe("checkScope", () => {
  it("owns : modification normale", () => {
    const r = checkScope(scope, ["src/server/memory/x.ts", "test/memory/x.test.ts"]);
    expect(r.status).toBe("PASS");
    expect(r.owned).toHaveLength(2);
  });

  it("shared : détecté et signalé", () => {
    const r = checkScope(scope, [
      "src/server/system/production-services.ts",
      "src/server/memory/x.ts",
    ]);
    expect(r.status).toBe("SHARED_CHANGED");
    expect(r.shared).toEqual(["src/server/system/production-services.ts"]);
  });

  it("forbidden : bloqué, y compris les interdits de base (.env.local)", () => {
    expect(checkScope(scope, ["secrets/a.json"]).status).toBe("FORBIDDEN");
    const r = checkScope(scope, [".env.local", "src/server/memory/x.ts"]);
    expect(r.status).toBe("FORBIDDEN");
    expect(r.forbidden).toEqual([".env.local"]);
  });

  it("forbidden l'emporte sur owns", () => {
    const s = normalizeScope({ owns: ["src/**"], shared: [], forbidden: ["src/secret.ts"] });
    expect(checkScope(s, ["src/secret.ts"]).status).toBe("FORBIDDEN");
  });

  it("hors périmètre déclaré : OUT_OF_SCOPE", () => {
    const r = checkScope(scope, ["src/server/scheduler/x.ts"]);
    expect(r.status).toBe("OUT_OF_SCOPE");
    expect(r.outOfScope).toEqual(["src/server/scheduler/x.ts"]);
  });
});

describe("scopesOverlap", () => {
  it("détecte le recouvrement de propriété", () => {
    expect(scopesOverlap(["src/server/memory/**"], ["src/server/**"])).toBe(true);
    expect(scopesOverlap(["src/server/memory/**"], ["src/server/scheduler/**"])).toBe(false);
    expect(scopesOverlap(["docs/a.md"], ["docs/a.md"])).toBe(true);
    expect(scopesOverlap(["src/server/memory/**"], ["src/server/memory-x/**"])).toBe(false);
  });
});
