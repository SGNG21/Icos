# D2 — Durable Orchestration (Mission Engine)

> **Lot D2 — Spec v1**
> Date : 2026-07-25
> Statut : DRAFT — PHASE 2 Formal Spec

---

## 1. Problème

ICOS n'a actuellement aucun moteur d'orchestration durable. Les opérations
(Task lifecycle, Capability transitions, Skill activation) sont des services
indépendants sans mission portable.

Aucune mission ne peut survivre à :

- un redémarrage serveur
- un échec provider
- une exhaustion de contexte
- une attente d'approbation

**Aujourd'hui, le contexte Claude est la source de vérité — contre les invariants ICOS.**

---

## 2. Solution : D2 Mission Engine

```
User Request
↓
Mission (créée, persistée)
↓
Plan (steps)
↓
Runs (exécution unitaire)
↓
Agents / Skills / Tools
↓
Verification
↓
Result (persisté)
↓
Mission COMPLETED ou FAILED
```

### 2.1 Mission lifecycle

```
CREATED
  ↓
PLANNING
  ↓
PLANNED
  ↓
IN_PROGRESS
  ├── WAITING_FOR_APPROVAL  ← approbation humaine
  ├── BLOCKED_BY_POLICY     ← D1 policy deny
  ├── PROVIDER_UNAVAILABLE  ← pas de provider disponible
  ├── TOOL_FAILED           ← erreur outil
  ├── SKILL_REVOKED         ← skill retirée pendant run
  ├── STALE_ATTESTATION     ← attestation expirée
  └── MISSION_RECOVERABLE   ← peut être reprise
  ↓
COMPLETED
  ou
FAILED
  ou
CANCELLED
```

### 2.2 États de Mission

```typescript
type MissionStatus =
  | "CREATED"
  | "PLANNING"
  | "PLANNED"
  | "IN_PROGRESS"
  | "WAITING_FOR_APPROVAL"
  | "BLOCKED_BY_POLICY"
  | "PROVIDER_UNAVAILABLE"
  | "TOOL_FAILED"
  | "SKILL_REVOKED"
  | "STALE_ATTESTATION"
  | "MISSION_RECOVERABLE"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";
```

Transitions autorisées :

```
CREATED → PLANNING
PLANNING → PLANNED
PLANNING → FAILED           (plan impossible)
PLANNED → IN_PROGRESS
PLANNED → CANCELLED         (annulé avant exécution)
IN_PROGRESS → COMPLETED
IN_PROGRESS → FAILED
IN_PROGRESS → WAITING_FOR_APPROVAL
IN_PROGRESS → BLOCKED_BY_POLICY
IN_PROGRESS → PROVIDER_UNAVAILABLE
IN_PROGRESS → TOOL_FAILED
IN_PROGRESS → SKILL_REVOKED
IN_PROGRESS → STALE_ATTESTATION
WAITING_FOR_APPROVAL → IN_PROGRESS   (approbation reçue)
WAITING_FOR_APPROVAL → CANCELLED     (refusée)
BLOCKED_BY_POLICY → IN_PROGRESS      (politique réévaluée)
BLOCKED_BY_POLICY → CANCELLED        (irrécouvrable)
PROVIDER_UNAVAILABLE → IN_PROGRESS   (provider revenu)
TOOL_FAILED → IN_PROGRESS            (retry)
SKILL_REVOKED → FAILED               (irrécouvrable)
STALE_ATTESTATION → WAITING_FOR_APPROVAL  (ré-attestation)
MISSION_RECOVERABLE → IN_PROGRESS    (reprise)
MISSION_RECOVERABLE → CANCELLED      (abandon)
COMPLETED → (terminal)
FAILED → (terminal)
CANCELLED → (terminal)
```

### 2.3 Contrats

```typescript
interface Mission {
  id: string;
  tenantId: string;
  userRequest: string; // requête utilisateur originale
  status: MissionStatus;
  plan?: Plan; // plan validé
  runs: Run[]; // exécutions
  error?: string; // raison d'échec
  currentRunId?: string; // run actif
  approvedBy?: string; // userId qui a approuvé
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

interface Plan {
  steps: Step[];
  totalSteps: number;
  description: string;
}

interface Step {
  id: string;
  description: string;
  agentId?: string;
  skillKey?: string;
  toolRef?: string;
  dependsOn: string[]; // step IDs prérequis
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  result?: StepResult;
}

interface StepResult {
  output: unknown;
  error?: string;
  durationMs: number;
}

interface Run {
  id: string;
  missionId: string;
  stepIndex: number;
  startedAt: string;
  completedAt?: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  error?: string;
  output?: unknown;
}
```

### 2.4 Ports

```typescript
interface MissionRepository {
  create(mission: Mission): Promise<Mission>;
  update(mission: Mission): Promise<Mission>;
  findById(id: string): Promise<Mission | null>;
  findByStatus(status: MissionStatus): Promise<Mission[]>;
  findActive(): Promise<Mission[]>; // missions non terminales
}

interface MissionUnitOfWork {
  transitionStatus(input: {
    id: string;
    fromStatus: MissionStatus;
    toStatus: MissionStatus;
    auditEntry: AuditEntry;
  }): Promise<UowResult>;
}
```

### 2.5 Architecture D2

```
src/core/mission/
├── contract.ts        // Mission, Plan, Step, Run, MissionStatus
├── lifecycle.ts       // state machine + transitions valides
├── index.ts

src/server/mission/
├── ports.ts           // MissionRepository, MissionUnitOfWork
├── mission-service.ts // MissionService (orchestrateur)
├── in-memory/
│   └── mission-repository.ts
├── postgres/
│   └── mission-repository.ts

src/server/database/
├── schema.ts          // missions + mission_runs + mission_audit tables
├── mappers.ts         // row ↔ Mission

drizzle/               // migration additive
```

### 2.6 Intégration container

```typescript
interface Container {
  // existant
  mission: MissionService;
}
```

---

## 3. Dépendances

- D1 Policy Engine (policy decisions) ✅
- COMPLIANCE-1 (TenantContext) ✅
- C1/C2 (Capabilities + Skills) ✅
- Repository + UoW patterns ✅
- Audit infrastructure ✅
- Zod contracts ✅

---

## 4. Tests requis

1. Mission CREATED → PLANNING → PLANNED → IN_PROGRESS → COMPLETED
2. IN_PROGRESS → WAITING_FOR_APPROVAL → IN_PROGRESS → COMPLETED
3. IN_PROGRESS → TOOL_FAILED → IN_PROGRESS → COMPLETED
4. IN_PROGRESS → PROVIDER_UNAVAILABLE → IN_PROGRESS → COMPLETED
5. IN_PROGRESS → SKILL_REVOKED → FAILED
6. PLANNED → CANCELLED
7. WAITING_FOR_APPROVAL → CANCELLED
8. Transition invalide → erreur
9. Reprise après restart : mission IN_PROGRESS → MISSION_RECOVERABLE
10. Mission non trouvée → null

---

## 5. Hors périmètre D2

- OmniRoute invocation (D3)
- Tool Gateway (G1)
- Voice interface (V1)
- Memory module
- Cockpit UX mission
- Agent selection intelligente
- Planification IA (planning manuel/stubbed pour D2)

---

## 6. Human gate

- PHASE 10 — Merge PR (validation humaine)
