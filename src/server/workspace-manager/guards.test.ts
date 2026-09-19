import { describe, expect, it } from "vitest";

import { assertBranchName, assertSlug, assertWorktreePath, testDatabaseName } from "./guards";

const ROOT = "/Users/coco/icos-worktrees";
const MASTER = "/Users/coco/icos";

describe("assertSlug", () => {
  it.each(["7a", "ws_004", "memory-7b"])("accepte %s", (s) =>
    expect(() => assertSlug(s)).not.toThrow(),
  );
  it.each(["", "7A", "a b", "../x", "x".repeat(33), "a;drop"])("refuse %j", (s) =>
    expect(() => assertSlug(s)).toThrow(/SLUG_INVALID/),
  );
});

describe("testDatabaseName", () => {
  it("suit la convention icos_test_<slug>", () => {
    expect(testDatabaseName("7a")).toBe("icos_test_7a");
    expect(testDatabaseName("ws_004")).toBe("icos_test_ws_004");
    expect(testDatabaseName("memory-7b")).toBe("icos_test_memory_7b");
  });
  it.each(["live1", "prod-x", "probe", "n23_probe", "products"])(
    "refuse la DB dérivée de %s",
    (s) => expect(() => testDatabaseName(s)).toThrow(/DATABASE_FORBIDDEN/),
  );
});

describe("assertWorktreePath", () => {
  it("accepte un chemin sous la racine", () => {
    expect(() => assertWorktreePath(`${ROOT}/phase-7d`, ROOT, MASTER)).not.toThrow();
  });
  it.each([
    [`${ROOT}`, "la racine elle-même"],
    [`${MASTER}`, "le dépôt maître"],
    [`${MASTER}/sub`, "sous le dépôt maître"],
    [`/tmp/x`, "hors racine"],
    [`${ROOT}/../icos`, "traversée .."],
    [`${ROOT}-evil/x`, "préfixe frère"],
    ["relative/path", "chemin relatif"],
  ])("refuse %s (%s)", (p) =>
    expect(() => assertWorktreePath(p, ROOT, MASTER)).toThrow(/PATH_FORBIDDEN/),
  );
});

describe("assertBranchName", () => {
  it.each(["ws/7a", "feat/phase-7d", "worker/x.y"])("accepte %s", (b) =>
    expect(() => assertBranchName(b)).not.toThrow(),
  );
  it.each([
    "main",
    "master",
    "HEAD",
    "integration/phase-7",
    "release/1",
    "ws/../x",
    "ws/a b",
    "-x",
    "nope",
  ])("refuse %s", (b) => expect(() => assertBranchName(b)).toThrow(/BRANCH_FORBIDDEN/));
});
