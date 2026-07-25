# COMPLIANCE-1 — Automated Compliance Checks, Schema Classification & Tenant Foundation

> **Lot** : COMPLIANCE-1
> **Phase** : Transverse — hard gate avant D1 (Policy Engine v2)
> **Statut** : SPEC — avant implémentation
> **Base SHA** : `700290a`
> **Branche** : `feat/compliance-1-classification`
> **Documents sources** : `ICOS_COMPLIANCE_ROADMAP.md` §3, `ICOS_COMPLIANCE_TESTS.md` §3+§5,
>   `docs/decisions/0023-compliance-foundation.md`, `docs/architecture/future/04-lot-sequence.md`,
>   `docs/architecture/future/03-critical-path.md`

---

## 1. Scope

| # | Requirement | Source |
|:---|:---|:---|
| A | Drizzle schema `@classification C2/C3` markers + CI validation gate | Roadmap §3.1 |
| B | `dataClassification` obligatoire sur toute Capability publiée | Roadmap §3.2 |
| C | C3 Capability ne peut atteindre un état utilisable sans retention policy | Roadmap §3.2 |
| D | Secret scanning CI gate (pattern-matching, pas scanner complet) | Roadmap §3.3 |
| E | Tenant Foundation — contexte canonique, résolution, scoping, tests | Compliance tests §5 (001, 011) |

## 2. Non-scope

- Multi-organization UX, tenant switching, billing, subscriptions — **OUT**
- RLS PostgreSQL généralisée — **OUT** (app-level scoping)
- SSO, domain mapping, enterprise invitations — **OUT**
- Refonte des tables globales (agents, tasks, actions, approvals, user) — **OUT**
- Fake observability layer pour passer scénario 015 — **OUT**
- Fake memory layer pour passer scénario 003 — **OUT**
- `app DB role cannot TRUNCATE audit` (scénario 010) — **DEFERRED** (nécessite infra PostgreSQL, pas de code applicatif pertinent ici)
- Observability C3 redaction (scénario 015) — **DEFERRED** vers lot qui introduit réellement l'observability
- AUTH_SECRET never memory (scénario 003) — **DEFERRED** vers lot Memory/E1

## 3. Terminology

| Term | Definition |
|:---|:---|
| **DataCategory** | Classification fonctionnelle des données (PUBLIC, INTERNAL, PERSONAL, etc.) |
| **SensitivityLevel** | Niveau de sensibilité (C0, C1, C2, C3) — distinct de DataCategory |
| **C2 data** | Données confidentielles (tokens, clés API, secrets d'infrastructure) |
| **C3 data** | Données personnelles restreintes (email, nom, téléphone, historique) |
| **TenantContext** | Identité de tenant validée, résolue depuis le contexte authentifié |
| **CURRENT_SINGLE_TENANT_ID** | = `"default"` — shim C2 à remplacer par TenantContext canonique |

## 4. DataCategory / SensitivityLevel interaction

C2 a déjà introduit les deux champs optionnels sur la table `skills` :
- `dataCategory` ∈ {PUBLIC, INTERNAL, PERSONAL, SENSITIVE_PERSONAL, ...}  
- `sensitivityLevel` ∈ {C0, C1, C2, C3}

Les deux sont indépendants mais complémentaires :
- `sensitivityLevel = C3` reste l'indicateur primaire pour les contrôles techniques (retention, chiffrement)
- `dataCategory` donne le contexte fonctionnel (PERSONAL vs FINANCIAL vs HEALTH)

**Règle** : si `sensitivityLevel = C3`, alors `dataCategory` doit être défini et ne peut pas être `PUBLIC` ni `INTERNAL`.

## 5. Schema Classification Convention

### 5.1 Format

Commentaires Drizzle placés au début de chaque définition de colonne, avant la déclaration de type :

```typescript
export const someTable = pgTable("some_table", {
  email: text("email").notNull(), // @classification C3
  apiKey: text("api_key"), // @classification C2
  name: text("name").notNull(), // @classification C3
});
```

### 5.2 Tables concernées

Tables existantes avec données potentiellement C2/C3 (à marquer) :

| Table | Colonnes C2 | Colonnes C3 |
|:---|:---|:---|
| `user` (auth-schema) | — | `email`, `name` |
| `agents` | — | `description` |
| `human_agent_links` | — | — |
| `tasks` | — | `title`, `description` |
| `actions` | — | — |
| `approvals` | — | `reason` |
| `audit_entries` | `details` | — |
| `capabilities` | — | `description` |
| `skills` | `content_hash` | `name`, `description` |
| `skill_security_scans` | `metadata` | — |
| `skill_security_findings` | — | `message` |
| `skill_evaluations` | `metadata`, `score` | — |

**Note** : le marquage est une annotation pour la revue humaine + CI. Il n'a pas d'effet runtime direct dans COMPLIANCE-1. Les contrôles d'accès effectifs (chiffrement, masquage) sont pour COMPLIANCE-2.

### 5.3 CI validation

Une script de validation (`scripts/validate-classification-markers.ts`) :
1. Parse les fichiers `src/server/database/schema.ts` et `auth-schema.ts`
2. Vérifie que toute colonne avec un commentaire `@classification C3` ou `@classification C2` a effectivement le type attendu
3. Ne bloque pas les colonnes C0/C1 — seul le manque de marquage sur une colonne C2/C3 est détecté comme anomalie potentielle

Ce script est exécuté :
- Par `pnpm compliance:check` (nouvelle commande)
- Dans la CI, sur les fichiers modifiés par la PR
- **Ne remplace pas** la gate humaine CT-DOC-05

### 5.4 Tests

- `CT-AUTO-01` — fixture avec colonne C3 non marquée → CI échoue
- `CT-AUTO-02` — fixture avec tout marqué correctement → CI passe
- `CT-AUTO-03` — validation que les colonnes réelles du schéma sont marquées

## 6. Capability Classification

### 6.1 Modèle

Ajouter `dataClassification` (`DataCategory` optionnel) et `sensitivityLevel` (`SensitivityLevel` optionnel) au schéma `capabilities` :

```typescript
export const capabilitySchema = z.object({
  // ... existing fields
  sensitivityLevel: sensitivityLevelSchema.optional(),
  dataCategory: dataCategorySchema.optional(),
});
```

### 6.2 Validation

- `createCapability` : si `sensitivityLevel` est fourni, persister ; sinon `undefined`
- `changeCapabilityStatus(status → "active")` :
  - **Nouveau** : si `sensitivityLevel = C3` et aucune `retentionPolicyRef` associée → refuse avec `reason: "retention_policy_required"`
  - Sinon → comportement existant inchangé

### 6.3 Retention policy contract

La retention n'est pas implémentée comme table complète (c'est COMPLIANCE-2). Pour COMPLIANCE-1, nous définissons le **contrat** :

```typescript
// Contrat déclaratif : la Capability C3 nécessite une référence de retention.
// L'implémentation complète (purge, expiration) est COMPLIANCE-2.
export interface RetentionPolicyRef {
  /** Durée de conservation maximale en jours */
  maxRetentionDays: number;
  /** Base légale RGPD (ex: "consent", "contract", "legal_obligation", "legitimate_interest") */
  legalBasis: string;
  /** Description de la finalité du traitement */
  purpose: string;
}

// Validateur Zod
export const retentionPolicyRefSchema = z.object({
  maxRetentionDays: z.number().int().positive(),
  legalBasis: z.enum(["consent", "contract", "legal_obligation", "legitimate_interest"]),
  purpose: z.string().min(1),
});
```

Cette ref est portée par la Capability comme champ optionnel, vérifié lors de l'activation.

### 6.4 Migration

Migration additive `0007_compliance_1_classification.sql` :
- `ALTER TABLE capabilities ADD COLUMN sensitivity_level text`
- `ALTER TABLE capabilities ADD COLUMN data_category text`
- `ALTER TABLE capabilities ADD COLUMN retention_policy_ref jsonb`
- `ALTER TABLE capabilities ADD CHECK (sensitivity_level IS NULL OR sensitivity_level IN ('C0','C1','C2','C3'))`
- `ALTER TABLE capabilities ADD CHECK (data_category IS NULL OR data_category IN (...))`

### 6.5 Tests

- `CAP-CLASS-01` — créer capability sans classification → accepté
- `CAP-CLASS-02` — créer capability avec sensitivityLevel=C3 → accepté
- `CAP-CLASS-03` — activer capability C3 sans retentionPolicyRef → refusé
- `CAP-CLASS-04` — activer capability C3 avec retentionPolicyRef → accepté
- `CAP-CLASS-05` — activer capability C0/C1/C2 sans retentionPolicyRef → accepté (inchangé)
- `CAP-CLASS-06` — reclassification auditable

## 7. Secret Scanning CI Gate

### 7.1 Design

Un script de validation simple (`scripts/scan-secrets.ts`) qui pattern-matche sur les fichiers modifiés :

```typescript
// Patterns détectés (fichiers .ts, .tsx, .js, .env*, .json, .yml, .yaml, .sql)
const SECRET_PATTERNS = [
  /(['"`])[A-Za-z0-9+/]{40,}\1/,               // token 40+ chars (GitHub, etc.)
  /sk-[A-Za-z0-9]{20,}/,                        // OpenAI/Supabase-style keys
  /AKIA[0-9A-Z]{16}/,                           // AWS access key
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, // Private keys
  /ghp_[A-Za-z0-9]{36,}/,                       // GitHub PAT
  /gho_[A-Za-z0-9]{36,}/,                        // GitHub OAuth
  /ghu_[A-Za-z0-9]{36,}/,                        // GitHub user token
];
```

**Ce n'est pas un scanner de sécurité complet.** Les patterns sont intentionnellement limités pour éviter les faux positifs excessifs. L'outil est un *early-warning CI gate*, pas un remplacement de `git secrets`, `trufflehog` ou d'un SAST.

### 7.2 Exclusions

- Fichiers de fixtures de test explicites (dans `src/server/database/testing/`)
- Fichiers avec `// @secret-scanner-ignore` en commentaire d'header
- Fichiers `.test.ts` standards (mais pas leurs fixtures)

### 7.3 Failure behavior

- Exit code non-nul, message listant chaque match avec fichier:ligne
- Exécuté par `pnpm compliance:scan-secrets`
- Dans la CI, uniquement sur les fichiers modifiés par la PR (pas un scan total du repo)

### 7.4 Tests

- Fichier fixture avec token factice → détecté
- Fichier fixture avec `@secret-scanner-ignore` → ignoré
- Fichier propre → passe

## 8. Tenant Foundation

### 8.1 TenantContext model

```typescript
// src/core/contracts/tenant.ts

import { z } from "zod";

/**
 * Identifiant de tenant validé.
 * Ne jamais accepter une valeur non validée provenant du client.
 */
export const tenantIdSchema = z.string().min(1).max(128);

export type TenantId = z.infer<typeof tenantIdSchema>;

/**
 * Contexte de tenant authentifié et validé.
 *
 * L'invariant critique est :
 *   CLIENT-SUPPLIED TENANT ID ≠ AUTHENTICATED TENANT CONTEXT
 *
 * TenantContext est toujours résolu depuis le contexte authentifié
 * (session utilisateur), jamais depuis le body, query, path ou header
 * non signé de la requête.
 */
export const tenantContextSchema = z.object({
  tenantId: tenantIdSchema,
  resolvedAt: z.string().datetime(),
  resolvedBy: z.string(), // ex: "auth", "system"
});

export type TenantContext = z.infer<typeof tenantContextSchema>;

/**
 * Résultat de résolution de tenant.
 * FAIL_CLOSED : si aucun tenant valide n'est résolu, le résultat est
 * un échec — pas de fallback vers "default".
 */
export type TenantResolution =
  | { ok: true; context: TenantContext }
  | { ok: false; reason: "no_tenant" | "invalid_tenant" | "resolution_error" };
```

### 8.2 TenantResolutionPort — résolution canonique

```typescript
// src/server/tenant/ports.ts

import type { TenantContext, TenantResolution } from "@/core/contracts/tenant";

/**
 * Port de résolution du tenant courant.
 * L'implémentation actuelle est mono-tenant (single tenant résolu depuis
 * la session auth). L'interface reste stable pour le futur multi-tenant.
 */
export interface TenantResolutionPort {
  /**
   * Résout le TenantContext pour une requête/session donnée.
   * 
   * Pour le mode mono-tenant actuel : le tenant est dérivé de la session
   * utilisateur, ou du mode d'exécution (système, migration).
   * 
   * @param context - Contexte de résolution (session, headers, mode)
   * @returns TenantContext validé, ou échec (fail-closed)
   */
  resolve(context: TenantResolutionRequest): Promise<TenantResolution>;
  
  /**
   * Vérifie que la ressource appartient bien au tenant courant.
   * @returns true si la ressource est accessible dans le contexte tenant
   */
  ownsResource(tenantId: TenantId, resourceOwnerId: string): boolean;
}

export interface TenantResolutionRequest {
  /** Session utilisateur authentifiée (peut être absente pour les opérations système) */
  session?: { userId: string };
  /** Headers de la requête HTTP */
  headers?: Headers;
  /** Mode d'exécution spécial (system, migration, test) */
  executionMode?: "normal" | "system" | "migration" | "test";
}

export interface TenantResource {
  /** Identifiant du tenant propriétaire de la ressource */
  ownerTenantId: string;
}
```

### 8.3 Implémentation mono-tenant

```typescript
// src/server/tenant/single-tenant-resolver.ts

import type { TenantContext, TenantResolution, TenantId } from "@/core/contracts/tenant";
import type { TenantResolutionPort, TenantResolutionRequest } from "./ports";

/**
 * Résolveur mono-tenant pour COMPLIANCE-1.
 * 
 * Tous les utilisateurs authentifiés appartiennent au même tenant unique.
 * Le tenantId est résolu depuis la session auth, pas depuis une input client.
 * 
 * Migration depuis CURRENT_SINGLE_TENANT_ID :
 * - Les constantes globales sont remplacées par ce résolveur
 * - Le TenantId canonique reste "default" pour la compatibilité avec les
 *   données C2 existantes
 * - Mais le *chemin de résolution* est désormais explicite et gouverné
 */
export class SingleTenantResolver implements TenantResolutionPort {
  private readonly TENANT_ID: TenantId = "default" as TenantId;

  async resolve(request: TenantResolutionRequest): Promise<TenantResolution> {
    // Modes spéciaux (système, migration) — pas de session requise
    if (request.executionMode === "system" || request.executionMode === "migration") {
      return {
        ok: true,
        context: {
          tenantId: this.TENANT_ID,
          resolvedAt: new Date().toISOString(),
          resolvedBy: request.executionMode,
        },
      };
    }

    // Mode test — pas de session requise non plus
    if (request.executionMode === "test") {
      return {
        ok: true,
        context: {
          tenantId: this.TENANT_ID,
          resolvedAt: new Date().toISOString(),
          resolvedBy: "test",
        },
      };
    }

    // Mode normal : une session est requise
    if (!request.session) {
      return { ok: false, reason: "no_tenant" };
    }

    // Ici, en mode mono-tenant, tout utilisateur authentifié est résolu
    // vers le tenant unique. En multi-tenant futur, la résolution irait
    // chercher le tenantId dans le profil utilisateur.
    return {
      ok: true,
      context: {
        tenantId: this.TENANT_ID,
        resolvedAt: new Date().toISOString(),
        resolvedBy: "auth",
      },
    };
  }

  ownsResource(tenantId: TenantId, resourceOwnerId: string): boolean {
    return tenantId === resourceOwnerId;
  }
}
```

### 8.4 Repository boundaries — IDOR COMBLE

#### 8.4.1 Design Review Finding : IDOR gaps dans C2

La revue de sécurité a identifié des **méthodes repository sans tenantId** qui constituent des vecteurs IDOR :

| Méthode | Problème | Correctif |
|:---|:---|:---|
| `SkillRepository.getById(id)` | Pas de filtre tenant → tenant B peut lire skill A par ID | Ajouter param `tenantId` + `WHERE tenantId = ? AND id = ?` |
| `SkillRepository.updateTrustState(id, state)` | Pas de filtre tenant → mise à jour cross-tenant possible | Ajouter param `tenantId` + `WHERE` |
| `SkillRepository.updateActivationState(id, state)` | Pas de filtre tenant | Ajouter param `tenantId` + `WHERE` |
| `SkillRepository.delete(id)` | Suppression cross-tenant possible | Ajouter param `tenantId` + `WHERE` |
| `SkillRepository.updateContent(id, data)` | Pas de filtre tenant ; `tenantId` mis à "" dans l'appel interne | Ajouter param `tenantId` + `WHERE` + ne pas écraser tenantId |
| `SkillSecurityScanRepository.findValidForHash(skillId, hash)` | Pas de tenantId | Ajouter param `tenantId` + `WHERE` |
| `SkillSecurityScanRepository.listBySkill(skillId)` | Pas de tenantId échappatoire | Ajouter param `tenantId` + `WHERE` |
| `SkillEvaluationRepository.findValidForHash(skillId, hash)` | Pas de tenantId | Ajouter param `tenantId` + `WHERE` |
| `SkillEvaluationRepository.listBySkill(skillId)` | Pas de tenantId | Ajouter param `tenantId` + `WHERE` |

#### 8.4.2 Changements de signature

Les interfaces `SkillRepository`, `SkillSecurityScanRepository`, `SkillEvaluationRepository` et leurs implémentations sont modifiées pour inclure `tenantId` dans toutes les méthodes qui opèrent par ID. La modif est rétrocompatible (le paramètre est requis).

```typescript
// Après COMPLIANCE-1
export interface SkillRepository {
  getById(tenantId: string, id: string): Promise<Skill | null>;
  updateTrustState(tenantId: string, id: string, trustState: string): Promise<Skill | null>;
  updateActivationState(tenantId: string, id: string, activationState: string): Promise<Skill | null>;
  updateContent(tenantId: string, id: string, data: ...): Promise<Skill | null>;
  delete(tenantId: string, id: string): Promise<boolean>;
  // Les méthodes avec tenantId existant restent inchangées
  getByKeyAndVersion(tenantId: string, ...): Promise<Skill | null>;
  getActiveVersion(tenantId: string, ...): Promise<Skill | null>;
  list(tenantId: string, ...): Promise<Skill[]>;
  deactivateIfActive(tenantId: string, ...): Promise<string | null>;
}

export interface SkillSecurityScanRepository {
  findValidForHash(tenantId: string, skillId: string, contentHash: string): Promise<...>;
  listBySkill(tenantId: string, skillId: string): Promise<SecurityScan[]>;
}

export interface SkillEvaluationRepository {
  findValidForHash(tenantId: string, skillId: string, contentHash: string): Promise<...>;
  listBySkill(tenantId: string, skillId: string): Promise<Evaluation[]>;
}
```

#### 8.4.3 Propagation service

`SkillService` reçoit `TenantContext` dans ses méthodes qui font confiance à l'ID :

```typescript
class SkillService {
  async getSkill(tenantId: string, id: string): Promise<...> {
    const skill = await this.skills.getById(tenantId, id);
    if (!skill) return { ok: false, reason: "not_found", ... };
    return { ok: true, data: { skill } };
  }
  
  // Même pattern pour transitionTrust, transitionActivation, 
  // updateSkillContent, deleteSkill, recordScan, recordEval
}
```

Les routes API reçoivent `tenantId` depuis `TenantResolutionPort.resolve()` et le passent au service.

### 8.5 Routes — tenant injection pattern

Toute route C2 existante qui utilise `CURRENT_SINGLE_TENANT_ID` est migrée vers le résolveur :

```typescript
// Avant (C2)
import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity/tenant";
const TENANT_ID = CURRENT_SINGLE_TENANT_ID;

// Après (COMPLIANCE-1)
import { createTenantResolver } from "@/server/tenant/single-tenant-resolver";
const resolver = createTenantResolver();

// Dans la route handler :
const tenantResolution = await resolver.resolve({ session: access.session });
if (!tenantResolution.ok) {
  return json({ error: "no_tenant", message: "Impossible de résoudre le tenant" }, { status: 403 });
}
const { tenantId } = tenantResolution.context;
// → utiliser tenantId dans les appels repository
```

**Principe** : le tenantId n'est jamais lu depuis le body, query, path ou header. Il est exclusivement résolu via `TenantResolutionPort`.

### 8.6 Cross-tenant IDOR prevention

Deux couches :

1. **Au niveau API** : le tenantId fourni par le client (body, query, path) est ignoré pour les requêtes tenant-scoped. Seul le `TenantContext` résolu depuis l'auth fait foi.

2. **Au niveau repository** : les méthodes existantes prennent déjà un `tenantId` explicite. Aucune méthode ne permet de l'omettre. En cas d'ID tenté sur un tenant différent, la requête ne retourne aucun résultat (comportement existant des FK + filtres).

3. **Audit de denial** : si un IDOR est détecté (tentative d'accès à une ressource d'un autre tenant), l'audit enregistre l'événement sans fuiter le contenu ou l'existence exacte de la ressource cible. Le message d'erreur est uniforme : `not_found` ou `forbidden`, jamais `"resource exists but not yours"`.

### 8.7 CURRENT_SINGLE_TENANT_ID strategy

1. **Supprimer** l'export constant de `src/core/identity/tenant.ts`
2. **Remplacer** les imports par l'utilisation du `TenantResolutionPort`
3. La constante `"default"` survit uniquement comme valeur de configuration dans `SingleTenantResolver`
4. Toute opération C2 existante (skills, scans, evals) doit passer par la résolution tenant

**Ne pas remplacer** une constante globale par une autre constante globale ailleurs. Le changement est structurel : le tenantId passe par un port, pas par une importation.

### 8.8 Default tenant fallback — FAIL CLOSED

- `SingleTenantResolver.resolve({})` sans session → `{ ok: false, reason: "no_tenant" }`
- Aucun fallback silencieux vers `"default"` pour une requête authentifiée normale
- Les modes `system` et `migration` sont explicitement déclarés, pas de magie

### 8.9 Container wiring

```typescript
// Ajouter dans Container
tenantResolver: TenantResolutionPort;

// Dans buildMemoryContainer :
tenantResolver: new SingleTenantResolver(),

// Dans buildPostgresContainer :
tenantResolver: new SingleTenantResolver(),
```

## 9. Scenarios mapping

| ID | Scenario | Status | COMPLIANCE-1 action |
|:---|:---|:---|:---|
| 001 | Tenant isolation | **IN SCOPE** | TenantContext + scoping + tests TENANT-01..10 |
| 011 | Cross-tenant IDOR denial | **IN SCOPE** | Validation ownership + audit denial sans fuite |
| 010 | App DB role cannot TRUNCATE audit | **DEFERRED** | Infra PostgreSQL, pas de code applicatif pertinent ici. Documenter comme DEFERRED. |
| 015 | Observability C3 redaction | **DEFERRED** | Aucun système d'observability actif. DEFERRED vers lot qui l'introduit. |
| 003 | AUTH_SECRET never memory | **DEFERRED** | Memory n'existe pas encore. DEFERRED vers E1. |

## 10. Compliance tests mapping

| Test | Status | Component |
|:---|:---|:---|
| CT-AUTO-01 | **IN SCOPE** | Capability classification validation |
| CT-AUTO-02 | **IN SCOPE** | C3 + retention policy requirement |
| CT-AUTO-03 | **IN SCOPE** | Reclassification audit trail |
| CT-AUTO-06 | **IN SCOPE** | Tenant denial audit |
| CT-AUTO-08 | **PARTIAL** | Secret scanning couvre une partie ; observability redaction deferred |
| CT-AUTO-09 | **COVERED BY EXISTING** | Auth déjà requise pour les routes protégées |
| CT-AUTO-10 | **COVERED BY EXISTING** | Permissions déjà vérifiées par protectRoute |

## 11. Migration strategy

Migration additive uniquement :
- `0007_compliance_1_classification.sql` — ajout colonnes capabilities

Aucune migration de données existante modifiée.
Aucune suppression de colonne.
Aucun changement de contrainte sur des données existantes.

## 12. Backward compatibility

- Toutes les Capabilities existantes (sans `sensitivityLevel`/`dataCategory`) continuent de fonctionner
- L'absence de classification n'est pas un blocage pour le statut existant
- Seule l'activation d'une Capability **nouvellement classifiée C3** sans retention est refusée
- `CURRENT_SINGLE_TENANT_ID` peut être retiré après migration des routes vers `TenantResolutionPort`
- Les données C2 existantes avec `tenantId = "default"` restent valides

## 13. Failure modes

| Scenario | Behavior |
|:---|:---|
| TenantContext non résolu | `{ ok: false, reason: "no_tenant" }` → HTTP 403 |
| Route tenant-scoped sans resolver | Error lors de l'appel (container mal configuré) |
| Tentative IDOR | Retourne `not_found` (pas d'info sur l'existence) |
| C3 capability sans retention | `changeCapabilityStatus` refuse avec `retention_policy_required` |
| Secret scan trouve un match | CI fail, message listant le fichier:ligne |
| Erreur de parsing Drizzle | CI fail avec message explicite |

## 14. Concurrency

- `changeCapabilityStatus` utilise déjà `expectedStatus` pour la version optimiste (C1 UoW pattern)
- Tenant resolution est stateless (ne nécessite pas de transaction)
- Les accès concurrents tenant A/B ne partagent pas leur contexte (résolu par requête)

## 15. Tests

### Tenant tests

| ID | Description | Verification |
|:---|:---|:---|
| TENANT-01 | Tenant A peut accéder à sa ressource tenant-scoped | Créer skill pour tenant A → la retrouver par tenantId |
| TENANT-02 | Tenant A ne peut pas lire ressource tenant B | Query avec tenant A sur tenantId B → 0 résultats |
| TENANT-03 | Tenant A ne peut pas modifier ressource tenant B | Update avec tenant A scope → erreur ou 0 modifié |
| TENANT-04 | tenantId fourni par client ne remplace pas le contexte | Route reçoit query param tenantId=X → ignoré, utilise contexte auth |
| TENANT-05 | Ressource inconnue ne fuite pas d'info exploitable | ID inexistant ou autre tenant → même message d'erreur |
| TENANT-06 | Repository query contient le tenantId canonique | Vérifier la requête SQL exécutée (spy/mock) |
| TENANT-07 | Pas de tenant → denial | `SingleTenantResolver.resolve({})` → `{ ok: false }` |
| TENANT-08 | C2 skill API utilise TenantContext | Route skills → résolution tenant, pas CURRENT_SINGLE_TENANT_ID |
| TENANT-09 | Requêtes concurrentes A/B isolées | Async test avec deux résolutions parallèles |
| TENANT-10 | Audit denial ne fuite pas le contenu étranger | Vérifier les détails de l'audit entry en cas de denial |

### Classification tests

| ID | Description |
|:---|:---|
| CT-AUTO-01 | Capability C3 sans retention → refusée |
| CT-AUTO-02 | Capability C3 avec retention → acceptée |
| CT-AUTO-03 | Schema classification marker validation |
| CT-AUTO-06 | Tenant denial audit entry |

## 16. Design Review Checklist

- [ ] Tenant spoofing : impossible car le tenantId vient du résolveur, pas du client
- [ ] IDOR : les repositories C2 prennent déjà tenantId comme paramètre
- [ ] Privilege escalation : aucun changement de permission dans ce lot
- [ ] Global-vs-tenant resource ambiguity : agents, tasks, actions, approvals restent globales
- [ ] `CURRENT_SINGLE_TENANT_ID` leakage : remplacé par le résolveur dans toutes les routes
- [ ] Accidental default tenant fallback : `resolve({})` → fail, pas de fallback silencieux
- [ ] Migration holes : additive uniquement, colonnes NULL-safe
- [ ] C1 compatibility : Capability schema étendu, pas modifié
- [ ] C2 compatibility : tenantId paramètre déjà présent dans les ports
- [ ] Audit information leakage : denial → `not_found` uniforme
- [ ] Fail-open behavior : résolution échouée → 403, pas de bypass
- [ ] Secrets in fixtures/logs : secret scan les détecte, patterns explicites
