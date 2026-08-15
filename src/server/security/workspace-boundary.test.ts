import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  WorkspaceBoundaryError,
  resolveAuthorizedWorkspace,
  resolveInsideWorkspace,
} from "./workspace-boundary";

describe("resolveAuthorizedWorkspace — fail-closed (F4)", () => {
  let base: string;
  let repoRoot: string;
  let worktree: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "icos-boundary-test-"));
    repoRoot = path.join(base, "repo");
    worktree = path.join(base, "worktree");
    await mkdir(repoRoot);
    await mkdir(worktree);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("resolves a valid assigned worktree to its canonical path", async () => {
    const resolved = await resolveAuthorizedWorkspace(worktree, [repoRoot]);
    expect(resolved).toBeTruthy();
    expect(path.isAbsolute(resolved)).toBe(true);
  });

  it("rejects an empty worktree path (no repo-root fallback)", async () => {
    await expect(resolveAuthorizedWorkspace("", [repoRoot])).rejects.toThrow(
      WorkspaceBoundaryError,
    );
    await expect(resolveAuthorizedWorkspace("", [repoRoot])).rejects.toMatchObject({
      code: "empty_worktree_path",
    });
  });

  it("rejects undefined and null worktree paths", async () => {
    await expect(resolveAuthorizedWorkspace(undefined, [])).rejects.toMatchObject({
      code: "empty_worktree_path",
    });
    await expect(resolveAuthorizedWorkspace(null, [])).rejects.toMatchObject({
      code: "empty_worktree_path",
    });
  });

  it("rejects a whitespace-only worktree path", async () => {
    await expect(resolveAuthorizedWorkspace("   ", [])).rejects.toMatchObject({
      code: "empty_worktree_path",
    });
  });

  it("rejects a relative worktree path", async () => {
    await expect(resolveAuthorizedWorkspace("relative/worktree", [])).rejects.toMatchObject({
      code: "relative_worktree_path",
    });
  });

  it("rejects a nonexistent worktree path", async () => {
    await expect(resolveAuthorizedWorkspace(path.join(base, "absent"), [])).rejects.toMatchObject({
      code: "unresolvable_worktree_path",
    });
  });

  it("rejects a file (not a directory)", async () => {
    const file = path.join(base, "file.txt");
    await writeFile(file, "x", "utf-8");
    await expect(resolveAuthorizedWorkspace(file, [])).rejects.toMatchObject({
      code: "not_a_directory",
    });
  });

  it("rejects the forbidden repo root itself (escape blocked)", async () => {
    await expect(resolveAuthorizedWorkspace(repoRoot, [repoRoot])).rejects.toMatchObject({
      code: "forbidden_root",
    });
  });

  it("rejects a path resolving to the repo root through indirection (..)", async () => {
    const indirect = path.join(worktree, "..", "repo");
    await expect(resolveAuthorizedWorkspace(indirect, [repoRoot])).rejects.toMatchObject({
      code: "forbidden_root",
    });
  });

  it("ignores unresolvable forbidden roots without weakening validation", async () => {
    const resolved = await resolveAuthorizedWorkspace(worktree, [
      path.join(base, "nonexistent-root"),
      repoRoot,
    ]);
    expect(resolved).toBeTruthy();
    // La racine interdite réelle reste appliquée :
    await expect(
      resolveAuthorizedWorkspace(repoRoot, [path.join(base, "nonexistent-root"), repoRoot]),
    ).rejects.toMatchObject({ code: "forbidden_root" });
  });
});

describe("resolveInsideWorkspace — path-boundary (F4)", () => {
  const WS = "/tmp/icos-ws";

  it("resolves a normal relative file inside the workspace", () => {
    expect(resolveInsideWorkspace(WS, "src/core/mission/lifecycle.test.ts")).toBe(
      path.join(WS, "src/core/mission/lifecycle.test.ts"),
    );
  });

  it("rejects parent-directory traversal", () => {
    expect(() => resolveInsideWorkspace(WS, "../outside.ts")).toThrow(WorkspaceBoundaryError);
    expect(() => resolveInsideWorkspace(WS, "src/../../outside.ts")).toThrow(
      WorkspaceBoundaryError,
    );
  });

  it("rejects absolute paths", () => {
    expect(() => resolveInsideWorkspace(WS, "/etc/passwd")).toThrow(WorkspaceBoundaryError);
  });

  it("rejects the workspace root itself (a file must be strictly inside)", () => {
    expect(() => resolveInsideWorkspace(WS, ".")).toThrow(WorkspaceBoundaryError);
  });

  it("rejects a sibling directory sharing the workspace prefix", () => {
    expect(() => resolveInsideWorkspace(WS, "../icos-ws-evil/file.ts")).toThrow(
      WorkspaceBoundaryError,
    );
  });
});
