# C2 — Skill Registry & Trust Lifecycle

## Statut et objectif

Design validé par l'utilisateur (revue du 2026-07-24 et 2026-07-25, 11 corrections
appliquées). Ce document décrit le modèle métier, la persistance, les permissions,
l'audit et les tests de C2 — le registre des Skills ICOS avec lifecycle de confiance
et d'activation.

**Aucune implémentation n'accompagne ce document** : aucune migration réelle,
aucun code sous `src/`, aucune dépendance nouvelle, aucun commit.

Modèle de référence : **Agent = QUI**, **Capability = QUOI**, **Skill =
COMMENT**, **Tool = AVEC QUOI**, **Policy = SI**. Une déclaration de
requirement n'est jamais une permission.

Séparation fondamentale :

- **TrustState** ≠ **ActivationState** ≠ **Permission** ≠ **Capability** ≠ **Human Approval**
- **Requirement déclaré** ≠ **Permission accordée**
- **Déclaration de Capability** ≠ **Assignation de Capability**

## Contraintes invariantes

- Aucune modification sous `src/`, `drizzle/`, `package.json`, `pnpm-lock.yaml`.
- Aucune migration réelle appliquée ; toute migration future est additive et
  numérotée à l'index réellement disponible au moment de l'implémentation
  (actuellement `0000`–`0005` sur main — le prochain index disponible est `0006`).
- Aucune dépendance nouvelle.
- Ne modifie ni C1, ni 2B-2, ni COMPLIANCE-0 — extensions additives uniquement.
- C2 **n'implémente pas l'Orchestrateur**, ni le Tool Gateway, ni le Sandbox.
  L'exécution, la résolution de dépendances et l'octroi de permissions sont
  hors périmètre.
- C2 **ne stocke aucun secret, credential valeur ou token**.
- C2 **ne confère aucune permission effective** via un champ du registre.

## Architecture retenue

### 1. Relations de domaine

```text
C1 (Capability Registry)                C2 (Skill Registry)
┌──────────────────────┐                ┌──────────────────────────┐
│ Capability           │◄─référence par──│ Skill.capabilityKeys[]   │
│  .key (stable,       │     clé stable  │                          │
│   immutable)         │                │  "j'implémente ces caps"  │
│  .status (lifecycle) │                │  (déclaration, pas grant) │
└──────────────────────┘                └──────────────────────────┘
                                                │
                                       ┌────────┴────────┐
                                       │                 │
                                  TrustState      ActivationState
                              (confiance contenu) (dispo exécution)

2B-2 (Authorization)            D1 (Policy Engine)
┌────────────────────┐         ┌──────────────────────┐
│ skills.read        │         │ Effective permission │
│ skills.propose     │         │ grants               │
│ skills.create      │         │ Capability approval  │
│ skills.trust.write │         │ External effect       │
│ skills.activation  │         │ policy               │
│  .write            │         └──────────────────────┘
│ skills.delete      │
└────────────────────┘
```

### 2. C2 owns vs C2 does not own

**C2 owns :**
- Skill identity (key, version, name, description)
- Source, provenance, write origin
- Content integrity (hash)
- Trust lifecycle (TrustState)
- Activation lifecycle (ActivationState)
- Quarantine management
- Import traceability
- Declarative requirements (network, credential, isolation, tool, dependency)
- Security scan results (findings)
- Evaluation results
- Review state
- Original manifest metadata (opaque, provenance only)

**C2 does not own :**
- Effective authorization
- Permission grants
- Capability assignments (C1 + human)
- Orchestration (D2/D4)
- Runtime execution semantics (D4)
- Credential values (G1 / CredentialBroker)
- Sandbox implementation (D4/G1)
- Network enforcement (D4/G1)
- Tool execution (G1)
- Provider routing (D3)

### 3. Modèle métier — Skill

| Champ | Type | Remarques |
|-------|------|-----------|
| `id` | `text` PK | Interne, généré |
| `tenantId` | `text` NOT NULL | Tenant isolation |
| `skillKey` | `text` NOT NULL | Identifiant métier stable, ex. `code.review.agent`. Format `capabilityKeySchema` |
| `version` | `text` NOT NULL | Semver, ex. `1.0.0`. Partie de l'identité |
| `name` | `text` NOT NULL | Libellé mutable |
| `description` | `text` | Optionnel |
| `capabilityKeys` | `jsonb` NOT NULL | `string[]` — clés stables C1. Déclaration, jamais auto-assignation |
| `category` | `text` NOT NULL | Regroupement fonctionnel (ex. `cognitive`, `tool`, `data`, `communication`) |
| `trustState` | `text` NOT NULL | Voir §5 |
| `activationState` | `text` NOT NULL | Voir §6 |
| `scripts` | `jsonb` | Contenu du skill |
| `resources` | `jsonb` | Prompts, configs, etc. |
| `references` | `jsonb` | Documentation, sources |
| `dependencyDeclarations` | `jsonb` | Dépendances vers d'autres skills (déclaratif) |
| `networkRequirements` | `jsonb` | Déclaratif |
| `credentialRequirements` | `jsonb` | Déclaratif — jamais de valeur |
| `executionIsolationRequirement` | `jsonb` | Déclaratif |
| `toolRequirements` | `jsonb` | Déclaratif |
| `inputSchema` | `jsonb` | Opaque, metadata provenance uniquement |
| `outputSchema` | `jsonb` | Opaque, metadata provenance uniquement |
| `dataCategory` | `text` | Nullable en C2. COMPLIANCE-0 : PUBLIC, INTERNAL, PERSONAL, etc. |
| `sensitivityLevel` | `text` | Nullable en C2. COMPLIANCE-0 : C0, C1, C2, C3 |
| `contentHash` | `text` NOT NULL | SHA-256 du contenu canonique |
| `provenance` | `jsonb` NOT NULL | Inclut originalManifest |
| `createdAt` | `timestamptz` | |
| `updatedAt` | `timestamptz` | |

### 4. Provenance — SkillProvenance

**Champs immuables** (Domain-enforced) :

```typescript
{
  source: "internal" | "local_file" | "git_repo" | "url" | "marketplace",
  origin: "human" | "agent" | "system" | "migration",
  contentHash: string,          // SHA-256 du contenu
  importedAt: string,           // ISO timestamp
  importedByUserId?: string,    // Qui a importé
  sourceUrl?: string,           // URL source
  sourceVersion?: string,       // Version dans la source
  sourceRef?: string,           // Commit/tag
  originalManifest?: Record<string, unknown>,  // JSONB opaque — manifest source
}
```

**Enforcement de l'immutabilité :** Domain/Application-enforced (pas de trigger DB) :
1. Constructeur/uniquement écrit à la création
2. Aucun setter public sur provenance
3. Aucun use case de mutation de provenance
4. `SkillRepository.update()` exclut les champs de provenance du SET SQL
5. Tests unitaires et intégration

### 5. TrustState — lifecycle de confiance

```
untrusted        : importé, hash + provenance enregistrés
quarantined      : en quarantaine, en attente de validation
reviewed         : validation technique/scan PASS
approved         : approuvé par humain (HUMAN ONLY)
rejected         : rejeté — TERMINAL pour ce contentHash
```

**Transitions autorisées :**

| From → To | Conditions | Permission |
|-----------|-----------|------------|
| `untrusted → quarantined` | Hash + provenance enregistrés | `skills.trust.write` |
| `quarantined → reviewed` | Scan PASS + eval PASS, ou review manuelle | `skills.trust.write` |
| `quarantined → rejected` | Scan FAIL ou review rejette | `skills.trust.write` |
| `reviewed → approved` | **HUMAN ONLY** | `skills.trust.write` |
| `reviewed → rejected` | Humain rejette | `skills.trust.write` |
| `approved → rejected` | **Atomic : rejected + revoked** | `skills.trust.write` |
| `rejected → *` | **TERMINAL** — aucune transition | — |

### 6. ActivationState — lifecycle d'activation

```
inactive     : non activé (état initial)
active       : activé, utilisable (SI trustState = approved)
suspended    : suspension temporaire
revoked      : révoqué — TERMINAL pour cette SkillVersion
```

**Transitions autorisées :**

| From → To | Conditions | Permission |
|-----------|-----------|------------|
| `inactive → active` | trustState = approved, **HUMAN ONLY** | `skills.activation.write` |
| `inactive → revoked` | Révocation avant activation | `skills.activation.write` |
| `active → suspended` | Suspension temporaire | `skills.activation.write` |
| `active → inactive` | Désactivation (ex. remplacement de version) | `skills.activation.write` |
| `active → revoked` | Révocation définitive | `skills.activation.write` |
| `suspended → active` | Réactivation | `skills.activation.write` |
| `suspended → revoked` | Révocation depuis suspension | `skills.activation.write` |
| `revoked → *` | **TERMINAL** — aucune transition | — |

### 7. Cross-invariants Trust/Activation

```
CROSS-I-1 : activationState = active ⇒ trustState = approved
CROSS-I-2 : trustState = rejected ⇒ activationState = revoked
```

**Conséquences :**

- `active + untrusted` → ÉTAT IMPOSSIBLE
- `active + quarantined` → ÉTAT IMPOSSIBLE
- `active + reviewed` → ÉTAT IMPOSSIBLE
- `active + approved` → SEUL ÉTAT VALIDE
- `active + rejected` → IMPOSSIBLE (CROSS-I-2 impose revoked)
- `rejected + active` → IMPOSSIBLE
- `rejected + inactive` → IMPOSSIBLE (CROSS-I-2 impose revoked)
- `rejected + suspended` → IMPOSSIBLE (CROSS-I-2 impose revoked)
- `rejected + revoked` → UNIQUE ÉTAT VALIDE après rejet

**Atomicité :** la transition `approved → rejected` produit atomiquement :
```
trustState = rejected
activationState = revoked
```
dans la même transaction PostgreSQL.

### 8. Requirements déclaratifs

Tous les requirements sont des **déclarations de besoin**, jamais des permissions accordées.
Le préfixe `required*` ou le suffixe `*Requirement` est obligatoire.

```typescript
// === Network Requirement ===
interface SkillNetworkRequirement {
  requiredDomain: string;        // ex. "api.github.com"
  purpose: string;               // ex. "fetch pull requests"
  required: boolean;             // true = bloquant si inaccessible
  dataSentDescription?: string;  // description de ce qui est envoyé
}

// === Credential Requirement (aucune valeur stockée) ===
interface SkillCredentialRequirement {
  requiredCredentialKind: string;  // ex. "github_token"
  purpose: string;
  requiredScope: string;           // ex. "repo:read"
  required: boolean;
}
//  ⚠ JAMAIS : credentialValue, credentialSecret, token, apiKey

// === Execution Isolation Requirement ===
interface SkillExecutionIsolationRequirement {
  requiredIsolationLevel: "none" | "process" | "container" | "sandbox";
  requiredFsReadPaths: string[];
  requiredFsWritePaths: string[];
  requiredNetworkMode: "none" | "outbound" | "inbound" | "both";
  justification: string;
}

// === Tool Requirement ===
interface SkillToolRequirement {
  requiredTool: string;   // correspond à une Capability (ex. "gmail.send")
  required: boolean;
  purpose: string;
}

// === Dependency Declaration ===
interface SkillDependencyDeclaration {
  dependencySkillKey: string;
  versionConstraint?: string;    // ex. ">=1.0.0"
  optional: boolean;
}
```

**Invariant :** Aucun de ces champs n'est interprété par C2 comme :
- une permission accordée (D1)
- une capability assignée (C1)
- un accès réseau effectif (G1)
- une exécution de tool (G1)
- une résolution de dépendance (D4)

### 9. Hash canonique

**Algorithme :** sérialisation canonique (clés triées, pas d'espaces superflus) + SHA-256.

**Ce qui entre dans le hash :**

```typescript
const hashPayload = canonicalStringify({
  skillKey,
  version,
  name,
  description,           // null si absent
  category,
  capabilityKeys,        // trié
  scripts,               // trié par name
  resources,             // trié par path
  references,            // trié par url
  dependencyDeclarations, // trié par dependencySkillKey
  networkRequirements,    // trié par requiredDomain
  credentialRequirements, // trié par requiredCredentialKind
  executionIsolationRequirement, // null si absent
  toolRequirements,       // trié par requiredTool
  inputSchema,            // null si absent (opaque, inclus si présent dans manifest)
  outputSchema,           // null si absent (opaque, inclus si présent dans manifest)
  originalManifest,       // null si absent (inclus car security/content relevant)
});
contentHash = sha256(hashPayload);
```

**Ce qui n'entre PAS dans le hash :**
```
id, tenant_id, created_at, updated_at,
trust_state, activation_state,
data_category, sensitivity_level,
provenance (sauf originalManifest),
security_scans, security_findings, evaluations
```

### 10. Immutabilité des versions

**CONTENT_MUTABLE_STATES :** `untrusted`, `quarantined`, `reviewed`

Dans ces états, le contenu (champs participant au hash) peut être modifié. Cela déclenche :
1. Recalcul du hash
2. trustState ← `untrusted`
3. activationState ← `inactive`
4. Anciens scans/evals deviennent stale (hash mismatch)
5. Audit : `skill.content_changed`

**CONTENT_IMMUTABLE_STATES :** `approved`, `rejected`

Dans ces états, toute modification d'un champ participant au hash est **REFUSÉE**.
Pour modifier le contenu → créer une nouvelle SkillVersion avec version incrémentée.

Les champs non-hash restent mutables :
- `trustState`, `activationState` (lifecycle)
- `dataCategory`, `sensitivityLevel` (classification)

### 11. Security Scans & Findings

**Table `skill_security_scans`** :

| Champ | Type | Remarques |
|-------|------|-----------|
| `id` | `text` PK | |
| `tenantId` | `text` NOT NULL | |
| `skillId` | `text` NOT NULL | FK → skills.id ON DELETE RESTRICT |
| `evaluatedContentHash` | `text` NOT NULL | Le hash EXACT du contenu scanné |
| `scannerId` | `text` NOT NULL | ex. `skillspector`, `manual` |
| `scannerVersion` | `text` | |
| `status` | `text` NOT NULL | `running`, `passed`, `failed`, `error` |
| `startedAt` | `timestamptz` NOT NULL | |
| `completedAt` | `timestamptz` | |
| `metadata` | `jsonb` | |
| `createdAt` | `timestamptz` NOT NULL | |

**Table `skill_security_findings`** :

| Champ | Type | Remarques |
|-------|------|-----------|
| `id` | `text` PK | |
| `scanId` | `text` NOT NULL | FK → skill_security_scans.id ON DELETE RESTRICT |
| `severity` | `text` NOT NULL | `low`, `medium`, `high`, `critical` |
| `category` | `text` NOT NULL | `prompt_injection`, `exfiltration`, `privilege_escalation`, `dangerous_code`, `supply_chain`, `excessive_agency`, `tool_poisoning` |
| `code` | `text` | Identifiant du scanner pour ce finding |
| `message` | `text` NOT NULL | |
| `location` | `text` | Script/path concerné |
| `metadata` | `jsonb` | |

**Table `skill_evaluations`** :

| Champ | Type | Remarques |
|-------|------|-----------|
| `id` | `text` PK | |
| `tenantId` | `text` NOT NULL | |
| `skillId` | `text` NOT NULL | FK → skills.id ON DELETE RESTRICT |
| `evaluatedContentHash` | `text` NOT NULL | Le hash EXACT du contenu évalué |
| `evaluatorType` | `text` NOT NULL | ex. `behavioral`, `unit`, `integration` |
| `evaluatorVersion` | `text` | |
| `status` | `text` NOT NULL | `running`, `passed`, `failed`, `error` |
| `score` | `jsonb` | Structuré, pas un chiffre nu |
| `startedAt` | `timestamptz` NOT NULL | |
| `completedAt` | `timestamptz` | |
| `metadata` | `jsonb` | |
| `createdAt` | `timestamptz` NOT NULL | |

**Règle de promotion :** Un scan ou eval `passed` n'est valable pour une promotion
que si `evaluatedContentHash` === `skill.contentHash`. Sinon : STALE_ATTESTATION
→ promotion interdite. Les anciens scans/evals restent en historique (pas de
suppression).

### 12. Versioning et activation transactionnelle

**Règle de coexistence :**

```
UNIQUE (tenant_id, skill_key, version)
→ plusieurs versions peuvent coexister dans le registre

UNIQUE ACTIVE (tenant_id, skill_key)
→ un seul ACTIF par skillKey et tenant (partial unique index SQL)
```

**Activation d'une nouvelle version (transaction) :**

```
1. BEGIN
2. Vérifier skills.activation.write (authorization)
3. Vérifier actorType = HUMAN
4. Vérifier que newVersion.trustState = 'approved'
5. SELECT ... FOR UPDATE sur toutes les versions WHERE skill_key = X
6. Si une version active existe (oldActive) :
   a. oldActive.activationState = 'inactive'
   b. Audit : skill.activation_changed pour oldActive
7. newVersion.activationState = 'active'
8. Audit : skill.activation_changed pour newVersion (inclut oldVersionId)
9. COMMIT
```

**Rejet d'une version active (transaction) :**

```
1. BEGIN
2. Vérifier skills.trust.write (authorization)
3. SELECT ... FOR UPDATE sur la version
4. SET trustState = 'rejected'
5. SET activationState = 'revoked'  (CROSS-I-2)
6. Audit : skill.trust_changed + skill.activation_changed
7. COMMIT
```

### 13. Re-review flow

```
1. Mutation sur champ participant au contentHash
2. Recalcul du hash (contentHash_new)
3. contentHash_new === contentHash_old ?
   ├── OUI → no-op
   └── NON → 4.
4. Mise à jour atomique :
   a. contentHash = contentHash_new
   b. trustState = 'untrusted'
   c. activationState = 'inactive'
   d. Audit : skill.content_changed { previousHash, newHash }
5. Anciens scans/evals préservés comme historique (stale)
6. Nouveaux scans/evals nécessaires avant re-promotion
```

### 14. Permissions

Permissions ajoutées à `src/core/identity/permissions.ts` (sans référence à des
rôles spécifiques — C2 définit la permission, 2B-2 définit le rôle) :

| Permission | Description | Transition concernée |
|-----------|-------------|---------------------|
| `skills.read` | Consulter le registre | Routes GET skills |
| `skills.propose` | Proposer/import un skill | Import |
| `skills.create` | Créer un skill directement | Création |
| `skills.trust.write` | Changer TrustState | quarantined/reviewed/approved/rejected |
| `skills.activation.write` | Changer ActivationState | active/suspended/revoked |
| `skills.delete` | Supprimer une version | DELETE |

**HUMAN ONLY transitions :**
- `reviewed → approved` : nécessite `skills.trust.write` + actorType = HUMAN
- `inactive → active` : nécessite `skills.activation.write` + actorType = HUMAN
- Ces transitions vérifient que l'acteur est humain (session) mais ne spécifient
  pas de rôle. La politique de rôle est externe (2B-2).

### 15. Use cases — CapabilityService

| Use case | Permission | Actor | Transaction | Audit events |
|----------|-----------|-------|------------|-------------|
| `importSkill(input)` | `skills.propose` | human, system | Hash+provenance, trustState=untrusted | `skill.imported` |
| `createSkill(input)` | `skills.create` | human | Création directe | `skill.created` |
| `quarantineSkill(id)` | `skills.trust.write` | human, system | trustState=quarantined | `skill.trust_changed` |
| `approveSkill(id)` | `skills.trust.write` + HUMAN | human | trustState=approved | `skill.trust_changed` |
| `rejectSkill(id)` | `skills.trust.write` | human | trustState=rejected + activationState=revoked | `skill.trust_changed` + `skill.activation_changed` |
| `activateSkill(id)` | `skills.activation.write` + HUMAN | human | FOR UPDATE, desactive ancien, active nouveau | `skill.activation_changed` |
| `suspendSkill(id)` | `skills.activation.write` | human | activationState=suspended | `skill.activation_changed` |
| `reactivateSkill(id)` | `skills.activation.write` | human | activationState=active (si approved) | `skill.activation_changed` |
| `revokeSkill(id)` | `skills.activation.write` | human | activationState=revoked | `skill.activation_changed` |
| `updateSkillContent(id, data)` | `skills.create` | human | Rehash, trustState=untrusted (SI mutable) | `skill.content_changed` |
| `deleteSkill(id)` | `skills.delete` | human | DELETE (jamais si actif) | — |
| `recordScan(id, results)` | `skills.trust.write` | system | Insert scan + findings | `skill.security_scan_recorded` |
| `recordEval(id, result)` | `skills.trust.write` | system | Insert eval | `skill.eval_recorded` |

### 16. API — Routes

| Méthode | Route | Permission | Corps | Réponse |
|---------|-------|-----------|-------|---------|
| `GET` | `/api/skills` | `skills.read` | Query: `?trustState=&activationState=&capabilityKey=&skillKey=` | `{ skills: Skill[] }` |
| `GET` | `/api/skills/[id]` | `skills.read` | — | `{ skill: Skill }` |
| `POST` | `/api/skills` | `skills.propose` ou `skills.create` | `{ skillKey, version, name, category, ... }` | `201 { skill }` |
| `PATCH` | `/api/skills/[id]/trust` | `skills.trust.write` | `{ targetTrustState }` | `{ skill }` |
| `PATCH` | `/api/skills/[id]/activation` | `skills.activation.write` | `{ targetActivationState }` | `{ skill }` |
| `DELETE` | `/api/skills/[id]` | `skills.delete` | — | `204` |

**Routes trust et activation sont SEPARÉES :** impossible de modifier les deux
dans un même appel.

Toute route suit l'ordre de vérification : container → session → permission →
origine → corps JSON → validation métier → exécution.

### 17. Audit events

Événements à ajouter à `auditEventTypeSchema` (motif DROP+ADD CHECK existant) :

| # | Événement | Acteur | Détails (fermés) | Transition |
|---|-----------|--------|-------------------|-----------|
| 1 | `skill.created` | human, system | `{ skillKey, version }` | Création |
| 2 | `skill.imported` | human, system | `{ skillKey, version, source, contentHash }` | Import |
| 3 | `skill.content_changed` | human, system | `{ skillKey, version, previousHash, newHash }` | Mise à jour contenu |
| 4 | `skill.trust_changed` | human, system | `{ skillKey, version, previousTrustState, newTrustState, reason? }` | Transition TrustState |
| 5 | `skill.activation_changed` | human | `{ skillKey, version, previousActivationState, newActivationState, previousActiveVersion? }` | Transition ActivationState |
| 6 | `skill.security_scan_recorded` | system | `{ skillId, scanId, evaluatedHash, status }` | Scan complété |
| 7 | `skill.eval_recorded` | system | `{ skillId, evalId, evaluatedHash, status }` | Eval complétée |

**Aucune donnée sensible** dans les détails : pas de contenu de scan brut,
pas de credential, pas de message de finding complet si sensible.

### 18. Schéma Drizzle — Contraintes SQL

```sql
-- skills
CREATE TABLE skills (
  id                              text PRIMARY KEY,
  tenant_id                       text NOT NULL,
  skill_key                       text NOT NULL,
  version                         text NOT NULL,
  name                            text NOT NULL,
  description                     text,
  capability_keys                 jsonb NOT NULL DEFAULT '[]',
  category                        text NOT NULL,
  trust_state                     text NOT NULL,
  activation_state                text NOT NULL,
  scripts                         jsonb,
  resources                       jsonb,
  references                      jsonb,
  dependency_declarations         jsonb,
  network_requirements            jsonb,
  credential_requirements         jsonb,
  execution_isolation_requirement jsonb,
  tool_requirements               jsonb,
  input_schema                    jsonb,
  output_schema                   jsonb,
  data_category                   text,
  sensitivity_level               text,
  content_hash                    text NOT NULL,
  provenance                      jsonb NOT NULL,
  created_at                      timestamptz NOT NULL,
  updated_at                      timestamptz NOT NULL,

  UNIQUE (tenant_id, skill_key, version),

  CHECK (trust_state IN ('untrusted','quarantined','reviewed','approved','rejected')),
  CHECK (activation_state IN ('inactive','active','suspended','revoked')),
  CHECK (data_category IS NULL OR data_category IN (
    'PUBLIC','INTERNAL','PERSONAL','SENSITIVE_PERSONAL','CONFIDENTIAL_CLIENT',
    'AUTH_SECRET','FINANCIAL','LEGAL','HEALTH','HR','CHILD_DATA','BIOMETRIC',
    'DERIVED_PROFILE'
  )),
  CHECK (sensitivity_level IS NULL OR sensitivity_level IN ('C0','C1','C2','C3'))
);

CREATE UNIQUE INDEX skills_single_active_per_key
  ON skills (tenant_id, skill_key)
  WHERE activation_state = 'active';

CREATE INDEX skills_trust_state_idx ON skills(trust_state);
CREATE INDEX skills_activation_state_idx ON skills(activation_state);
CREATE INDEX skills_skill_key_idx ON skills(skill_key);
CREATE INDEX skills_content_hash_idx ON skills(content_hash);
CREATE INDEX skills_capability_keys_idx ON skills USING gin(capability_keys);

-- skill_security_scans
CREATE TABLE skill_security_scans (
  id                      text PRIMARY KEY,
  tenant_id               text NOT NULL,
  skill_id                text NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  evaluated_content_hash  text NOT NULL,
  scanner_id              text NOT NULL,
  scanner_version         text,
  status                  text NOT NULL CHECK (status IN ('running','passed','failed','error')),
  started_at              timestamptz NOT NULL,
  completed_at            timestamptz,
  metadata                jsonb,
  created_at              timestamptz NOT NULL
);

CREATE INDEX scans_by_skill_hash ON skill_security_scans(skill_id, evaluated_content_hash);

-- skill_security_findings
CREATE TABLE skill_security_findings (
  id          text PRIMARY KEY,
  scan_id     text NOT NULL REFERENCES skill_security_scans(id) ON DELETE RESTRICT,
  severity    text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  category    text NOT NULL,
  code        text,
  message     text NOT NULL,
  location    text,
  metadata    jsonb,
  created_at  timestamptz NOT NULL
);

CREATE INDEX findings_by_scan ON skill_security_findings(scan_id);

-- skill_evaluations
CREATE TABLE skill_evaluations (
  id                      text PRIMARY KEY,
  tenant_id               text NOT NULL,
  skill_id                text NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  evaluated_content_hash  text NOT NULL,
  evaluator_type          text NOT NULL,
  evaluator_version       text,
  status                  text NOT NULL CHECK (status IN ('running','passed','failed','error')),
  score                   jsonb,
  started_at              timestamptz NOT NULL,
  completed_at            timestamptz,
  metadata                jsonb,
  created_at              timestamptz NOT NULL
);

CREATE INDEX evals_by_skill_hash ON skill_evaluations(skill_id, evaluated_content_hash);
```

**Pas de table :**
- `skill_status_history` (couvert par audit_entries)
- `skill_attestations` (couvert par scans + evals)
- `skill_import_record` (couvert par provenance)

### 19. Repositories — Ports

```typescript
interface SkillRepository {
  getById(id: string): Promise<Skill | null>;
  getByKeyAndVersion(tenantId: string, skillKey: string, version: string): Promise<Skill | null>;
  list(tenantId: string, filters?: SkillListFilters): Promise<Skill[]>;
  create(skill: Skill): Promise<Skill>;
  updateTrustState(id: string, trustState: TrustState): Promise<Skill>;
  updateActivationState(id: string, activationState: ActivationState): Promise<Skill>;
  updateContent(id: string, skill: Skill, previousHash: string): Promise<Skill>;
  deactivateIfActive(tenantId: string, skillKey: string, excludingId: string): Promise<string | null>;
  delete(id: string): Promise<boolean>;
}

interface SkillSecurityScanRepository {
  create(scan: SecurityScan): Promise<SecurityScan>;
  findValidForHash(skillId: string, contentHash: string): Promise<SecurityScan | null>;
  listBySkill(skillId: string): Promise<SecurityScan[]>;
}

interface SkillEvaluationRepository {
  create(eval: Evaluation): Promise<Evaluation>;
  findValidForHash(skillId: string, contentHash: string): Promise<Evaluation | null>;
  listBySkill(skillId: string): Promise<Evaluation[]>;
}
```

### 20. Container

Extension de `Container` dans `src/server/container.ts` :

```typescript
interface Container {
  // ... existant (agents, tasks, actions, capabilities, ...)

  // C2 — Skill Registry
  skills: SkillRepository;
  skillSecurityScans: SkillSecurityScanRepository;
  skillEvaluations: SkillEvaluationRepository;
  skillService: SkillService;
}
```

### 21. Frontières C2 / C1 / D1 / D2 / D4 / G1

| Domaine | Porte | Ne porte pas |
|---------|-------|-------------|
| **C2** | Skill identity, TrustState, ActivationState, provenance, hash, requirements déclaratifs, scans, evals | Permissions effectives, exécution, credentials, accès réseau |
| **C1** | Capability identity, Capability lifecycle, Agent↔Capability assignment | Skill registry, execution, trust |
| **2B-2** | Rôles humains, permissions, Human↔Agent links | Skill registry, capability registry |
| **D1** | Policy evaluation, effective authorization, approval for external effects | Skill storage, runtime execution |
| **D2** | Mission/Plan/Run orchestration, compatibility resolution | Skill registry, policy, execution |
| **D4** | Runtime execution, validation d'appel, skill selection | Registry, permissions, approval |
| **G1** | Tool execution, credential resolution, sandbox, network access | Registry, lifecycle, policy |

### 22. Compliance — Alignement COMPLIANCE-0

| Contrainte COMPLIANCE-0 | Application C2 |
|------------------------|----------------|
| **DataCategory** | Champ `dataCategory` nullable en C2 (13 valeurs canoniques) |
| **SensitivityLevel** | Champ `sensitivityLevel` nullable en C2 (C0–C3) |
| **Tenant boundaries** | `tenant_id` dans toutes les contraintes UNIQUE |
| **Retention** | Skills : durée de vie + 5 ans d'audit (identique à C1) |
| **Secrets** | Aucun credential stocké ; `credentialRequirements` déclaratif seulement |
| **Provenance** | Obligatoire sur tout skill, immutable après import |
| **Audit** | Append-only, sans donnée sensible dans les détails |

### 23. Tests

#### Tests unitaires (sans Docker)

- **Lifecycle TrustState :** chaque transition autorisée/interdite, rejected terminal
- **Lifecycle ActivationState :** chaque transition autorisée/interdite, revoked terminal
- **Cross-invariant :** `activationState = active ⇒ trustState = approved` vérifié structurellement
- **Cross-invariant :** `trustState = rejected ⇒ activationState = revoked` dans le use case
- **Hash canonique :** même contenu → même hash ; contenu différent → hash différent
- **Hash déterministe :** ordre JSON différent → même hash (sérialisation canonique)
- **Hash exclusion :** `createdAt`, `trustState`, `activationState` PAS dans le hash
- **Immutabilité version :** mutation refusée en `approved` ou `rejected`
- **Immutabilité provenance :** pas de setter, pas d'update use case
- **Stale attestation :** `evaluatedContentHash ≠ contentHash` → promotion refusée
- **DataCategory :** valeurs correctes (PUBLIC, PERSONAL...) ; inversion détectée par Zod
- **SensitivityLevel :** valeurs correctes (C0–C3) ; inversion détectée par Zod
- **Permissions :** skills.read/propose/create/trust.write/activation.write/delete sans rôle hardcodé
- **HUMAN ONLY :** transitions reviewed→approved et inactive→active vérifient actorType

#### Tests intégration PostgreSQL (Testcontainers)

- `UNIQUE(tenant_id, skill_key, version)` rejette les doublons
- Partial unique index rejette un second ACTIF par skillKey
- Activation transactionnelle : FOR UPDATE verrouille les versions, ancienne désactivée
- Rejet atomique : `approved → rejected` produit `rejected + revoked`
- FK `ON DELETE RESTRICT` sur skills → scans/evals
- Scan passé sur hash AAA → ne permet PAS la promotion si hash BBB
- Content change → hash recalculé → trustState untrusted
- Audit : `skill.content_changed` sans donnée sensible
- Provenance : immuable en base via repository (pas de SET sur provenance dans les UPDATE)
- Tenants distincts : même skillKey dans deux tenants = deux lignes, pas de conflit

#### Tests sécurité

- Auto-approbation impossible (agent ≠ human actor)
- Auto-activation impossible (activation.write + HUMAN ONLY)
- Import → toujours untrusted, jamais auto-activé
- Content change sur approved → REFUSÉ (exception levée)
- Stale attestation → promotion bloquée
- Aucun credential dans le registre (test d'architecture : pas de champ credentialValue)

#### Tests concurrence

- Deux activations simultanées du même skillKey : une seule réussit (FOR UPDATE + partial index)
- Rejet et activation concurrents : le premier qui commit gagne
- Content update pendant scan : le scan devient stale, ne peut pas promouvoir

### 24. Définition de done — C2

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` passent
- [ ] Tests d'intégration PostgreSQL (Testcontainers) passent ou Docker indisponible signalé comme blocage
- [ ] Migration additive `0006` créée, n'affecte aucune table existante
- [ ] Les contrats Zod (`contracts/skill.ts`) sont la source unique de vérité
- [ ] Les permissions sont ajoutées à la matrice existante, sans référence à des rôles
- [ ] Le container de composition câble les repositories et le service
- [ ] Aucune donnée sensible dans les événements d'audit
- [ ] Aucun secret/credential dans le registre
- [ ] Hash canonique documenté + testé
- [ ] Toutes les transitions TrustState et ActivationState sont testées (y compris les interdites)
- [ ] Les cross-invariants sont testés
- [ ] L'immutabilité des versions est testée (mutable avant approved, immuable après)
- [ ] L'immutabilité de provenance est testée (domain-enforced)
- [ ] La STALE_ATTESTATION rule est testée
- [ ] Tests de concurrence (activation, rejet) avec PostgreSQL
- [ ] Aucune dépendance nouvelle
- [ ] Spec ci-présente respectée sans redécision architecturale pendant le code

## Hors périmètre

- L'Orchestrateur de sélection/exécution de skills (D2/D4)
- Le Tool Gateway et l'exécution d'outils (G1)
- L'intégration SkillSpector comme scanner (post-C2, derrière le port)
- La résolution et l'installation de dépendances de skills (D4)
- Les credentials réels et leur stockage (G1)
- L'implémentation du sandbox d'exécution (D4/G1)
- L'accès réseau effectif (G1)
- Le marketplace SkillsMP (C3)
- Les permissions effectives et la politique d'autorisation (D1)
- La matrice de rôles (2B-2 existant)
- Toute migration réelle, tout code sous `src/`, toute dépendance nouvelle
