# D1 — Policy / Authorization (ICOS Contextual Authority)

> **Lot D1 — Spec v1**
> Date : 2026-07-25
> Statut : DRAFT — PHASE 2 Formal Spec

---

## 1. Problème

ICOS dispose actuellement de plusieurs mécanismes d'autorisation disjoints :

- `AuthorizationService` (role + permission check depuis session)
- `decideExecution()` (risk + authorizationLevel + approvalStatus)
- `protectRoute()` (guard HTTP uniforme)
- TenantContext résolu (COMPLIANCE-1)

**Aucune composition centralisée** ne combine ces facteurs. Les décisions d'autorisation
contextuelles (tenant + classification + capability + risque + action + resource) sont
dispersées dans chaque route handler ou absentes.

**Exemples de décisions impossibles aujourd'hui :**
- « User X dans tenant A peut-il lire une Capability C2 ? »
- « Agent Y peut-il exécuter une action sensitive sur une resource C3 sans politique de rétention ? »
- « Cette requête cross-tenant est-elle autorisée ? »

---

## 2. Solution : D1 Policy Engine

```
Request
↓
D1 Policy Engine
├── Actor (user/agent identity)
├── Tenant (resolved TenantContext)
├── Resource (type, id, classification)
├── Action (read/write/execute/delete/approve)
├── Risk (read_only/reversible/sensitive)
├── Capability (optional)
├── Classification (C0-C3 + DataCategory)
├── Environment (backend type, execution mode)
└── External Effect (boolean — external mutation?)
↓
Decision : ALLOW | DENY | REQUIRE_APPROVAL
```

### 2.1 Port — `D1PolicyPort`

```typescript
interface D1PolicyPort {
  decide(request: PolicyRequest): Promise<PolicyDecision>;
}

interface PolicyRequest {
  actor: PolicyActor;
  tenant: TenantContext;
  action: string;
  resource: PolicyResource;
  capabilityKey?: string;
  risk?: RiskLevel;
  environment?: PolicyEnvironment;
}

type PolicyDecision =
  | { outcome: "allow"; reason: string; attestedAt: string }
  | { outcome: "deny"; reason: string; code: PolicyDenialCode }
  | { outcome: "require_approval"; reason: string; expiresAt: string };
```

### 2.2 Règles intégrées

La D1 Policy Engine intègre les règles suivantes (ordre d'application) :

1. **Authentication gate** — acteur non authentifié → DENY
2. **Tenant gate** — tenant invalide → DENY
3. **Permission gate** — permission manquante → DENY
4. **Classification gate** — accès C2/C3 sans niveau autorisé → DENY
5. **Retention gate** — C3 sans retentionPolicyRef sur activation → DENY
6. **Risk gate** — read_only acteur > risk action → DENY / REQUIRE_APPROVAL
7. **Capability gate** — capability absente / inactive → DENY
8. **External effect gate** — mutation externe sans approval → REQUIRE_APPROVAL
9. **IDOR gate** — cross-tenant → DENY
10. **Policy override** — règles métier additionnelles

### 2.3 Architecture

```
Route Handler
  ↓
protectRoute() // garde existante (auth + permission basique)
  ↓
D1PolicyPort.decide() // nouveau — décision contextuelle complète
  ↓
D1PolicyEngine (implémentation par défaut)
  ├── TenantGate
  ├── PermissionGate
  ├── ClassificationGate
  ├── RetentionGate
  ├── RiskGate
  ├── CapabilityGate
  ├── ExternalEffectGate
  ├── IDORGate
  └── (extensible)
  ↓
AuditEntry
```

### 2.4 Codes de refus

```typescript
type PolicyDenialCode =
  | "unauthenticated"
  | "no_tenant"
  | "forbidden"          // permission manquante
  | "classification_too_high"
  | "retention_policy_required"
  | "insufficient_authorization"
  | "capability_not_found"
  | "capability_inactive"
  | "cross_tenant_idor"
  | "external_mutation_requires_approval"
  | "policy_denied";
```

---

## 3. Dépendances

- TenantContext (COMPLIANCE-1) ✅
- Classification C0-C3 (COMPLIANCE-0 + COMPLIANCE-1) ✅
- Capability Registry (C1) ✅
- Skill Registry (C2) ✅
- Roles/Permissions (2B-1a/b) ✅
- Action decision (1B) ✅

---

## 4. Implémentation

### 4.1 Fichiers

```
src/core/policy/
├── index.ts          // re-exports
├── contract.ts       // PolicyRequest, PolicyDecision, PolicyDenialCode
├── engine.ts         // D1PolicyEngine — composition des gates
├── gates/
│   ├── tenant.gate.ts
│   ├── permission.gate.ts
│   ├── classification.gate.ts
│   ├── retention.gate.ts
│   ├── risk.gate.ts
│   ├── capability.gate.ts
│   ├── external-effect.gate.ts
│   ├── idor.gate.ts
│   └── index.ts
├── policy.test.ts    // tests complets

src/server/policy/
├── ports.ts          // D1PolicyPort interface
├── d1-policy-service.ts // Service intégré au container
└── d1-policy-service.test.ts

// Modifications routes existantes
src/server/http/protect-route.ts // extension avec D1PolicyPort
```

### 4.2 Container

```typescript
interface Container {
  // existant
  tenantResolver: TenantResolutionPort;
  // nouveau
  policy: D1PolicyPort;
}
```

### 4.3 Tests requis

1. ALLOW — actor authentifié, tenant OK, permission OK, classification OK
2. DENY — permission manquante
3. DENY — cross-tenant IDOR
4. DENY — classification trop élevée pour l'acteur
5. REQUIRE_APPROVAL — action sensible sans approval
6. REQUIRE_APPROVAL — mutation externe
7. ALLOW — C3 avec retention policy valide
8. DENY — capability inactive
9. Composition — règles cumulatives
10. Fail-closed — toute erreur interne → DENY

---

## 5. Hors périmètre D1

- Durable orchestration (D2)
- OmniRoute policy (routing technique, métier D3)
- Approval workflow avancé (D2)
- Policy versioning et rollback
- Policy hot-reload
- Policy editor UI

---

## 6. Human gate

- PHASE 3 — Design review (checklist + validation humaine)
- PHASE 10 — Merge PR (validation humaine)

Les phases 4-9 (implémentation → PR) ne nécessitent pas de gate humaine explicite
sauf dérive technique démontrée.
