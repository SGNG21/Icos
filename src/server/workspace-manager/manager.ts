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
  /** Explicit opt-in for manual tooling outside autonomous execution. */
  manual?: boolean;
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

  /**
   * The canonical repository, and the Git port bound to it.
   *
   * Read-only, and exposed for ONE caller: the trusted finalizer, which must capture a
   * worker's tree through the same hardened authority this manager already uses rather than
   * constructing a second one. Handing out the PORT is narrower than handing out a repository
   * path a caller could then drive with its own git.
   */
  get masterRepoPath(): string {
    return this.masterRepo;
  }

  get gitPort(): Git {
    return this.git;
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
      if (input.workflowId) {
        const sameWorkflow = active.find((workspace) => workspace.workflowId === input.workflowId);
        if (sameWorkflow) {
          if (
            sameWorkflow.missionId !== (input.missionId ?? null) ||
            sameWorkflow.taskId !== (input.taskId ?? null)
          ) {
            throw new WorkspaceError(
              "WORKFLOW_COLLISION",
              `${input.workflowId} est déjà lié à ${sameWorkflow.workspaceId}`,
            );
          }
          return sameWorkflow;
        }
        const sameTask = active.find(
          (workspace) =>
            workspace.missionId === (input.missionId ?? null) &&
            workspace.taskId === (input.taskId ?? null) &&
            workspace.workflowId !== input.workflowId,
        );
        if (sameTask) {
          throw new WorkspaceError(
            "WORKFLOW_COLLISION",
            `${input.missionId ?? ""}/${input.taskId ?? ""} est déjà lié à ${sameTask.workflowId ?? "aucun workflow"}`,
          );
        }
      }
      if (!input.workflowId && !input.manual) {
        throw new WorkspaceError(
          "WORKFLOW_ID_REQUIRED",
          "canonical workflowId is required unless this is an explicitly manual workspace",
        );
      }
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
        /*
         * BOUND HERE, by the allocator, from the repository THIS manager owns — never from a
         * worker, a grant, a worktree pointer or ambient state read later. This is the only
         * moment at which the binding can be made from trusted knowledge alone.
         */
        canonicalRepo: this.masterRepo,
      };
      state.workspaces.push(workspace);
      return workspace;
    });
  }

  /** requested -> creating -> ready : DB de test dédiée puis `git worktree add <path> -b <branch> <base>`. */
  async create(
    workspaceId: string,
    actor?: string,
    expectedFencingToken?: number,
  ): Promise<Workspace> {
    const outcome = await this.registry.transaction(async (state) => {
      const ws = state.workspaces.find((workspace) => workspace.workspaceId === workspaceId);
      if (!ws) throw new WorkspaceError("NOT_FOUND", `workspace ${workspaceId}`);
      const startedAt = this.now();
      this.assertTransition(ws, "creating");
      this.assertMutationLease(ws, actor, expectedFencingToken, startedAt);
      ws.status = "creating";
      ws.updatedAt = startedAt.toISOString();

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
        const completedAt = this.now();
        this.assertMutationLease(ws, actor, expectedFencingToken, completedAt);
        this.assertTransition(ws, "ready");
        ws.status = "ready";
        ws.updatedAt = completedAt.toISOString();
        return { workspace: { ...ws } };
      } catch (error) {
        await this.provisioner.drop(ws.testDatabase).catch(() => undefined);
        const failedAt = this.now();
        try {
          this.assertMutationLease(ws, actor, expectedFencingToken, failedAt);
          this.assertTransition(ws, "blocked");
          ws.status = "blocked";
          ws.updatedAt = failedAt.toISOString();
        } catch {
          // Preserve the original failure; no unfenced fallback mutation is allowed.
        }
        return { workspace: { ...ws }, error };
      }
    });
    if ("error" in outcome) throw outcome.error;
    return outcome.workspace;
  }

  async transition(
    workspaceId: string,
    to: WorkspaceStatus,
    actor?: string,
    expectedFencingToken?: number,
  ): Promise<Workspace> {
    return this.update(workspaceId, (w, now) => {
      if (w.releasedAt) throw new WorkspaceError("WORKSPACE_RELEASED", workspaceId);
      this.assertTransition(w, to);
      this.assertMutationLease(w, actor, expectedFencingToken, now);
      w.status = to;
    });
  }

  /** Lease : un seul détenteur actif ; le détenteur peut renouveler, un autre reprend après expiration. */
  async acquireLease(workspaceId: string, owner: string, ttlMs: number): Promise<Workspace> {
    return this.update(workspaceId, (w, now) => {
      if (w.releasedAt) throw new WorkspaceError("WORKSPACE_RELEASED", workspaceId);
      const held = w.leaseOwner && w.leaseExpiresAt && Date.parse(w.leaseExpiresAt) > now.getTime();
      if (held) {
        throw new WorkspaceError(
          "LEASE_HELD",
          `${w.workspaceId} détenu par ${w.leaseOwner} jusqu'à ${w.leaseExpiresAt}`,
        );
      }
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
    expectedFencingToken: number,
  ): Promise<Workspace> {
    return this.update(workspaceId, (w, now) => {
      if (w.releasedAt) throw new WorkspaceError("WORKSPACE_RELEASED", workspaceId);
      this.assertMutationLease(w, owner, expectedFencingToken, now);
      w.leaseOwner = null;
      w.leaseExpiresAt = null;
    });
  }

  /** Enregistre le commit source soumis à l'Integration Gate (traçabilité intégration -> commit). */
  async recordSourceCommit(
    workspaceId: string,
    commit: string,
    owner: string,
    expectedFencingToken: number,
  ): Promise<Workspace> {
    return this.update(workspaceId, (w, now) => {
      this.assertMutationLease(w, owner, expectedFencingToken, now);
      w.sourceCommit = commit;
    });
  }

  async assertLease(
    workspaceId: string,
    owner: string,
    expectedFencingToken: number,
  ): Promise<Workspace> {
    return this.withLease(workspaceId, owner, expectedFencingToken, async (workspace) => workspace);
  }

  async withLease<T>(
    workspaceId: string,
    owner: string,
    expectedFencingToken: number,
    fn: (workspace: Workspace) => Promise<T>,
  ): Promise<T> {
    return this.registry.transaction(async (state) => {
      const workspace = state.workspaces.find((candidate) => candidate.workspaceId === workspaceId);
      if (!workspace) throw new WorkspaceError("NOT_FOUND", `workspace ${workspaceId}`);
      this.assertMutationLease(workspace, owner, expectedFencingToken, this.now());
      return fn({ ...workspace });
    });
  }

  /**
   * Cleanup après acceptation/rejet/abandon. Ne supprime JAMAIS du travail non commité, n'utilise
   * jamais --force, et conserve la branche si elle n'est pas fusionnée (`branch -d`).
   */
  async cleanup(
    workspaceId: string,
    owner?: string,
    expectedFencingToken?: number,
  ): Promise<CleanupResult> {
    return this.registry.transaction(async (state) => {
      const ws = state.workspaces.find((workspace) => workspace.workspaceId === workspaceId);
      if (!ws) throw new WorkspaceError("NOT_FOUND", `workspace ${workspaceId}`);
      const now = this.now();
      this.assertMutationLease(ws, owner, expectedFencingToken, now);
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
      /*
       * PRÉSERVER AVANT DE DÉTRUIRE — le commit du worker vit sur un HEAD DÉTACHÉ.
       *
       * Un writer est alloué détaché (voir `Git.addWorktree`) : son commit n'est porté par
       * aucune référence tant que le coordinateur ne l'a pas nommé. Sur le chemin ABANDONNÉ
       * personne ne le nomme — le runner est mort, c'est précisément pourquoi on reape — donc
       * la branche était restée sur la base, le reap la jugeait « fusionnée » et la
       * supprimait : le travail devenait inatteignable. « Conserver, jamais détruire » doit
       * tenir ici, au PAS IRRÉVERSIBLE, et pas seulement sur le chemin heureux.
       *
       * Avance uniquement en FAST-FORWARD (`tip` ancêtre de `head`) : on rend le travail
       * atteignable, on ne réécrit jamais une branche qui aurait déjà bougé ailleurs.
       */
      if (hasWorktree) {
        const head = await this.git.headCommit(ws.worktreePath).catch(() => null);
        const tip = await this.git.resolveCommit(ws.branch).catch(() => null);
        if (head && tip && head !== tip && (await this.git.isAncestor(tip, head).catch(() => false))) {
          await this.git.setBranchToCommit(ws.branch, head, tip);
        }
      }

      await mkdir(this.archiveDir, { recursive: true });
      const archivePath = path.join(this.archiveDir, `${ws.workspaceId}.json`);
      await writeFile(archivePath, JSON.stringify(ws, null, 2));

      /*
       * A WORKTREE THAT WILL NOT UNREGISTER MUST NOT STRAND THE RELEASE.
       *
       * `git worktree remove` fails for reasons that are not this workspace's problem — a
       * directory already gone, a stale registration another run left in
       * `.git/worktrees`. It used to "succeed" regardless, because this adapter's `exec`
       * dropped every exit code; now that it honours them, a failure here would abort
       * cleanup and leave the workspace, its branch and its test database behind for ever.
       *
       * Nothing is risked by continuing: the UNCOMMITTED_CHANGES check above is what
       * protects real work, and it has already passed. So the removal is attempted, a
       * `prune` clears a stale registration, and the result reports what actually
       * happened instead of asserting success.
       */
      let worktreeRemoved = false;
      if (hasWorktree) {
        try {
          await this.git.removeWorktree(ws.worktreePath);
          worktreeRemoved = true;
        } catch {
          await this.git.exec(["worktree", "prune"], undefined, [0, 1, 128]).catch(() => undefined);
          worktreeRemoved = !existsSync(ws.worktreePath);
        }
      }
      /*
       * Reap against the INTEGRATION TARGET, not HEAD (M8, defect 19). `branch -d` asks
       * whether the branch is merged into HEAD, which for a worker branch integrated into
       * `integrationTarget` is the wrong question — it answered "not merged" and kept every
       * branch forever.
       */
      const branchDeleted = await this.git.deleteBranchMergedInto(ws.branch, ws.integrationTarget);
      await this.provisioner.drop(ws.testDatabase);
      ws.releasedAt = now.toISOString();
      ws.leaseOwner = null;
      ws.leaseExpiresAt = null;
      ws.updatedAt = now.toISOString();
      return {
        worktreeRemoved,
        branchDeleted,
        databaseDropped: true,
        archivePath,
      };
    });
  }

  private assertMutationLease(
    w: Workspace,
    actor: string | undefined,
    expectedFencingToken: number | undefined,
    now: Date,
  ): void {
    if (!w.leaseOwner && !w.leaseExpiresAt && w.fencingToken === 0 && !w.workflowId) return;
    if (!actor || expectedFencingToken === undefined) {
      throw new WorkspaceError(
        "FENCING_EVIDENCE_REQUIRED",
        `${w.workspaceId} requiert owner + fencing token`,
      );
    }
    if (w.leaseOwner !== actor) {
      throw new WorkspaceError("LEASE_NOT_OWNER", `${w.workspaceId} non détenu par ${actor}`);
    }
    if (w.fencingToken !== expectedFencingToken) {
      throw new WorkspaceError(
        "STALE_FENCE",
        `Fencing token mismatch: expected ${expectedFencingToken}, got ${w.fencingToken}`,
      );
    }
    const leaseExpiry = w.leaseExpiresAt ? Date.parse(w.leaseExpiresAt) : 0;
    if (leaseExpiry <= now.getTime()) {
      throw new WorkspaceError("LEASE_EXPIRED", "Lease expired, autonomous mutation refused");
    }
  }

  private assertTransition(workspace: Workspace, to: WorkspaceStatus): void {
    if (workspace.releasedAt) {
      throw new WorkspaceError("WORKSPACE_RELEASED", workspace.workspaceId);
    }
    if (!WORKSPACE_TRANSITIONS[workspace.status].includes(to)) {
      throw new WorkspaceError("TRANSITION_FORBIDDEN", `${workspace.status} -> ${to}`);
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
