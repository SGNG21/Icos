import { describe, expect, it } from "vitest";

import { safeNextPath } from "./auth-navigation";

describe("safeNextPath", () => {
  it("conserve un chemin local absolu et sa query string", () => {
    expect(safeNextPath("/tasks?status=pending")).toBe("/tasks?status=pending");
  });

  it.each([null, "", "tasks", "https://evil.test/path", "//evil.test/path", "/\\evil", "/%5cevil"])(
    "remplace une destination non locale %s par la racine",
    (candidate) => {
      expect(safeNextPath(candidate)).toBe("/");
    },
  );

  it("refuse les séparateurs ambigus même encodés plusieurs fois", () => {
    expect(safeNextPath("/%252f%252fevil.test")).toBe("/");
  });
});
