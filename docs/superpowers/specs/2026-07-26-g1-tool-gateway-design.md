# G1 — Tool Gateway Design

> **Lot :** G1 · Phase Design
> **Date :** 2026-07-26
> **Statut :** DESIGN_FINALIZED — READY_FOR_G1_IMPLEMENTATION
> **Dépendances :** D1 (Policy), D4.1 (Runtime), Governance (ExecutionGrant)
> **Débloque :** G2 (MCP Discovery + Trust)

---

## 1. Problème

ICOS n'a actuellement aucune couche qui transforme :

> "un agent veut utiliser un outil"

en :

> "une exécution contextualisée, autorisée, limitée, auditable et vérifiable".

Le `Step.toolRef` existant (`src/core/runtime/contract.ts`) est une chaîne libre transmise à D4 sans résolution d'identité, sans politique outil-spécifique, sans inspection pré-vol, sans grant d'exécution, sans adaptateur tool-aware.

**Ni D1, ni D2, ni D4 ne couvrent ce gap :**

| Couche | Responsabilité |
|--------|---------------|
| D1 | Politique d'autorisation contextuelle (actor + tenant + action + resource) |
| D2 | Mission SOT — cycle de vie, planification, orchestration |
| D3 | AI Gateway — routage provider, génération IA |
| D4 | Execution SOT — runtime, workspace, credentials, network |
| **G1** | **Tool Gateway — identité outil, inspection, grant, audit** |

---

## 2. Invariants fondateurs

```
Tool          ≠ Capability
Capability    ≠ Permission
Permission    ≠ Approval
Approval      ≠ ExecutionGrant
MCP tool      ≠ authorized tool
Tool available ≠ tool trusted ≠ tool authorized
D4 Runtime    ≠ G1 Tool Gateway
D1 = policy authority
D2 = Mission SOT
D4 = Execution SOT
G1 = tool invocation governance
FAIL CLOSED
```

---

## 3. Architecture

```
D2 Mission Engine
  │
  │   toolRef = "github.list_prs"
  │   capabilityKey = "code.review"
  │
  ▼
G1 ToolGatewayPort.invoke(request)
  │
  ├── resolve ToolIdentity(toolRef) → ToolIdentity + ToolDefinition
  ├── schema validation + canonicalization
  ├── derive requestHash
  ├── derive / validate IdempotencyKey
  ├── reserve idempotency (IdempotencyState → RESERVED)
  ├── D1PolicyPort.decide() — PolicyRequest enrichi des attributs outil
  ├── ExecutionInspector pipeline → PASS / BLOCK / ESCALATE
  ├── D1 re-evaluation si findings ESCALATE
  ├── [REQUIRE_APPROVAL → NOT_OPERATIONAL V1 — voir §12]
  ├── ExecutionGrant issuance (si D1 ALLOW)
  ├── Pre-execution freshness + hash check
  ├── IdempotencyState → EXECUTING
  │
  ▼
D4 RuntimeExecutionPort.execute()
  │
  ├── D1 re-check (SEC-D4-07 — defense-in-depth)
  ├── workspace, credentials, network, adapter
  ├── execution
  │
  ▼
G1 result validation
  │
  ├── persist result reference
  ├── append immutable ExecutionRecord
  ├── IdempotencyState → COMPLETED / FAILED_SAFE
  │
  ▼
ToolInvocationResult → D2
```

---

## 4. Contrats

### 4.1 ToolIdentity — CREATE

```typescript
/** Identité logique stable d'un outil.
 *  Indépendante de la version, de la source, du serveur MCP.
 *  Le déplacement ou la mise à jour ne produit PAS une nouvelle identité. */
interface ToolIdentity {
  toolId: string;       // identifiant stable, ex: "github.list_prs"
  name: string;         // nom humain
}
```

**STATUS : FINAL**

### 4.2 ToolDefinition — CREATE

```typescript
interface ToolDefinition {
  identity: ToolIdentity;
  version: string;
  source: ToolSource;
  publisher: string;
  adapterKind: string;
  description: string;
  declaredCapabilities: string[];
  risk: ToolRisk;                     // informationnel — D1 décide
  requirements: ToolRequirements;
  inputSchema?: unknown;              // G1 propriétaire des schémas
  outputSchema?: unknown;
  externalEffects: string[];
}

type ToolSource =
  | { kind: "mcp"; serverUrl: string }
  | { kind: "builtin" }
  | { kind: "plugin"; pluginId: string }
  | { kind: "external"; registry: string };

type ToolRisk =
  | { level: "read_only"; description: string }
  | { level: "data_mutation"; description: string; scope: string }
  | { level: "external_effect"; description: string; target: string }
  | { level: "credential_access"; description: string; credentialType: string }
  | { level: "code_execution"; description: string }
  | { level: "system_control"; description: string };

interface ToolRequirements {
  networkAccess: NetworkRequirement[];
  credentialRefs: CredentialRequirement[];
  isolationProfile: IsolationRequirement;
}
```

**ToolRisk = default conservative signal seulement.**
G1 mappe ToolRisk → PolicyRisk (3 niveaux D1 : read_only/reversible/sensitive).
D1 décide selon le contexte complet.

**STATUS : FINAL** (G1 propriétaire des schémas input/output — pas D4.1)

### 4.3 ToolInvocationRequest — RECONCILE + EXTEND

```typescript
interface ToolInvocationRequest {
  // De D2 (aligné sur ExecuteStepInput existant)
  missionId: string;
  tenantId: string;
  correlationId: string;
  runId: string;
  stepIndex: number;

  // Résolu par G1 à partir de toolRef
  toolId: string;               // ToolIdentity.toolId
  capabilityKey?: string;

  // Arguments de l'invocation
  arguments: Record<string, unknown>;

  // Contexte
  actor: PolicyActor;
  environment?: PolicyEnvironment;
  idempotencyKey?: IdempotencyKey;  // proposition client — G1 dérive le hash canonique
}
```

**STATUS : FINAL**

### 4.4 ToolInvocationResult — RECONCILE + EXTEND

```typescript
type ToolInvocationResult =
  | ToolInvocationSuccess
  | ToolInvocationFailure
  | ToolInvocationBlocked;

interface ToolInvocationSuccess {
  ok: true;
  output: unknown;
  executionGrantRef: string;
  executionRecordId: string;
  usage?: unknown;
  latencyMs: number;
}

interface ToolInvocationFailure {
  ok: false;
  error: ToolInvocationError;
  executionRecordId: string;
}

interface ToolInvocationBlocked {
  ok: false;
  blocked: true;
  reason: ToolBlockedReason;
  findings: ExecutionInspectorFinding[];
  executionRecordId: string;
}

type ToolBlockedReason =
  | "policy_denied"
  | "inspector_blocked"
  | "stale_grant"
  | "tool_not_found"
  | "tool_inactive"
  | "approval_required"
  | "approval_path_not_available";
```

**STATUS : PARTIAL** — format findings peut évoluer avec G2.

### 4.5 ToolGatewayPort — CREATE (Option A)

```typescript
interface ToolGatewayPort {
  /** Point d'entrée unique : D2 invoque un outil via G1 */
  invoke(request: ToolInvocationRequest): Promise<ToolInvocationResult>;

  /** Résolution pure d'identité (pas d'exécution) — planification D2 */
  resolveIdentity(toolRef: string, tenantId: string): Promise<ToolIdentity | null>;

  /** Inspection seule (pas d'exécution) — planification D2 */
  inspectOnly(request: ToolInvocationRequest): Promise<InspectionReport>;
}
```

**Justification Option A (port unique) :**
- Style ICOS existant : `D1PolicyPort` (decide), `RuntimeExecutionPort` (execute), `AiGatewayPort` (generate) — un port = une responsabilité
- `resolveIdentity` et `inspectOnly` sont des fonctions de **support à l'invocation**, pas des couches indépendantes
- YAGNI : séparer en V1 est prématuré avant G2 (MCP Discovery)
- Les deux fonctions sont documentées comme **ne remplaçant jamais** l'invocation réelle (TOCTOU protection)

**STATUS : FINAL V1**

### 4.6 ExecutionGrant — CREATE (canonique, Governance terminé)

```typescript
import type { CredentialRequest, NetworkRequest } from "@/server/runtime/ports";

interface ExecutionGrant {
  grantId: string;
  requestHash: string;                    // lié à l'invocation canonique
  toolDefinitionHash: string;             // extraction explicite pour freshness/audit
  idempotencyKey: string;
  toolId: string;
  actor: PolicyActor;
  tenantId: string;
  missionId: string;
  runId: string;
  capabilityKey?: string;
  policyDecisionRef: string;              // EXTEND D1 — PolicyDecision n'a pas d'ID aujourd'hui
  policyRuleIds?: string[];
  issuedAt: string;
  expiresAt: string;
  scope: GrantScope;
}

interface GrantScope {
  // Types D4 réutilisés (RECONCILE avec les vrais contrats D4)
  credentialKeys?: string[];              // CredentialRequest.requiredKeys
  allowedEndpoints?: NetworkRequest["requestedEndpoints"];
  isolationProfile?: "process" | "container" | "vm";
  // Bornes
  maxInvocations: 1;                      // V1 = single-use
  allowedOperations?: string[];
}

// Non présent dans G1 V1 (REQUIRE_APPROVAL NOT_OPERATIONAL) :
// approvalResolutionRef?: string;
// eligibleApproverSnapshot?: EligibleApproverSnapshot;
```

**Invariant :** Le grant n'existe QUE pour D1 ALLOW.
- D1 DENY → aucun ExecutionGrant
- D1 REQUIRE_APPROVAL → aucun ExecutionGrant tant que l'approbation valide n'est pas résolue (NON OPÉRATIONNEL V1)

**STATUS : FINAL** — Governance terminé. ExecutionGrant = CREATE.

### 4.7 ExecutionInspector — CREATE

```typescript
interface ExecutionInspector {
  readonly name: string;
  inspect(request: ToolInvocationRequest, definition: ToolDefinition): Promise<InspectionResult>;
}

interface InspectionResult {
  outcome: "PASS" | "BLOCK" | "ESCALATE";
  findings: ExecutionInspectorFinding[];
}

interface ExecutionInspectorFinding {
  inspectorName: string;
  severity: "info" | "warning" | "error" | "critical";
  code: string;
  message: string;
  evidence?: unknown;           // jamais de credential
  suggestion?: string;
}
```

**Invariant :**
- L'inspector produit un résultat structuré. Il **ne décide jamais** l'approbation.
- `BLOCK` = hard safety invariants (path traversal, payload limit, command structural violation) — STOP immédiat
- `ESCALATE` = nécessite décision politique D1 via `PolicyRiskSignal`
- G1 aggrège les findings et enrichit la requête vers D1 → seule D1 produit `ALLOW/DENY/REQUIRE_APPROVAL`

**STATUS : FINAL**

### 4.8 ExecutionRecord — EXTEND (data minimization)

```typescript
import type { SensitivityLevel } from "@/core/contracts/tenant";

interface ExecutionRecord {
  recordId: string;
  eventType: G1AuditEventType;
  timestamp: string;
  tenantId: string;
  missionId: string;
  runId: string;
  toolId: string;
  actor: PolicyActor;
  grantId?: string;
  policyDecisionRef?: string;
  idempotencyKey?: string;
  outcome: "success" | "failure" | "blocked" | "cancelled" | "unknown";
  errorCode?: string;
  durationMs: number;
  inspectorFindings?: ExecutionInspectorFinding[];
  artifactRefs?: string[];         // références — jamais les payloads
  outputHash?: string;             // hash du résultat
  classification: SensitivityLevel; // C0|C1|C2|C3 — type canonique ICOS
  dataCategory?: string;           // distinct de classification
  redactedSummary?: string;        // si autorisé par classification
}
```

**Invariant :**
```
Audit Log (ExecutionRecord)  — journal immuable, métadonnées seules
≠ Artifact Store              — payloads/outputs durables
≠ Business Data Store         — vérité métier PostgreSQL
```

**STATUS : FINAL**

### 4.9 IdempotencyKey — CREATE (Governance CRITICAL)

```typescript
interface IdempotencyKey {
  key: string;                   // hash déterministe des components ci-dessous
  components: {
    tenantId: string;
    missionId: string;
    runId: string;
    toolId: string;
    operation: string;
    resourceKey?: string;
    invocationNonce?: string;    // pour invocations intentionnellement identiques
  };
}

interface IdempotencyState {
  idempotencyKey: string;
  requestHash: string;
  status: "RESERVED" | "EXECUTING" | "COMPLETED" | "FAILED_SAFE" | "UNKNOWN";
  result?: ToolInvocationResult;
  lockExpiresAt?: string;        // détection de stale reservation
}
```

**Lifecycle :**
```
1. G1 dérive idempotencyKey = hash(requestHash + tenantId + missionId)
2. Client peut proposer une clé → G1 valide la cohérence
3. Reservation atomique :
   - key COMPLETED → retourner cached result
   - key EXECUTING + stale → UNKNOWN (fail closed — pas de reprise auto)
   - key inconnu → RESERVED
4. Après D4 → COMPLETED ou FAILED_SAFE
```

**STATUS : FINAL**

### 4.10 Canonical Request Hash — CREATE

```typescript
interface CanonicalRequestHash {
  algorithm: string;    // "sha256"
  hash: string;         // hex digest
}

// Composants du hash (déterministes, key-sort + stable JSON) :
// tenantId + principal.id + toolId + toolDefinitionHash
// + operation + resourceKey (si applicable)
// + arguments canonical ordered
// + capabilityKey (si fourni)
// + externalEffectScope
```

**Fields bound :**

| Champ | Protection |
|-------|-----------|
| `tenantId` | Anti cross-tenant invocation |
| `principal.id` | Anti substitution d'acteur |
| `toolId` | Anti tool spoofing |
| `toolDefinitionHash` | Anti stale definition |
| `operation` | Anti operation substitution |
| `resourceKey` | Anti resource escalation |
| `arguments` (canonical) | Anti argument injection |
| `capabilityKey` | Anti capability mismatch |
| `externalEffectScope` | Anti consentement étendu |

**Invariant pré-exécution :**
```
currentRequestHash == grant.requestHash == idempotency.requestHash
Mismatch → DENY
```

**STATUS : FINAL**

### 4.11 GrantState — CREATE (séparé de IdempotencyState)

```typescript
type GrantStatus = "AVAILABLE" | "CONSUMED";

interface GrantState {
  grantId: string;
  status: GrantStatus;
  consumedAt?: string;
  consumedBy?: string;      // runId
}
```

**Invariant :** Grant et IdempotencyState ont des responsabilités distinctes :
- Grant = autorisation single-use
- IdempotencyState = recovery/idempotence de l'effet métier
- Un `COMPLETED` peut être rejoué depuis l'idempotence SANS réutiliser l'ancien grant

### 4.12 PolicyRiskSignal — EXTEND D1

```typescript
// D1 core — EXTEND src/core/policy/contract.ts
interface PolicyRiskSignal {
  source: string;
  code: string;
  severity: "info" | "warning" | "error" | "critical";
  evidence?: unknown;
}

// EXTEND PolicyRequest avec :
interface PolicyRequest {
  // ... champs existants inchangés
  riskSignals?: PolicyRiskSignal[];   // NOUVEAU — inspection context
}
```

**Invariant :** `core/policy` ne dépend jamais de G1. `PolicyRiskSignal` est un type D1 générique. G1 mappe `ExecutionInspectorFinding → PolicyRiskSignal[]`.

### 4.13 Contrats existants RECONCILE

| Contrat existant | Usage G1 | Opération | Statut |
|-----------------|----------|-----------|--------|
| `ExecuteStepInput.toolRef` | Point d'entrée de la résolution d'identité | EXTEND (G1 résout au-delà) | COMPATIBLE |
| `PolicyRequest` | G1 construit PolicyRequest enrichie des attributs ToolDefinition | RECONCILE (`risk` mappé depuis ToolRisk) | EXTEND D1 (riskSignals) |
| `PolicyDecision` | Consommé par G1 | EXISTS — mais **pas d'ID** → `policyDecisionRef` nécessite EXTEND D1 | EXTEND D1 |
| `RuntimeExecutionPort.execute()` | G1 délègue l'exécution à D4 après autorisation | EXTEND V2 (grantRef dans ExecuteStepInput) | **INCHANGÉ V1** |
| `CredentialRequest` / `NetworkRequest` | G1 produit ces requêtes à partir de `ToolDefinition.requirements` | RECONCILE (D4 définit le format, G1 le peuple) | COMPATIBLE |
| `auditEventTypeSchema` | G1 ajoute ses propres types d'événements | EXTEND (migration additive, motif DROP+ADD CHECK) | EXTEND |
| `Mission.step.toolRef` | D2 passe `toolRef` libre | EXISTS (inchangé pour D2) | COMPATIBLE |

---

## 5. ExecutionGrant Strategy

### 5.1 Invariants

```
ApprovedScope (max human si REQUIRE_APPROVAL — NOT_OPERATIONAL V1)
  ↓  ⊆ (narrower or equal)
ExecutionGrant.scope
  ↓  ↦ (concrete permissions derived from)
RuntimeRequirements
  ↓  ⊧ (execution must comply with)
Actual execution

Le grant ne peut JAMAIS élargir l'autorisation humaine.
```

### 5.2 TTL

```
TTL par défaut :  60s
TTL maximum :     300s

Grant TTL : fenêtre entre émission et consommation atomique.
Runtime timeout D4 : durée maximale d'exécution (mécanisme séparé).

Un grant CONSUMED avant son TTL reste valide même si D4 dépasse le timeout.
```

### 5.3 Single-use

```
G1 V1 : maxInvocations = 1
GrantState : AVAILABLE → CONSUMED (atomique)
Toute tentative de réutilisation d'un grantId consumé → DENY
```

### 5.4 Pre-execution chain

```
Avant D4.execute() :
1. grant.exists(grantId) ?                          → DENY si non
2. grant.status == CONSUMED ?                        → DENY (replay)
3. grant.expiresAt < now ?                           → DENY (stale)
4. grant.requestHash == invocation.requestHash ?     → DENY (substitution)
5. grant.tenantId == invocation.tenantId ?            → DENY (cross-tenant)
6. grant.toolId == resolved.toolId ?                 → DENY (tool substitution)
7. grant.actor.id == invocation.actor.id ?            → DENY (principal substitution)
8. idempotency.status == EXECUTING/COMPLETED ?       → DENY ou cached
```

### 5.5 Atomic consumption et completion

```
D4 result
↓
TRANSACTION atomique :
  1. persist result reference / result
  2. append immutable ExecutionRecord (audit)
  3. IdempotencyState → COMPLETED / FAILED_SAFE
↓
commit

Si atomicité impossible (backends distincts) :
  append ExecutionRecord AVANT IdempotencyState
  (l'audit est la source de vérité finale)
  crash entre les deux → UNKNOWN (fail closed — recovery V1 deferred)

Invariant : COMPLETED signifie que le résultat nécessaire au replay est durable.
```

### 5.6 EligibleApproverSnapshot

```
Décision : DEFERRED (P1 après V1)

Raison :
- G1 V1 n'a pas le chemin REQUIRE_APPROVAL opérationnel
- Approval.decidedBy est un label non authentifié — insuffisant pour un grant
- L'implémentation nécessite EligibleApproverPort + snapshot des pouvoirs
  au moment de l'approbation
```

---

## 6. ExecutionInspector Strategy

### 6.1 Pipeline V1

```
1. Schema Inspector       — structure, types, canonical args
2. Path Inspector         — sécurité workspace / path traversal
3. Command Inspector      — sécurité execution / injection
4. Credential Inspector   — identité, scope, compatibilité grant (JAMAIS le secret)
5. Network Inspector      — endpoints requis vs NetworkPolicy
6. External Effect Insp.  — classification d'effet
7. Size Inspector         — limites volumétriques payload/arguments
```

**Ordre :** les checks rapides et sans I/O passent en premier (schema, path, command). Les inspectors qui nécessitent des appels externes (credential, network) passent après.

### 6.2 BLOCK vs ESCALATE

```
BLOCK = hard safety invariants (non discrétionnaires)
  ├── path traversal
  ├── payload/size limit
  ├── command structural violation
  ├── schema mismatch (post-canonicalization)
  └── → STOP immédiat, retourner BLOCKED

ESCALATE = nécessite décision politique D1
  ├── external effect
  ├── risk escalation
  ├── unusual credential/network scope
  └── → findings → PolicyRiskSignal → D1 re-evaluation
```

### 6.3 Mapping D1

```
ExecutionInspectorFinding
  ↓ (G1 mapping)
PolicyRiskSignal[]          (D1 core type — EXTEND)
  ↓
PolicyRequest.riskSignals   (EXTEND D1)
  ↓
D1PolicyPort.decide()
```

### 6.4 Credential Inspector — résolution ≠ vérification

```
CredentialInspector (G1) :
  ✓ vérifie l'identité du credential demandé
  ✓ vérifie la déclaration de scope dans ToolDefinition
  ✓ vérifie la compatibilité avec le grant
  ✓ vérifie le contexte tenant/principal
  ✗ ne résout JAMAIS le secret

CredentialBrokerPort (D4) :
  ✓ résout les credentials
  ✓ retourne CredentialReference[] + environment

Defense in depth :
  G1 preflight  → credentials identifiés et compatibles
  D4 enforcement → CredentialBrokerPort.resolve()
  audit → credentialRefs seulement, jamais le secret
```

### 6.5 Extension G2

```typescript
// G2 pourra ajouter :
// - MCP Schema Reconcile Inspector
// - Quarantine Inspector
// - Trust Level Inspector
// - Rate Limit Inspector
// - Budget Inspector
// - Compliance Inspector

// L'ajout d'un nouvel inspector ne modifie ni D1, ni D4, ni les autres inspectors.
```

---

## 7. D4 Integration

### 7.1 G1 → D4 boundary

```
G1 appelle D4 via RuntimeExecutionPort.execute(ExecuteStepInput)
D4 ne dépend PAS de G1 — aucun import G1 dans le code D4

VÉRIFICATION : D4.1 (merge 618ff19) contient :
- src/core/runtime/contract.ts        → aucun import G1 ✓
- src/server/runtime/ports.ts          → aucun import G1 ✓
- src/server/runtime/execution-orchestrator.ts → aucun import G1 ✓
- src/server/runtime/adapters/local-runtime-adapter.ts → aucun import G1 ✓
```

### 7.2 V1 — D4 inchangé

En V1, G1 passe le `ExecuteStepInput` originel à D4 sans champs additionnels. D4 fait son propre re-check D1 (SEC-D4-07) — redondance défensive acceptable.

```
G1 construit ExecuteStepInput avec :
  ├── toolRef = toolExecutionRef (référence opaque résolue)
  ├── missionId, tenantId, runId, correlationId (from ToolInvocationRequest)
  ├── hasExternalEffect = dérivé de ToolDefinition.externalEffects
  └── timeoutMs
  ↓
D4 RuntimeExecutionPort.execute(input)
  ↓
D1 re-check (SEC-D4-07 — défense en profondeur)
```

### 7.3 V2+ — EXTEND possible

Ajouter `executionGrantRef` optionnel dans `ExecuteStepInput` permettrait à D4 de :
- Sauter son D1 re-check si un grant valide est fourni (perf)
- Retourner des métadonnées d'exécution liées au grant

---

## 8. Security Model

### 8.1 Menaces couvertes

| Menace | Mitigation G1 |
|--------|--------------|
| Tool spoofing | ToolIdentity stable, `toolId` lié au grant |
| Tool identity confusion | `toolDefinitionHash` + `requestHash` binding |
| Schema manipulation | Schema validation + canonicalization |
| Argument injection | Canonical arguments hash, Path Inspector |
| Path traversal | Path Inspector → BLOCK |
| Network escalation | Network Inspector + NetworkPolicyPort (D4) |
| Credential escalation | Credential Inspector (preflight), CredentialBroker (résolution) |
| Approval reuse | `requestHash` binding, `scope ⊆ approvedScope` |
| Stale grant | TTL court, freshness check pré-exécution |
| Cross-tenant invocation | `tenantId` dans requestHash + grant |
| Confused deputy | ToolDefinition == ToolIdentity résolu par G1 — pas l'appelant |
| Malicious MCP server | G2 (quarantine, trust) — G1 V1 gère les outils déjà autorisés |
| Prompt injection → tool | Inspectors pipeline, D1 policy |
| Tool result forgery | Output validation, outputHash |
| Replay | IdempotencyKey, GrantState CONSUMED |
| TOCTOU | requestHash boundé au grant, freshness check immédiat avant D4 |
| Double effet externe | IdempotencyKey, crash recovery fail-closed |

### 8.2 Defense in depth

```
G1 preflight          → identity, schema, policy, inspection, grant
  ↓
D4 execution-time     → D1 re-check (SEC-D4-07), workspace, credentials, network
  ↓
Audit                 → immutable ExecutionRecord, idempotency state
```

### 8.3 Approved scope containment

```
requestedScope ⊆ approvedScope       (borne MAXIMALE humaine)
ExecutionGrant.scope ⊆ approvedScope (grant ne peut pas élargir)
RuntimeRequirements ⊆ GrantScope     (requirements dérivés du grant)
Actual execution ⊧ RuntimeRequirements (exécution contrainte)
```

### 8.4 Crash recovery — fail closed

```
Crash après D4.execute mais avant ExecutionRecord + idempotency finalization
│
├── idempotency.status = UNKNOWN
│
├── ExternalEffectReconciliation disponible ?
│   ├── YES → reconcilier → COMPLETED ou FAILED_SAFE
│   └── NO →
│         Audit: tool.invocation_unknown
│         RETURN: blocked + reason: "unknown_state_manual_intervention_required"
│
└── JAMIS de replay automatique sauf outil à idempotence vérifiable
    (procédure de récupération explicitement autorisée)
```

---

## 9. G1 V1 Scope

### 9.1 Operational

| Chemin | V1 Statut |
|--------|-----------|
| D1 ALLOW → grant → D4 execution | **OPERATIONAL** |
| D1 DENY → BLOCKED | **OPERATIONAL** |
| Inspector BLOCK → BLOCKED | **OPERATIONAL** |
| Inspector ESCALATE → D1 re-evaluation | **OPERATIONAL** (EXTEND D1: PolicyRiskSignal) |
| Idempotency (RESERVED/EXECUTING/COMPLETED/FAILED_SAFE) | **OPERATIONAL** |
| Crash recovery → UNKNOWN → fail closed | **OPERATIONAL** |
| Single-use grant (AVAILABLE → CONSUMED) | **OPERATIONAL** |
| RuntimeRequirements → D4 compatibles | **OPERATIONAL** (D4 inchangé) |
| ExecutionRecord audit | **OPERATIONAL** (EXTEND auditEventTypeSchema) |

### 9.2 NOT_OPERATIONAL V1

| Chemin | Raison | Bloqueur |
|--------|--------|----------|
| REQUIRE_APPROVAL → grant | `Approval.decidedBy` non authentifié, EligibleApproverSnapshot absent | Identité approbateur vérifiée + EligibleApproverPort |
| Multi-invocation grant | maxInvocations > 1 | Usage métier non démontré V1 |
| ExternalEffectReconciliation | Pas de port défini | DEFERRED |
| Active revocation | TTL court + single-use suffisant | DEFERRED |
| G2 MCP Discovery + Quarantine | Hors scope G1 | G2 |

### 9.3 Dependencies

```
D1 (EXISTS):
  ├── D1PolicyPort.decide()     → EXISTS
  ├── PolicyDecision ID         → EXTEND D1 (nécessaire pour policyDecisionRef)
  └── PolicyRiskSignal          → EXTEND D1 (inspection context)

D4.1 (MERGED — 618ff19):
  ├── RuntimeExecutionPort      → EXISTS (inchangé V1)
  ├── CredentialBrokerPort      → EXISTS (réutilisé)
  ├── NetworkPolicyPort         → EXISTS (réutilisé)
  └── Isolation profile         → EXISTS (réutilisé)

Audit:
  ├── audit_entries             → EXISTS
  └── auditEventTypeSchema      → EXTEND (G1 event types)
```

---

## 10. Test Matrix

### Unitaires (G1)

| # | Test | Objet |
|---|------|-------|
| 1 | ToolIdentity resolution — toolRef connu | Identity resolver |
| 2 | ToolIdentity resolution — toolRef inconnu → null | Identity resolver |
| 3 | Schema validation — arguments valides | Schema validator |
| 4 | Schema validation — arguments invalides → BLOCKED | Schema validator |
| 5 | requestHash — même invocation → même hash | Hash derivation |
| 6 | requestHash — invocation différente → hash différent | Hash derivation |
| 7 | IdempotencyKey — dérivation canonique | Idempotency |
| 8 | IdempotencyKey — déjà COMPLETED → cached result | Idempotency |
| 9 | IdempotencyKey — déjà EXECUTING stale → UNKNOWN | Idempotency |
| 10 | D1 ALLOW → GateWayPort.invoke → succès | Full flow |
| 11 | D1 DENY → BLOCKED | Policy integration |
| 12 | Inspector BLOCK → BLOCKED immédiat | Inspector pipeline |
| 13 | Inspector ESCALATE + D1 ALLOW → succès | Inspector + D1 |
| 14 | Grant issuance — single-use | Grant |
| 15 | Grant reuse → DENY | Grant consumption |
| 16 | Grant expired → DENY | Grant TTL |
| 17 | Grant requestHash mismatch → DENY | Grant binding |
| 18 | ExecutionRecord — append-only invariant | Audit |
| 19 | Crash recovery — UNKNOWN → fail closed | Recovery |
| 20 | ToolRisk → PolicyRisk mapping défaut | Risk mapping |

### Intégration (D4.1 réel)

| # | Test | Objet |
|---|------|-------|
| 21 | G1 → D4 → succès | D4 compatibility |
| 22 | G1 → D4 → D1 re-check (redondance) | Defense in depth |
| 23 | G1 → D4 → timeout | D4 timeout |
| 24 | G1 → D4 → cancellation | D4 cancellation |

---

## 11. Architecture de fichiers (conceptuelle)

```
src/
├── core/
│   ├── contracts/
│   │   └── tool.ts                    ← ToolIdentity, ToolDefinition, ToolRisk
│   ├── gateway/
│   │   ├── index.ts                   ← Re-exports
│   │   ├── contract.ts                ← ToolInvocationRequest, ToolInvocationResult
│   │   ├── grant.ts                   ← ExecutionGrant, GrantState, GrantScope
│   │   ├── idempotency.ts             ← IdempotencyKey, IdempotencyState
│   │   ├── inspector.ts              ← ExecutionInspector, InspectionResult
│   │   ├── hash.ts                    ← CanonicalRequestHash derivation
│   │   ├── audit.ts                   ← ExecutionRecord, G1AuditEventType
│   │   └── policy.ts                  ← ToolRisk → PolicyRisk mapping
│   │
│   └── policy/
│       └── contract.ts                ← EXTEND: PolicyRiskSignal, riskSignals dans PolicyRequest
│
├── server/
│   └── gateway/
│       ├── ports.ts                   ← ToolGatewayPort interface
│       ├── tool-gateway-service.ts    ← Implémentation du port
│       ├── identity-resolver.ts       ← ToolRef → ToolIdentity
│       ├── hash-service.ts            ← requestHash derivation
│       ├── idempotency-store.ts       ← IdempotencyState store
│       ├── grant-store.ts             ← GrantState store (AVAILABLE/CONSUMED)
│       └── inspectors/
│           ├── index.ts               ← Pipeline orchestration
│           ├── schema.inspector.ts
│           ├── path.inspector.ts
│           ├── command.inspector.ts
│           ├── credential.inspector.ts
│           ├── network.inspector.ts
│           ├── external-effect.inspector.ts
│           └── size.inspector.ts
│
├── drizzle/
│   └── migrations/
│       ├── g1-tool-definitions.sql        ← Table tool_definitions
│       ├── g1-idempotency-state.sql       ← Table idempotency_state
│       ├── g1-grant-state.sql             ← Table grant_state
│       └── g1-audit-events.sql            ← EXTEND audit_event_type_check
└── config/
    └── env.ts                            ← Extension si nécessaire
```

---

## 12. Dépendances et Gaps

### 12.1 Dépendances D1

| Élément | Statut | Action |
|---------|--------|--------|
| `D1PolicyPort.decide()` | EXISTS | Utilisé tel quel |
| `PolicyDecision` | EXISTS (sans ID) | `policyDecisionRef` nécessite **EXTEND D1** — ajouter un identifiant persistant à chaque décision |
| `PolicyRequest` | EXISTS | G1 enrichit avec `risk` mappé, `hasExternalEffect` |
| `PolicyRiskSignal` | NO | **EXTEND D1** — nouveau type pour findings d'inspection |
| `riskSignals` dans PolicyRequest | NO | **EXTEND D1** — nouveau champ optionnel |
| Tool-specific D1 gate | EXTEND D1 | Nouvelle gate évaluant `resource.type === "tool"` |

### 12.2 Dépendances D4.1

| Élément | Statut | Action |
|---------|--------|--------|
| `RuntimeExecutionPort.execute()` | EXISTS | Utilisé tel quel V1 — G1 ne modifie pas D4 |
| `CredentialBrokerPort.resolve()` | EXISTS | G1 produit les `CredentialRequest` |
| `NetworkPolicyPort.check()` | EXISTS | G1 produit les `NetworkRequest` |
| `ExecuteStepInput` | EXISTS | G1 passe le même type — champs inchangés |
| `ExecutionResult` | EXISTS | G1 consomme et valide |
| `CredentialReference` | EXISTS | G1 réutilise pour GrantScope |
| `NetworkPermission` | EXISTS | G1 réutilise pour GrantScope |

### 12.3 Gaps

| Gap | Sévérité | Solution |
|-----|----------|----------|
| `PolicyDecision` sans ID | P1 | EXTEND D1 — `policyDecisionRef` nécessaire dans l'`ExecutionGrant` |
| `PolicyRequest` sans `riskSignals` | P1 | EXTEND D1 — nécessaire pour inspector ESCALATE → D1 re-evaluation |
| `Approval.decidedBy` non authentifié | **P0 bloquant** REQUIRE_APPROVAL | G1 V1 ne supporte pas REQUIRE_APPROVAL. Chemin NOT_OPERATIONAL. |
| ExternalEffectReconciliation | P2 | DEFERRED — crash recovery V1 → UNKNOWN → manual intervention |
| D4 reçoit grantRef | P2 | EXTEND V2 dans ExecuteStepInput — pas nécessaire V1 |

---

## 13. G1 DESIGN FINALIZED

```
main SHA:                               e1010149dcf2e6d55979c08aed7a95bb79b63d5b
(D4.1 merged at 618ff19ed367e9c82a54f66c147629f73f0fc7e0)

G1→D4 boundary:                         PASS (no G1 imports in D4.1)
Circular dependency:                    NONE
RuntimeExecutionPort compatibility:     PASS (unchanged V1)
IdempotencyKey retry semantics:         PASS (fail closed on UNKNOWN)
Idempotency lifecycle:                  PASS (RESERVED/EXECUTING/COMPLETED/FAILED_SAFE/UNKNOWN)
Crash-after-external-effect handling:   PASS (fail closed → manual intervention)
ExecutionGrant binding:                 PASS (requestHash + toolDefinitionHash + scope containment)

ToolGateway API:                        Option A — port unique (ToolGatewayPort.invoke/resolveIdentity/inspectOnly)

G1.0 scope:                             ALLOW + DENY operational, identity resolution,
                                        inspector pipeline, grant lifecycle, D4 integration
G1.1 scope:                             REQUIRE_APPROVAL + EligibleApproverSnapshot,
                                        revocation, multi-invocation grant
G1.2 blocking V1:                       YES — REQUIRE_APPROVAL non opérationnel
                                        reason: Approval.decidedBy non authentifié,
                                        EligibleApproverSnapshot absent

Spec changes after D4.1 revalidation:   NONE (D4.1 contracts compatible as-is)
Implementation blockers:                NONE (D4.1 merged, D1 exists)
                                          P1 items (policyDecisionRef ID, riskSignals) are
                                          EXTEND D1 during G1 implementation, not blockers

STATUS:                                 READY_FOR_G1_IMPLEMENTATION
```
