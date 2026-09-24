import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Git } from "./git";
import {
  DEFAULT_MASTER_REPO,
  DEFAULT_WORKTREE_ROOT,
  assertBranchName,
  assertIntegrationTarget,
  assertSlug,
  assertWorktreePath,
  testDatabaseName,
} from "./guards";
import { reserveMigrations } from "./migrations";
import type { RegistryState, WorkspaceRegistry } from "./registry";
import { checkScopeClaims, normalizeScope } from "./scope";
import type { TestDatabaseProvisioner } from "./test-database";
import {
  CLEANABLE_STATUSES,
  WORKSPACE_TRANSITIONS,
  WorkspaceError,
  type FileScope,
  type Workspace,
  type WorkspaceStatus,
} from "./types";

export interface RequestWorkspaceInput {
  slug: string;
  workerId: string;
  missionId?: string;
  taskId?: string;
  /** Canonical workflow ID from durable dispatch identity. Required for autonomous execution paths. */
  workflowId?: string;
  /** Défaut : `ws/<slug>`. */
  branch?: string;
  /** Défaut : `<racine>/<slug>`. */
  worktreePath?: string;
  /** Défaut : tête de `integrationTarget`. */
  baseCommit?: string;
  /** Défaut : `integration/phase-7`. */
  integrationTarget?: string;
  fileScope: FileScope;
  /** Nombre de numéros de migration à réserver (0 = aucune). */
  migrations?: number;
}

export interface CleanupResult {
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  databaseDropped: boolean;
  archivePath: string;
}

export interface WorkspaceManagerOptions {
  git: Git;
  registry: WorkspaceRegistry;
  provisioner: TestDatabaseProvisioner;
  worktreeRoot?: string;
  masterRepo?: string;
  now?: () => Date;
}

const SYSTEM_ACTOR = "workspace-manager";

export class WorkspaceManager {
  readonly root: string;
  private readonly masterRepo: string;
  private readonly git: Git;
  private readonly registry: WorkspaceRegistry;
  private readonly provisioner: TestDatabaseProvisioner;
  private readonly now: () => Date;

  constructor(options: WorkspaceManagerOptions) {
    this.git = options.git;
    this.registry = options.registry;
    this.provisioner = options.provisioner;
    this.root = options.worktreeRoot ?? DEFAULT_WORKTREE_ROOT;
    this.masterRepo = options.masterRepo ?? DEFAULT_MASTER_REPO;
    this.now = options.now ?? (() => new Date());
  }

  get archiveDir(): string {
    return path.join(this.root, ".archive");
  }

  async list(): Promise<Workspace[]> {
    return this.registry.read();
  }

  async get(workspaceId: string): Promise<Workspace> {
    const found = (await this.registry.read()).find((w) => w.workspaceId === workspaceId);
    if (!found) throw new WorkspaceError("NOT_FOUND", `workspace ${workspaceId}`);
    return found;
  }

  /** Enregistre un workspace (aucune écriture disque/git) après vérification de tous les invariants. */
  async request(input: RequestWorkspaceInput): Promise<Workspace> {
    assertSlug(input.slug);
    const branch = input.branch ?? `ws/${input.slug}`;
    const integrationTarget = input.integrationTarget ?? "integration/phase-7";
    const worktreePath = input.worktreePath ?? path.join(this.root, input.slug);
    assertBranchName(branch);
    assertIntegrationTarget(integrationTarget);
    assertWorktreePath(worktreePath, this.root, this.masterRepo);
    const testDatabase = testDatabaseName(input.slug);
    const fileScope = normalizeScope(input.fileScope);

    if (!(await this.git.commitExists(integrationTarget))) {
      throw new WorkspaceError(
        "TARGET_MISSING",
        `${integrationTarget} n'existe pas ; créez-la explicitement : git branch ${integrationTarget} <commit>`,
      );
    }
    const baseCommit = await this.git.resolveCommit(input.baseCommit ?? integrationTarget);

    // Collisions avec l'état réel (git + disque), indépendamment du registre.
    const worktrees = await this.git.worktrees();
    if (existsSync(worktreePath) || worktrees.some((w) => w.path === worktreePath)) {
      throw new WorkspaceError("COLLISION", `chemin ${worktreePath} déjà utilisé`);
    }
    if ((await this.git.branchExists(branch)) || worktrees.some((w) => w.branch === branch)) {
      throw new WorkspaceError("COLLISION", `branche ${branch} déjà utilisée`);
    }

    const stamp = this.now().toISOString();
    return this.registry.transaction(async (state) => {
      const active = activeOf(state);
      const nested = (a: string, b: string) =>
        a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
      for (const w of active) {
        if (nested(w.worktreePath, worktreePath))
          throw new WorkspaceError(
            "COLLISION",
            `chemin ${worktreePath} déjà utilisé par ${w.workspaceId}`,
          );
        if (w.branch === branch)
          throw new WorkspaceError(
            "COLLISION",
            `branche ${branch} déjà utilisée par ${w.workspaceId}`,
          );
        if (w.testDatabase === testDatabase)
          throw new WorkspaceError(
            "COLLISION",
            `base ${testDatabase} déjà utilisée par ${w.workspaceId}`,
          );
        checkScopeClaims(fileScope, w.fileScope, w.workspaceId);
      }
      const migrationReservation = input.migrations
        ? await reserveMigrations(
            this.git,
            { baseCommit, integrationTarget },
            active,
            input.slug,
            input.migrations,
          )
        : null;
      const workspace: Workspace = {
        workspaceId: randomUUID(),
        slug: input.slug,
        workerId: input.workerId,
        missionId: input.missionId ?? null,
        taskId: input.taskId ?? null,
        status: "requested",
        branch,
        worktreePath,
        baseCommit,
        integrationTarget,
        testDatabase,
        fileScope,
        migrationReservation,
        leaseOwner: null,
        leaseExpiresAt: null,
        fencingToken: 0,
        workflowId: input.workflowId ?? null,
        createdAt: stamp,
        updatedAt: stamp,
        releasedAt: null,
        sourceCommit: null,
      };
      state.workspaces.push(workspace);
      return workspace;
    });
  }

  /** requested -> creating -> ready : DB de test dédiée puis `git worktree add <path> -b <branch> <base>`. */
  async create(workspaceId: string, actor?: string): Promise<Workspace> {
    const ws = await this.transition(workspaceId, "creating", actor);
    try {
      await mkdir(this.root, { recursive: true });
      const realRoot = await realpath(this.root);
      const realParent = await realpath(path.dirname(ws.worktreePath)).catch(() => "");
      if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
        throw new WorkspaceError(
          "PATH_FORBIDDEN",
          `${ws.worktreePath} sort de ${realRoot} (lien symbolique ?)`,
        );
      }
      await this.provisioner.create(ws.testDatabase);
      await this.git.addWorktree(ws.worktreePath, ws.branch, ws.baseCommit);
      return await this.transition(workspaceId, "ready", actor);
    } catch (error) {
      await this.provisioner.drop(ws.testDatabase).catch(() => undefined);
      await this.transition(workspaceId, "blocked", actor).catch(() => undefined);
      throw error;
    }
  }

  async transition(
    workspaceId: string,
    to: WorkspaceStatus,
    actor: string = SYSTEM_ACTOR,
    expectedFencingToken?: number,
  ): Promise<Workspace> {
    return this.update(workspaceId, (w, now) => {
      if (w.releasedAt) throw new WorkspaceError("WORKSPACE_RELEASED", workspaceId);
      if (!WORKSPACE_TRANSITIONS[w.status].includes(to)) {
        throw new WorkspaceError("TRANSITION_FORBIDDEN", `${w.status} -> ${to}`);
      }
      // Le manager (acteur système) agit au nom du détenteur de la lease ; les autres doivent la détenir.
      if (actor !== SYSTEM_ACTOR) this.assertLeaseAllows(w, actor, now);
      // Verify fencing token if provided
      if (expectedFencingToken !== undefined && w.fencingToken !== expectedFencingToken) {
        throw new WorkspaceError(
          "STALE_FENCE",
          `Fencing token mismatch: expected ${expectedFencingToken}, got ${w.fencingToken}`,
        );
      }
      // Verify lease is still valid for non-system actors
      if (actor !== SYSTEM_ACTOR && w.leaseExpiresAt) {
        const leaseExpiry = Date.parse(w.leaseExpiresAt);
        if (leaseExpiry <= now.getTime()) {
          throw new WorkspaceError("LEASE_EXPIRED", `Lease expired, cannot transition`);
        }
      }
      w.status = to;
    });
  }

  /** Lease : un seul détenteur actif ; le détenteur peut renouveler, un autre reprend après expiration. */
  async acquireLease(workspaceId: string, owner: string, ttlMs: number): Promise<Workspace> {
    return this.update(workspaceId, (w, now) => {
      if (w.releasedAt) throw new WorkspaceError("WORKSPACE_RELEASED", workspaceId);
      this.assertLeaseAllows(w, owner, now);
      w.leaseOwner = owner;
      w.leaseExpiresAt = new Date(now.getTime() + ttlMs).toISOString();
      w.fencingToken = (w.fencingToken ?? 0) + 1;
    });
  }

  /** Renew an existing lease without incrementing the fencing token.
   * Only extends expiry; ownership and fencing token must match exactly. */
  async renewLease(
    workspaceId: string,
    owner: string,
    expectedFencingToken: number,
    ttlMs: number,
  ): Promise<Workspace> {
    return this.update(workspaceId, (w, now) => {
      if (w.releasedAt) throw new WorkspaceError("WORKSPACE_RELEASED", workspaceId);
      if (w.leaseOwner !== owner) {
        throw new WorkspaceError("LEASE_NOT_OWNER", `${workspaceId} non détenu par ${owner}`);
      }
      if (w.fencingToken !== expectedFencingToken) {
        throw new WorkspaceError(
          "STALE_FENCE",
          `Fencing token mismatch: expected ${expectedFencingToken}, got ${w.fencingToken}`,
        );
      }
      const leaseExpiry = w.leaseExpiresAt ? Date.parse(w.leaseExpiresAt) : 0;
      if (leaseExpiry <= now.getTime()) {
        throw new WorkspaceError(
          "LEASE_EXPIRED",
          `Lease expired, cannot renew; use acquireLease to reacquire`,
        );
      }
      w.leaseExpiresAt = new Date(now.getTime() + ttlMs).toISOString();
      // fencingToken is NOT incremented on renewal
    });
  }

  async releaseLease(
    workspaceId: string,
    owner: string,
    expectedFencingToken?: number,
  ): Promise<Workspace> {
    return this.update(workspaceId, (w, now) => {
      if (w.releasedAt) throw new WorkspaceError("WORKSPACE_RELEASED", workspaceId);
      if (w.leaseOwner !== owner) {
        throw new WorkspaceError("LEASE_NOT_OWNER", `${workspaceId} non détenu par ${owner}`);
      }
      if (expectedFencingToken !== undefined && w.fencingToken !== expectedFencingToken) {
        throw new WorkspaceError(
          "STALE_FENCE",
          `Fencing token mismatch: expected ${expectedFencingToken}, got ${w.fencingToken}`,
        );
      }
      w.leaseOwner = null;
      w.leaseExpiresAt = null;
    });
  }

  /** Enregistre le commit source soumis à l'Integration Gate (traçabilité intégration -> commit). */
  async recordSourceCommit(workspaceId: string, commit: string): Promise<Workspace> {
    return this.update(workspaceId, (w) => void (w.sourceCommit = commit));
  }

  /**
   * Cleanup après acceptation/rejet/abandon. Ne supprime JAMAIS du travail non commité, n'utilise
   * jamais --force, et conserve la branche si elle n'est pas fusionnée (`branch -d`).
   */
  async cleanup(workspaceId: string): Promise<CleanupResult> {
    const ws = await this.get(workspaceId);
    if (ws.releasedAt) throw new WorkspaceError("CLEANUP_REFUSED", "workspace déjà libéré");
    if (!CLEANABLE_STATUSES.includes(ws.status)) {
      throw new WorkspaceError(
        "CLEANUP_REFUSED",
        `statut ${ws.status} non terminal (accepted|rejected|abandoned requis)`,
      );
    }
    const hasWorktree = existsSync(ws.worktreePath);
    if (hasWorktree) {
      const dirty = await this.git.statusPorcelain(ws.worktreePath);
      if (dirty.length > 0) {
        throw new WorkspaceError(
          "UNCOMMITTED_CHANGES",
          `${ws.worktreePath}: ${dirty.length} changement(s) non commité(s)`,
        );
      }
    }
    await mkdir(this.archiveDir, { recursive: true });
    const archivePath = path.join(this.archiveDir, `${ws.workspaceId}.json`);
    await writeFile(archivePath, JSON.stringify(ws, null, 2));

    if (hasWorktree) await this.git.removeWorktree(ws.worktreePath);
    const branchDeleted = (await this.git.branchExists(ws.branch))
      ? await this.git.deleteBranchIfMerged(ws.branch)
      : false;
    await this.provisioner.drop(ws.testDatabase);
    await this.update(workspaceId, (w, now) => {
      w.releasedAt = now.toISOString();
      w.leaseOwner = null;
      w.leaseExpiresAt = null;
    });
    return { worktreeRemoved: hasWorktree, branchDeleted, databaseDropped: true, archivePath };
  }

  private assertLeaseAllows(w: Workspace, actor: string, now: Date): void {
    const held = w.leaseOwner && w.leaseExpiresAt && Date.parse(w.leaseExpiresAt) > now.getTime();
    if (held && w.leaseOwner !== actor) {
      throw new WorkspaceError(
        "LEASE_HELD",
        `${w.workspaceId} détenu par ${w.leaseOwner} jusqu'à ${w.leaseExpiresAt}`,
      );
    }
  }

  private update(workspaceId: string, fn: (w: Workspace, now: Date) => void): Promise<Workspace> {
    const now = this.now();
    return this.registry.transaction((state) => {
      const w = state.workspaces.find((x) => x.workspaceId === workspaceId);
      if (!w) throw new WorkspaceError("NOT_FOUND", `workspace ${workspaceId}`);
      fn(w, now);
      w.updatedAt = now.toISOString();
      return { ...w };
    });
  }
}

/** Workspaces qui détiennent encore des ressources (branche, chemin, DB, périmètre, migrations). */
export function activeOf(state: RegistryState): Workspace[] {
  return state.workspaces.filter((w) => w.releasedAt === null);
}
