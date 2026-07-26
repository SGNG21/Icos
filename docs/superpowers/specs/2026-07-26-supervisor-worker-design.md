# SUPERVISOR / WORKER — Architecture Design

> **Date :** 2026-07-26
> **Phase :** SUP-0
> **Branch :** `feat/supervisor-worker`
> **HEAD :** `06335d6` (includes G1.0)
> **Prérequis :** D1 (Policy), D2 (Mission), D3 (AI Gateway), D4 (Runtime), G1 (Tool Gateway)

---

## 1. Design Overview

Le Supervisor est le système de coordination central d'ICOS. Il décompose une Mission D2 en un DAG
de tâches exécutables, les distribue à des Workers isolés, orchestre les revues et corrections,
intègre les résultats et prépare des livrables testables.

**Principe :** D2 reste la source de vérité de la *Mission*. Le Supervisor est le *cerveau exécutif*
qui planifie, parallélise, supervise et intègre le travail.

---

## 2. EXISTS / EXTEND / CREATE / DEFER / DISCARD

### EXISTS — Réutilisable tel quel

| Composant | Emplacement | Usage |
|-----------|------------|-------|
| D1 Policy / Authorization | `src/core/policy/` + `src/server/policy/` | Politique d'autorisation pour chaque worker |
| D2 Mission Engine | `src/core/mission/` + `src/server/mission/` | Source de vérité de la mission |
| D2 Mission Status | `CREATED` → `PLANNING` → ... `COMPLETED` | Cycle de vie mission |
| D3 AiGatewayPort | `src/server/ai/ports.ts` | Routage des requêtes AI via OmniRoute |
| D3 AiRoutingIntent | `BEST_REASONING`, `BEST_CODING`, `FAST`, `CHEAP` | Model profile pour workers |
| D4 RuntimeExecutionPort | `src/server/runtime/ports.ts` | Port d'exécution D4 |
| D4 ExecutionOrchestrator | `src/server/runtime/execution-orchestrator.ts` | Orchestrateur d'exécution |
| D4 WorkspaceManager | `src/server/runtime/workspace-manager.ts` | Isolation workspace filesystem |
| D4 LocalRuntimeAdapter | `src/server/runtime/adapters/local-runtime-adapter.ts` | Exécution sous-processus |
| D4 ArtifactCollector | `src/server/runtime/artifact-collector.ts` | Collecte d'artefacts |
| G1 ExecutionGrant | `src/core/g1/contract.ts` | Autorisation d'exécution outil |
| G1 Idempotency | `src/core/g1/idempotency.ts` | Idempotence des invocations |
| G1 Service | `src/server/g1/g1-service.ts` | Cycle de vie grant/idempotence |
| UoW (InMemory + Postgres) | `src/server/uow/` | Atomicité transactionnelle |
| Audit | `src/server/audit/` | Audit trail |
| Container | `src/server/container.ts` | DI wiring |
| Core contracts | `src/core/contracts/` | Agent, Task, Action, Approval, common |

### EXTEND — Étendre un existant

| Composant | Extension | Raison |
|-----------|-----------|--------|
| `src/core/contracts/task.ts` | → Task DAG complet (dependencies, status enrichi, retryPolicy, budget) | Le modèle "task" actuel est une coquille vide |
| Container | Ajouter SupervisorPort, WorkerManagerPort | Wiring des nouvelles dépendances |
| Mission lifecycle | Supervisor s'abonne aux missions PLANNED | Intégration D2 → Supervisor |

### CREATE — Nouveau code

| Module | Composant | Description |
|--------|-----------|-------------|
| `src/core/supervisor/contract.ts` | TaskDag, TaskNode, SchedulerState | Contrats DAG et état du scheduler |
| `src/core/supervisor/lifecycle.ts` | Task dag lifecycle | Transitions d'état DAG, cycle rejection, ready-node |
| `src/core/supervisor/scheduler.ts` | Scheduler | Ready-node, dependency completion, failure propagation |
| `src/server/supervisor/ports.ts` | SupervisorPort, SchedulerPort | Ports pour le Supervisor et Scheduler |
| `src/server/supervisor/supervisor-service.ts` | SupervisorService | Orchestrateur central |
| `src/server/supervisor/scheduler-service.ts` | SchedulerService | Implémentation Scheduler |
| `src/server/supervisor/persistence.ts` | SupervisorRepository | Persistance DAG + état |
| `src/server/supervisor/in-memory/` | InMemorySupervisorRepository, -UoW | Tests |
| `src/core/worker/contract.ts` | WorkerSpec, WorkerResult | Contrats worker |
| `src/core/worker/lifecycle.ts` | Worker lifecycle | Transitions d'état worker |
| `src/server/worker/ports.ts` | WorkerManagerPort | Port gestionnaire de workers |
| `src/server/worker/worker-manager.ts` | WorkerManager | Spawn, status, timeout, cancel |
| `src/server/worker/worker-executor.ts` | WorkerExecutor | Exécution Worker via D4 |
| `src/core/worktree/contract.ts` | WorktreeSpec, WorktreeState | Contrats worktree |
| `src/server/worktree/ports.ts` | WorktreeManagerPort | Port gestionnaire de worktrees |
| `src/server/worktree/worktree-manager.ts` | WorktreeManager | Git worktree creation/cleanup |
| `src/core/review/contract.ts` | ReviewSpec, ReviewResult | Contrats review |
| `src/server/review/ports.ts` | ReviewerPort | Port reviewer |
| `src/server/review/reviewer-worker.ts` | ReviewerWorker | Worker de revue |
| `src/server/review/correction-loop.ts` | CorrectionLoop | Boucle correction |
| `src/core/integration/contract.ts` | IntegrationSpec, IntegrationResult | Contrats intégration |
| `src/server/integration/ports.ts` | IntegrationPort | Port intégration |
| `src/server/integration/integration-orchestrator.ts` | IntegrationOrchestrator | Ordonnancement commits |
| `src/server/integration/global-gates.ts` | GlobalGates | Lint, typecheck, test, build |
| `src/server/preview/ports.ts` | PreviewPort | Port preview (V1: stub) |

### DEFER — Reporté après V1

| Fonctionnalité | Justification |
|----------------|---------------|
| Preview deployment (Vercel) | Nécessite credentials externes, REQUIRE_APPROVAL |
| Remote/MCP worker | V1 local only |
| Budget tracking avancé | Modèle simple suffit pour V1 |
| Tiered quality routing | ModelProfile via D3 suffit |
| Plan auto-optimization | Scheduler V1 = ready-node + fail-propagation |
| Skill auto-discovery | Nécessite MCP infrastructure avancée |
| Multi-cluster workers | V1 = single Supervisor host |
| Live worker streaming | Résultat collecté en fin d'exécution |

### DISCARD — Ne pas reproduire

| Concept | Raison |
|---------|--------|
| D2 dans le Supervisor | D2 reste source de vérité Mission. Supervisor est client de D2. |
| Proprietary agent runtime | Utiliser D4/ExecutionOrchestrator existant |
| Proprietary model routing | Utiliser D3/OmniRoute existant |
| Proprietary auth/policy | Utiliser D1 existant |
| Proprietary idempotency | Utiliser G1 existant |
| Custom audit system | Utiliser AuditRepository existant |

---

## 3. Architecture & Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│                        SUPERVISOR                                │
│                                                                  │
│  ┌──────────┐   ┌───────────┐   ┌──────────────┐               │
│  │ Scheduler │──▶│ Worker    │──▶│ Reviewer     │               │
│  │ (DAG)     │   │ Manager   │   │ Manager      │               │
│  └──────────┘   └───────────┘   └──────────────┘               │
│                        │                  │                      │
│  ┌─────────────────────┼──────────────────┼──────────────────┐  │
│  │      Worktree       │                  │                  │  │
│  │      Manager        │                  │                  │  │
│  └─────────────────────┴──────────────────┴──────────────────┘  │
│                                                                  │
│  ┌──────────────┐   ┌───────────────┐                           │
│  │ Integration  │──▶│ Global Gates  │                           │
│  │ Orchestrator │   │ (lint/type/   │                           │
│  └──────────────┘   │  test/build)  │                           │
│                     └───────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
         │              │           │              │
         ▼              ▼           ▼              ▼
    ┌──────┐     ┌──────────┐  ┌──────┐    ┌──────────┐
    │  D1  │     │ D3/Omni  │  │  D4  │    │  G1      │
    │Policy│     │ Route    │  │Exec  │    │Tool Gate │
    └──────┘     └──────────┘  └──────┘    └──────────┘
```

### 3.1 Relations entre composants

| Contexte | Relation |
|----------|----------|
| Supervisor → D2 | Lit Mission, Plan, Steps. S'abonne aux missions PLANNED. |
| Supervisor → D1 | Vérifie politique avant spawn worker. |
| Supervisor → D3 | Exprime need (BEST_CODING, etc.) → D3 route via OmniRoute. |
| Supervisor → D4 | Délègue l'exécution physique des workers. |
| Supervisor → G1 | Chaque invocation worker est gated par G1. |
| Scheduler → DAG | Le Scheduler lit et écrit le DAG. |
| WorkerManager → D4 | WorkerManager appelle D4 ExecutionPort pour chaque worker. |

### 3.2 Supervisor Boundary

Le Supervisor est responsable de :

1. Recevoir une Mission D2 PLANNED
2. Décomposer en Task DAG (V1 : DAG explicite fourni par le plan)
3. Planifier l'exécution (Scheduler)
4. Spawner des workers (WorkerManager)
5. Isoler les workspaces (WorktreeManager)
6. Lancer les revues (ReviewerManager)
7. Gérer les corrections (CorrectionLoop)
8. Intégrer les résultats (IntegrationOrchestrator)
9. Exécuter les global gates
10. Produire un livrable intégré
11. Signaler le résultat à D2

Le Supervisor **n'est pas** responsable de :
- Définir la politique de sécurité (D1)
- Router vers les providers AI (D3)
- Exécuter des sous-processus (D4)
- Accorder des permissions d'outil (G1)
- Gérer les credentials (CredentialBroker)

---

## 4. Task DAG & Scheduler

### 4.1 TaskDag

Le Task DAG est la structure de données centrale du Supervisor :

```typescript
interface TaskDag {
  id: string;
  missionId: string;
  tenantId: string;
  nodes: Map<string, TaskNode>;
  status: DagStatus;           // CREATED | SCHEDULING | EXECUTING | COMPLETED | FAILED | CANCELLED
  createdAt: string;
  updatedAt: string;
}

interface TaskNode {
  id: string;
  label: string;
  description: string;
  status: TaskNodeStatus;       // voir ci-dessous
  dependsOn: string[];          // IDs des nœuds parents
  blockedBy: string[];          // IDs des nœuds bloquants
  workerId?: string;
  reviewId?: string;
  correctionIds: string[];
  retryCount: number;
  maxRetries: number;
  workerSpec?: WorkerSpec;
  workerResult?: WorkerResult;
  reviewResult?: ReviewResult;
  integrationOrder?: number;
}
```

### 4.2 États des nœuds

```
PENDING ──→ READY ──→ ASSIGNED ──→ RUNNING ──→ REVIEWING ──→ SUCCEEDED
                               │         │            │
                               │         │       CHANGES_REQUIRED ──→ correction
                               │         │            │
                               │         │       FAILED_REVIEW ──→ correction
                               │    ┌────┴────┐
                               │    │         │
                               │    ▼         ▼
                               │  FAILED   CANCELLED
                               │    │
                               │    ▼
                               │  BLOCKED
                               │
                          WAITING_FOR_HUMAN
```

**Transitions terminales :** SUCCEEDED, FAILED, CANCELLED, BLOCKED

### 4.3 Scheduler

Le Scheduler est le moteur de progression du DAG :

| Fonction | Comportement |
|----------|-------------|
| `computeReadyNodes()` | Retourne tous les nœuds PENDING dont toutes les dépendances sont SUCCEEDED |
| `assignNode(node)` | Marque un nœud ASSIGNED, associe un worker |
| `onNodeCompleted(node)` | Re-calcule les ready nodes, propage aux dépendants |
| `onNodeFailed(node)` | Marque les dépendants directs BLOCKED (propagation optionnelle) |
| `cancelSubtree(node)` | Annule un nœud et tous ses dépendants |
| `retryNode(node)` | Réinitialise en READY si `retryCount < maxRetries` |

**Cycles :** Rejetés à la création du DAG (validation topologique).

---

## 5. Worker Manager

### 5.1 WorkerSpec

```typescript
interface WorkerSpec {
  taskId: string;
  missionId: string;
  tenantId: string;
  objective: string;             // Quoi faire
  acceptanceCriteria: string[];  // Critères de succès
  allowedWorkspace: string;      // Chemin worktree assigné
  modelProfile: AiRoutingIntent; // BEST_CODING, BEST_REASONING, etc.
  skills: string[];              // Compétences requises
  toolRequirements: string[];    // Outils nécessaires
  permissionEnvelope: {          // Référence D1
    action: string;
    resource: string;
    capabilityKey?: string;
  };
  timeoutMs: number;             // Timeout worker
  budget: {
    maxTokens?: number;
    maxCostUsd?: number;
  };
  reviewPolicy: {
    requiresReview: boolean;
    reviewerCount: number;
  };
}
```

### 5.2 WorkerResult

```typescript
type WorkerResult =
  | { outcome: "SUCCESS"; commitSha: string; artifacts: ArtifactItem[]; summary: string }
  | { outcome: "FAILED"; errorCode: string; message: string; artifacts: ArtifactItem[] }
  | { outcome: "BLOCKED"; reason: string; blockedBy: string }
  | { outcome: "NEEDS_REVIEW"; commitSha: string; reviewRequest: string }
  | { outcome: "NEEDS_HUMAN"; question: string; context: unknown };
```

### 5.3 WorkerManager

Le WorkerManager orchestre le cycle de vie des workers :

```
spawn(spec, signal) → workerId
status(workerId) → WorkerStatus
cancel(workerId) → void
collect(workerId) → WorkerResult
```

**V1 :** workers exécutés via D4 `ExecutionOrchestrator.execute()` sur un sous-processus local.
Chaque worker reçoit un `RuntimeAdapterInput` avec commande Claude CLI.

**Concurrence :** `maxConcurrentWorkers` configurable (défaut : 4).

---

## 6. Worktree Manager

Chaque worker d'implémentation reçoit un worktree Git isolé.

### 6.1 Opérations

```typescript
interface WorktreeManagerPort {
  createWorktree(taskId: string, baseSha: string): Promise<WorktreeSpec>;
  assignToTask(worktreePath: string, taskId: string): Promise<void>;
  captureResult(worktreePath: string): Promise<WorktreeResult>;
  detectDirty(worktreePath: string): Promise<string[]>;  // fichiers modifiés
  cleanupWorktree(worktreePath: string): Promise<void>;
  listActive(): Promise<WorktreeState[]>;
}
```

### 6.2 WorktreeResult

```typescript
interface WorktreeResult {
  baseSha: string;
  headSha: string;
  changedFiles: string[];
  isDirty: boolean;
  uncommittedFiles: string[];
  commitMessages: string[];
}
```

### 6.3 Invariants de sécurité

1. Un worker d'écriture = un worktree isolé par défaut
2. Pas d'écriture croisée entre workers
3. Pas de push main, pas de merge main, pas de force push
4. Nettoyage après intégration

---

## 7. Review / Correction Loop

### 7.1 Review Flow

```
Implementation Worker (task-1)         Reviewer Worker (task-1-review)
┌─────────────────────┐               ┌─────────────────────────┐
│ 1. Crée worktree    │               │ 1. Reçoit commit + spec │
│ 2. Implémente       │    assign     │ 2. Crée review worktree │
│ 3. Commit           │ ────────────▶ │ 3. Vérifie :            │
│ 4. Report SUCCESS   │               │    - acceptance criteria│
└─────────────────────┘               │    - tests              │
                                      │    - scope              │
                                      │    - regressions        │
                                      │    - security bounds    │
                                      │    - architecture bounds│
                                      │ 4. Report PASS/FAIL     │
                                      └─────────────────────────┘
```

### 7.2 Correction Loop

```
CHANGES_REQUIRED → Correction Task → Correction Worker → Re-review
                                                              │
                                                     ┌────────┴────────┐
                                                     │                 │
                                                    PASS         CHANGES_REQUIRED
                                                                      │
                                                               maxRetries exceeded?
                                                                      │
                                                              ┌───────┴───────┐
                                                              │               │
                                                           ESCALATE      FAILED
```

### 7.3 Sécurité du review

- Un implémenteur ne peut PAS être son propre reviewer
- Le reviewer a accès en lecture au worktree du implémenteur
- Boucle bornée : `maxCorrectionRetries` (défaut : 3)

---

## 8. Integration Orchestrator

### 8.1 Processus

```
1. Collecter tous les commits SUCCEEDED/REVIEWED
2. Ordonner selon le DAG (topologique)
3. Créer branche d'intégration depuis base
4. Appliquer chaque commit dans l'ordre
5. Détecter conflits :
   - Conflits sûrs (non ambigus) → résolution automatique
   - Conflits ambigus → BLOCKED, escalade humaine
6. Exécuter tests focus (per commit)
7. Exécuter global gates
```

### 8.2 Global Gates

```
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

---

## 9. Preview / Delivery

### V1 (LOCAL_DEV_ONLY)

```typescript
interface PreviewDeliveryPort {
  /**
   * V1 : Produit un résultat testable localement.
   * Le preview deployment (Vercel) est DEFERRED.
   */
  prepareLocalPreview(integrationBranch: string): Promise<DeliveryResult>;
}
```

**V1 Deliverable :** un commit testable sur la branche d'intégration.
**Pas de** preview externe, pas d'accès système client, pas de merge main.

---

## 10. Persistence / Recovery

### 10.1 Sources de vérité

| Donnée | Store | Rôle |
|--------|-------|------|
| Mission | D2 MissionRepository | Source de vérité Mission |
| Task DAG | SupervisorRepository | DAG + état des nœuds |
| Worker assignment | SupervisorRepository (via DAG) | Worker → Task mapping |
| Worktree state | WorktreeManager (system) | Git worktree state |
| Review results | SupervisorRepository | Review verdicts |
| Audit | AuditRepository | Audit trail global |

### 10.2 Recovery

Un redémarrage du Supervisor peut reconstruire l'état depuis :

1. **D2 MissionRepository** → mission + status
2. **SupervisorRepository** → Task DAG + nœuds
3. **WorktreeManager.listActive()** → worktrees orphelins
4. **Git log** → commits effectués

**Règle :** Ne pas rejouer automatiquement un worker dont l'état est inconnu.
L'état UNKNOWN (stale EXECUTING) nécessite intervention manuelle.

---

## 11. Budgets & Concurrence

```typescript
interface SupervisorConfig {
  maxConcurrentWorkers: number;        // défaut: 4
  maxConcurrentReviewers: number;      // défaut: 2
  maxTaskRetries: number;              // défaut: 2
  maxCorrectionRetries: number;        // défaut: 3
  defaultWorkerTimeoutMs: number;      // défaut: 300_000 (5 min)
  missionWallClockBudgetMs: number;    // défaut: 3_600_000 (1 h)
  dagPersistenceEnabled: boolean;      // défaut: true
}
```

---

## 12. D1 / D2 / D3 / D4 / G1 Interactions

### 12.1 D1 — Policy

```
Supervisor → D1 : "Le worker X peut-il exécuter l'action Y sur la ressource Z ?"
D1 → Supervisor : ALLOW | DENY | REQUIRE_APPROVAL
```

- Vérifiée avant spawn de chaque worker
- Worker non-spawné si DENY
- REQUIRE_APPROVAL → suspendu, WAITING_FOR_HUMAN

### 12.2 D2 — Mission

```
Supervisor → D2 : "Mission {id} est PLANNED → je commence"
Supervisor ← D2 : Mission + Plan (Steps)
Supervisor → D2 : "Mission {id} → IN_PROGRESS"
Supervisor → D2 : "Mission {id} → COMPLETED" (ou FAILED)
```

- Supervisor n'écrit PAS le plan D2 directement
- Supervisor reçoit le Plan D2 et le décompose en DAG

### 12.3 D3 — AI Gateway

```
Worker → D3 : "J'ai besoin de BEST_CODING pour implémenter X"
D3 → Worker : Résultat AI via OmniRoute
```

- ModelProfile exprimé dans WorkerSpec
- D3 route vers le provider optimal

### 12.4 D4 — Runtime Execution

```
WorkerManager → D4 : "Exécute ce step dans ce workspace"
D4 → WorkerManager : ExecutionResult (success/fail/timeout/cancelled)
```

- WorkerManager est client de D4 ExecutionPort
- Timeout D4 = worker timeout
- Workspace D4 utilisé pour l'isolation filesystem

### 12.5 G1 — Tool Gateway

```
WorkerManager → G1 : "Réserve un grant pour ce worker"
G1 → WorkerManager : ExecutionGrant | DENY
WorkerManager → G1 : "Consomme le grant pour l'exécution"
G1 → WorkerManager : Grant consumed
```

- Chaque worker invocation = G1 grant
- IdempotencyKey basée sur (tenant, principal, mission, run)
- Grant à usage unique, TTL court

---

## 13. Implementation Plan (SUP-1 → SUP-7)

| Phase | Contenu | Dépend de |
|-------|---------|-----------|
| SUP-1 | Task DAG + Scheduler (core contracts, lifecycle, scheduler, tests) | — |
| SUP-2 | WorkerManager (WorkerSpec, WorkerResult, WorkerManager, D4 integration, tests) | SUP-1 |
| SUP-3 | WorktreeManager (git worktree, isolation, cleanup, tests) | SUP-1 |
| SUP-4 | Review/Correction loop (ReviewerManager, CorrectionLoop, tests) | SUP-2, SUP-3 |
| SUP-5 | Integration + Global Gates (IntegrationOrchestrator, gates, tests) | SUP-3, SUP-4 |
| SUP-6 | Preview delivery (stub impl, local result only, tests) | SUP-5 |
| SUP-7 | Self-development test (end-to-end scenario) | SUP-1 → SUP-6 |

---

## 14. Security Invariants (Supreme)

1. **Pas d'auto-escalade** : le Supervisor ne peut pas s'accorder des permissions qu'il n'a pas.
2. **Pas de contournement D1** : tout worker spawn est gated par D1.
3. **Pas de merging main** : l'intégration produit une branche, pas un merge vers main.
4. **Isolation worker** : un worker n'écrit pas dans le workspace d'un autre.
5. **Fail closed** : toute erreur non reconnue → BLOCKED, pas de fallback silencieux.
6. **Grant single-use** : chaque worker require un G1 grant à usage unique.
7. **Rejeu contrôlé** : UNKNOWN state → pas de rejeu automatique.
8. **Revue indépendante** : implementeur != reviewer.
