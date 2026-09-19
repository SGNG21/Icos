import path from "node:path";

import { WorkspaceError } from "./types";

export const DEFAULT_MASTER_REPO = "/Users/coco/icos";
export const DEFAULT_WORKTREE_ROOT = "/Users/coco/icos-worktrees";

const SLUG = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Même jeton que `test-database-guard` : jamais une base live/probe/prod. */
const LIVE_TOKEN = /(probe|live|prod)/i;
const WORKER_DB = /^icos_test_[a-z0-9_]{1,32}$/;
const BRANCH = /^(ws|feat|fix|worker)\/[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/i;
const PROTECTED_BRANCH = /^(main|master|head|integration\/.*|release\/.*)$/i;

export function assertSlug(slug: string): void {
  if (!SLUG.test(slug)) {
    throw new WorkspaceError("SLUG_INVALID", `slug "${slug}" doit correspondre à ${SLUG}`);
  }
}

/** Refuse toute base pouvant être la live ; sert aussi de garde avant CREATE/DROP. */
export function assertWorkerDatabaseName(name: string): void {
  if (!WORKER_DB.test(name) || LIVE_TOKEN.test(name)) {
    throw new WorkspaceError(
      "DATABASE_FORBIDDEN",
      `la base "${name}" n'est pas une base worker valide (icos_test_<slug>, sans probe/live/prod)`,
    );
  }
}

/** `icos_test_<slug>` (tirets -> underscores). Une DB = un workspace. */
export function testDatabaseName(slug: string): string {
  assertSlug(slug);
  const name = `icos_test_${slug.replace(/-/g, "_")}`;
  assertWorkerDatabaseName(name);
  return name;
}

export function assertWorktreePath(worktreePath: string, root: string, masterRepo: string): void {
  const fail = (why: string) => {
    throw new WorkspaceError("PATH_FORBIDDEN", `${worktreePath}: ${why}`);
  };
  if (!path.isAbsolute(worktreePath)) fail("chemin absolu requis");
  if (path.resolve(worktreePath) !== worktreePath) fail("chemin non normalisé (.., //, / final)");
  if (!worktreePath.startsWith(root + path.sep)) fail(`doit être strictement sous ${root}`);
  if (worktreePath === masterRepo || worktreePath.startsWith(masterRepo + path.sep)) {
    fail("le dépôt maître est intouchable");
  }
}

export function assertBranchName(branch: string): void {
  if (PROTECTED_BRANCH.test(branch) || branch.includes("..") || !BRANCH.test(branch)) {
    throw new WorkspaceError(
      "BRANCH_FORBIDDEN",
      `branche "${branch}" refusée (attendu ws|feat|fix|worker/<nom>, jamais main/integration/release)`,
    );
  }
}

/** La cible d'intégration est une branche de staging, jamais main. */
export function assertIntegrationTarget(branch: string): void {
  if (!/^integration\/[a-z0-9][a-z0-9._-]*$/i.test(branch)) {
    throw new WorkspaceError(
      "TARGET_FORBIDDEN",
      `cible "${branch}" refusée (attendu integration/<nom>)`,
    );
  }
}
