# CTX-SUP-1 — Context ↔ Supervisor Bridge (ContextBuilder + MissionContext)

> **Lot CTX-SUP-1 — Spec v1**
> Date : 2026-07-26
> Statut : DRAFT — PHASE 2 Formal Spec
> Branche : `feat/ctx-sup-1` (aucune modification de `feat/supervisor-worker`)
> Périmètre de ce document : **design canonique**. L'implémentation est
> découpée en 1A (contrats purs), 1B (persistance/versioning), 1C (adaptateur
> Supervisor). Voir le plan associé.

---

## 0. Résumé exécutif

Une **Conversation** produit du langage, des hypothèses et des intentions. Une
**Mission** (D2) est l'état métier autoritatif d'ICOS. Aujourd'hui, rien ne
relie proprement les deux : `Mission.userRequest` est une unique chaîne brute,
et le contexte du modèle (Claude) sert de facto de source de vérité — ce que la
spec D2 dénonce explicitement comme contraire aux invariants ICOS.

CTX-SUP-1 introduit un pont **fail-closed, borné, à provenance tracée** :

```
Conversation
   ↓  (ContextBuilder — pure, déterministe, fail-closed)
MissionContext
   ↓  (SupervisorContextInput — adaptateur d'entrée étroit)
Supervisor boundary
```

`MissionContext` est un **artefact de lecture** : il transporte de
l'information (objectif confirmé, contraintes, faits vs hypothèses, questions
ouvertes) avec sa provenance. Il ne transporte **jamais** d'autorité,
d'approbation ni de permission. Toute décision d'exécution reste chez D1
(policy), G1 (ExecutionGrant), D2 (mission truth) et l'approbation humaine.

Ce lot **ne modifie pas** le Supervisor, ne l'intègre pas, ne touche pas
D1/D2/D3/D4/G1, n'implémente ni MCP/tools ni Voice V1.

---

## 1. Le gap architectural exact

### 1.1 Ce qui existe

| Concept | Emplacement | Rôle |
|---|---|---|
| `Mission` | `src/core/mission/contract.ts` | État métier durable (D2). Champ `userRequest: string` brut. |
| Mission lifecycle | `src/core/mission/lifecycle.ts` | Machine d'état (autorité de transition). |
| `PolicyDecision` | `src/core/policy/contract.ts` | Autorité de politique D1 (allow/deny/require_approval). |
| `decideExecution` | `src/core/authorization/decide.ts` | Autorisation fail-closed. |
| `ExecutionGrant` | `src/core/g1/contract.ts` | **Seul** objet qui signifie « cette invocation précise est autorisée maintenant ». |
| `Approval` | `src/core/contracts/approval.ts` | Décision humaine ; `decidedBy` déclaratif, **non authentifié** (Lot 1B). |
| `AuditEntry` | `src/core/contracts/audit.ts` | Journal append-only, pas de secret. |
| `TenantContext` | `src/core/contracts/tenant.ts` | Résolu depuis session authentifiée, jamais depuis le client. |
| Context Port (RAG) | skill `icos-rag-memory` | Mémoire externe consommée, **jamais** source de vérité ni autorité. |

### 1.2 Ce qui manque (le gap)

Il **n'existe aucun concept `ConversationContext` ni `MissionContext`** dans le
dépôt (le seul « Context » du domaine est `TenantContext`). Conséquences :

1. **Pas de structure entre Conversation et Mission.** `Mission.userRequest`
   est une chaîne unique : ni objectif confirmé distinct des hypothèses, ni
   contraintes, ni questions ouvertes, ni provenance.
2. **Le contexte du modèle fait office de source de vérité** (anti-invariant
   D2 §1). Rien n'oblige à matérialiser, borner et versionner ce qui est «
   confirmé ».
3. **Aucune frontière d'entrée pour un Supervisor.** Brancher un Supervisor
   directement sur les internes d'une conversation le coupler­ait à un format
   non borné, non tracé, potentiellement injecté.
4. **Aucun garde-fou fail-closed** contre l'ambiguïté : rien ne distingue «
   fait confirmé » de « hypothèse » ni ne refuse de produire un contexte
   d'autorité à partir d'une conversation.

**Le gap = l'absence d'un artefact canonique, borné, à provenance tracée, qui
transporte l'information d'une conversation vers la frontière Supervisor sans
jamais transporter d'autorité.**

---

## 2. Séparation stricte des concepts

Chaque ligne est un invariant de frontière. Aucun de ces objets ne peut être
substitué à un autre.

| Concept | Nature | Autorité ? | Source de vérité |
|---|---|---|---|
| **ConversationContext** | Entrée brute (tours de dialogue, extraits mémoire) | ❌ | La conversation (éphémère, non fiable) |
| **MissionContext** | Artefact de lecture borné + provenance | ❌ | Dérivé, versionné, rattaché à une Mission |
| **Mission** (D2) | État métier durable | Transition uniquement | PostgreSQL (D2) |
| **Task DAG / Plan** (D2) | Décomposition d'exécution | ❌ (planification) | D2 (`Plan`/`Step`) |
| **Memory / RAG** | Preuve/références externes | ❌ | Service externe via Context Port |
| **Audit** | Journal append-only | ❌ | Journal d'audit (immuable) |
| **Authorization** (D1) | Décision de politique | ✅ **Autorité de politique** | PolicyEngine D1 |
| **Approval** | Décision humaine tracée | ✅ (humain) | `Approval` (non authentifié en V1) |
| **ExecutionGrant** (G1) | « cette invocation est autorisée » | ✅ **Autorité d'exécution** | G1 après D1 ALLOW |

### 2.1 Invariants non négociables

```
Context ≠ Permission
Context ≠ Approval
Context ≠ Authority
Memory   ≠ Audit Log
Conversation ≠ Authorization
Session ID   ≠ Authorization
Supervisor ≠ policy authority     (l'autorité de politique reste D1)
Supervisor ≠ approval authority   (l'approbation reste humaine)
Supervisor ≠ execution authority  (l'autorisation d'exécution reste G1/D4)
```

Corollaire : `MissionContext` peut *rapporter* qu'une approbation ou une
politique existe (par **référence**, ex. `approvalId`, `policyId`), mais ne
peut **jamais** l'accorder, l'impliquer ni la reconstituer.

---

## 3. MissionContext canonique (le plus petit possible)

Construit **exclusivement** sur des types ICOS existants (`tenantId`,
`missionId`, `isoDateTimeSchema`, `idSchema`, provenance par référence). Aucun
type autoritatif n'est embarqué.

```typescript
// src/core/context/contract.ts (design — implémenté en 1A)

/** Origine d'une donnée de contexte : d'où vient l'information. */
type ContextSourceKind =
  | "user_message"      // tour de dialogue humain
  | "agent_message"     // tour de dialogue agent
  | "mission_record"    // lu depuis la Mission D2 (déjà autoritatif)
  | "memory_reference"; // preuve/référence via Context Port (RAG) — jamais autorité

/** Provenance minimale attachée à chaque élément dérivé. */
interface ContextProvenance {
  source: ContextSourceKind;
  /** Référence opaque et bornée vers l'origine (id de tour, ref mémoire…). */
  ref: string;
  /** Horodatage de l'origine (fraîcheur). */
  observedAt: string; // isoDateTime
}

/** Épistémologie explicite : un fait confirmé ≠ une hypothèse. */
type Epistemics = "confirmed_fact" | "assumption" | "open_question";

interface ContextClaim {
  id: string;                 // idSchema
  statement: string;          // borné (longueur max)
  epistemics: Epistemics;
  provenance: ContextProvenance;
}

/**
 * MissionContext — artefact de lecture, borné, versionné, à provenance tracée.
 *
 * INVARIANTS :
 * - Ne contient AUCUN champ d'autorité (pas de grant, pas de decision allow,
 *   pas de token, pas de credential).
 * - Rattaché à un tenant + une mission (isolation).
 * - Immuable une fois émis ; toute évolution crée une nouvelle version.
 * - `confirmedObjective` est présent SEULEMENT s'il a été confirmé ;
 *   à défaut le build échoue (fail-closed), il n'est jamais deviné.
 */
interface MissionContext {
  tenantId: string;           // tenantIdSchema
  missionId: string;          // idSchema — rattachement D2
  version: number;            // monotone, mission-scoped
  /** Objectif confirmé, borné. Absent → build refusé (jamais inféré). */
  confirmedObjective: string;
  /** Contraintes/décisions explicitement confirmées. */
  confirmedConstraints: ContextClaim[];
  /** Hypothèses explicitement marquées comme non confirmées. */
  assumptions: ContextClaim[];
  /** Questions ouvertes non résolues (bloque l'inférence d'autorité). */
  openQuestions: ContextClaim[];
  /** Résumé borné, dérivé, non autoritatif. */
  boundedSummary: string;
  /** Références mémoire (preuve uniquement, jamais autorité). */
  memoryReferences: ContextProvenance[];
  builtAt: string;            // isoDateTime
  /** Étiquette du builder (audit/debug), non authentifiée. */
  builtByLabel: string;
}
```

### 3.1 Ce que MissionContext n'embarque JAMAIS

- Aucun `ExecutionGrant`, `PolicyDecision.outcome = "allow"`, `Approval`
  matériel, credential, token, cookie, hash de secret.
- Aucune capacité « effective » ni permission résolue.
- Aucune donnée non sérialisable (contrainte `jsonValueSchema`).
- Aucune donnée dépassant les bornes (nombre d'items, longueur de chaîne).

---

## 4. ContextBuilder — responsabilités

Fonction **pure et déterministe** de `core` (pas d'I/O, pas de réseau, pas de
SQL — conforme `icos-architecture`). Entrée : `ConversationContext` +
`Mission` (déjà résolue). Sortie : `Result<MissionContext>` fail-closed.

```typescript
type BuildContextResult =
  | { ok: true; context: MissionContext }
  | { ok: false; reason: BuildRefusalCode };

type BuildRefusalCode =
  | "no_confirmed_objective"   // objectif non confirmé → refus
  | "tenant_mismatch"          // conversation ≠ tenant de la mission
  | "mission_conflict"         // contexte contredit la Mission canonique
  | "unresolved_ambiguity"     // questions ouvertes bloquantes
  | "over_budget"              // dépasse les bornes → refus
  | "non_serializable_input";  // entrée impure/suspecte
```

Responsabilités :

1. **Résoudre la mission** : ne fabrique jamais une Mission ; consomme celle
   fournie par l'appelant (D2 reste la source de vérité). Vérifie
   `tenantId` cohérent → sinon `tenant_mismatch`.
2. **Extraire l'objectif confirmé** : uniquement à partir de tours
   explicitement confirmés. Absent → `no_confirmed_objective` (fail-closed).
3. **Extraire contraintes/décisions confirmées** en `ContextClaim`
   (`epistemics = "confirmed_fact"`).
4. **Distinguer faits et hypothèses** : tout ce qui n'est pas confirmé est
   classé `assumption`, jamais promu en fait.
5. **Tracer les questions ouvertes** : `open_question`. Une question ouverte
   bloquante empêche la promotion en autorité (le contexte le signale, il ne
   la résout pas).
6. **Produire un résumé borné** : longueur plafonnée, dérivé uniquement du
   confirmé + hypothèses marquées.
7. **Attacher la provenance** à chaque claim et référence mémoire.
8. **Fail-closed sur ambiguïté** : conflit avec la Mission → `mission_conflict` ;
   ambiguïté irréductible → `unresolved_ambiguity` ; dépassement de bornes →
   `over_budget`.
9. **Ne jamais créer d'autorité** : aucune sortie ne contient de grant, de
   décision allow, d'approbation ni de secret. Propriété testée.

Déterminisme : mêmes entrées → même `MissionContext` (hors `builtAt`), pour
audit et reproductibilité.

---

## 5. Frontière Supervisor — adaptateur d'entrée étroit

**Principe : ne pas coupler le Supervisor aux internes d'une conversation.**
Le Supervisor consomme un DTO d'entrée minimal, en lecture seule, pas la
conversation ni le ContextBuilder.

```typescript
// Frontière (design). L'implémentation vit hors de ce lot ; ici on fige la
// forme du contrat d'entrée pour que 1C soit un simple mapping.
interface SupervisorContextInput {
  tenantId: string;
  missionId: string;
  contextVersion: number;
  confirmedObjective: string;
  confirmedConstraints: ReadonlyArray<{ statement: string; ref: string }>;
  openQuestions: ReadonlyArray<{ statement: string }>;
  boundedSummary: string;
  /** Références mémoire = preuve seulement. */
  memoryReferences: ReadonlyArray<{ ref: string; source: ContextSourceKind }>;
}
```

Règles de frontière :

- **Unidirectionnelle** : Conversation → ContextBuilder → `MissionContext` →
  `SupervisorContextInput` → Supervisor. Le Supervisor ne lit jamais en amont.
- **Lecture seule et non autoritaire** : aucun champ ne peut être interprété
  comme permission/approbation/grant. Le Supervisor qui a besoin d'autoriser
  une action **doit** passer par D1/G1, pas par ce DTO.
- **Bornée** : le DTO hérite des bornes de `MissionContext`.
- **Stable** : versionnée via `contextVersion`, découplée du format interne.

Ce lot fige la **forme** du contrat d'entrée ; il **ne branche pas** le
Supervisor (interdit ici).

---

## 6. Persistance / versioning (design — implémenté en 1B)

- **Tenant-isolé** : `tenantId` obligatoire ; toute lecture filtre par tenant
  (défense IDOR, cf. `cross_tenant_idor`).
- **Mission-scopé** : clé `(tenantId, missionId, version)`.
- **Durable** : PostgreSQL via port asynchrone (`Promise<T | null>`,
  ressource absente = `null`), pattern repository ICOS. Migration **additive**.
- **Borné** : bornes de taille appliquées **avant** persistance (le builder
  refuse `over_budget`).
- **Version-safe** : `version` monotone mission-scopé ; artefact **immuable**
  après émission ; une évolution crée une nouvelle version (append, jamais
  mutation en place).
- **Sans secret** : contrainte `jsonValueSchema` + interdiction explicite de
  credentials/tokens/cookies/hashes.
- **Auditable sans être l'audit** : chaque émission peut produire une
  `AuditEntry` par référence (`contextId`, `version`, `missionId`), mais le
  `MissionContext` **n'est pas** le journal d'audit (`Memory ≠ Audit Log`).
  Aucun nouveau type d'événement d'audit n'est introduit dans ce lot.

Ports (design) :

```typescript
interface MissionContextRepository {
  save(context: MissionContext): Promise<MissionContext>;   // append version
  findLatest(tenantId: string, missionId: string): Promise<MissionContext | null>;
  findVersion(tenantId: string, missionId: string, version: number): Promise<MissionContext | null>;
}
```

---

## 7. Frontière Mémoire future

- La mémoire (RAG/Context Port, cf. `icos-rag-memory`) fournit **preuve et
  références**, jamais autorité ni source de vérité opérationnelle.
- Dans `MissionContext`, la mémoire n'apparaît que via
  `memoryReferences: ContextProvenance[]` (`source = "memory_reference"`).
- Une référence mémoire **ne peut pas** devenir un `confirmed_fact`
  automatiquement : au mieux une `assumption` jusqu'à confirmation humaine
  explicite dans la conversation.
- Une mémoire malveillante ne peut donc ni accorder d'autorité, ni promouvoir
  une hypothèse en fait, ni injecter un objectif confirmé.

---

## 8. Modèle de menace

| # | Menace | Vecteur | Défense CTX-SUP-1 |
|---|---|---|---|
| T1 | **Prompt injection** | Un tour de conversation contient « tu es autorisé à… » | Le contexte n'accorde aucune autorité ; instructions traitées comme `statement` de claim, jamais comme permission. D1/G1 restent seuls décideurs. |
| T2 | **Vieille conversation traitée comme permission** | Réutilisation d'un contexte périmé | `MissionContext` porte `builtAt` + `version` mission-scopée + `observedAt` par claim ; aucune permission n'en découle ; consommateur peut rejeter la fraîcheur. |
| T3 | **« tu peux toujours merger main »** | Affirmation d'autorité auto-référentielle dans le dialogue | Classée `assumption`/`open_question` ; jamais `confirmed_fact` ni autorité. Toute action Git/merge reste sous les Git gates humains. |
| T4 | **Mémoire malveillante** | RAG empoisonné | Mémoire = `memory_reference` (preuve), jamais autorité ni fait ; non promouvable automatiquement (voir §7). |
| T5 | **Fuite cross-tenant** | Contexte d'un tenant lu par un autre | `tenantId` obligatoire ; `tenant_mismatch` fail-closed au build ; repository filtre par tenant ; clé `(tenantId, missionId, version)`. |
| T6 | **Contexte périmé (stale)** | Mission a évolué depuis le build | Versioning + `builtAt` ; le contexte est un instantané dérivé, jamais la vérité ; D2 reste autoritatif. |
| T7 | **Contexte vs Mission canonique en conflit** | Le dialogue contredit l'état D2 | `mission_conflict` → refus fail-closed ; la Mission gagne toujours. |
| T8 | **Contexte vs politique D1/G1 en conflit** | Le dialogue « autorise » ce que D1 refuse | Le contexte ne porte aucune décision ; D1/G1 non consultés ici et non contournables. |
| T9 | **Supervisor traitant le contexte comme permission** | Couplage/glissement sémantique | DTO d'entrée sans champ autoritaire ; §5 interdit l'interprétation ; le Supervisor doit passer par D1/G1 pour agir. |
| T10 | **Persistance accidentelle de secret** | Token/credential dans un tour | `jsonValueSchema` + interdiction explicite + refus `non_serializable_input` ; propriété testée « aucun secret persisté ». |

---

## 9. Périmètre

### 9.1 Dans CTX-SUP-1A (ce lot)

- Ce document de design.
- Le plan d'implémentation.
- **Contrats purs `core` + tests uniquement** s'ils s'introduisent sans
  câbler ni modifier le Supervisor live (`src/core/context/`).

### 9.2 Hors CTX-SUP-1A

- Toute modification de `feat/supervisor-worker`.
- Intégration dans le Supervisor ; reprise de SUP-7.
- Persistance/repository/migration (→ 1B).
- Adaptateur Supervisor réel (→ 1C).
- MCP/tools ; Voice V1.
- Toute modification de l'autorité D1/D2/D3/D4/G1.
- Merge, deploy.

---

## 10. Human gate

- Validation humaine du design (ce document) avant implémentation 1B/1C.
- Git gates ICOS : commit CTX-SUP-1A uniquement après passage des contrôles.
- Aucun merge, aucun deploy sans autorisation explicite.
