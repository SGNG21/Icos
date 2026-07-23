# C1 — Capability Registry

## Statut et objectif

Conception validée par l'utilisateur (revue du 2026-07-23, 12 corrections
appliquées). Ce document décrit le modèle métier, la persistance, les
permissions, l'audit et les tests de C1 — le registre des Capacités ICOS.
**Aucune implémentation n'accompagne ce document** : aucune migration réelle,
aucun code sous `src/`, aucune dépendance nouvelle, aucun commit.

Modèle de référence : **Agent = QUI**, **Capability = QUOI**, **Skill =
COMMENT**, **Tool = AVEC QUOI**, **Policy = SI**. Une déclaration de
Capability n'est jamais elle-même une permission.

Les points dont la forme finale dépendait de l'intégration du Lot 2B-2
(`feat/user-agent-administration`, PR #10, fusionnée dans main au SHA
7b99c41) ont été vérifiés et marqués **`CONFIRMED`** ci-dessous.

## Contraintes invariantes

- Aucune modification sous `src/`, `drizzle/`, `package.json`,
  `pnpm-lock.yaml`, `CLAUDE.md`.
- Aucune migration réelle appliquée ; toute migration future est additive et
  numérotée à l'index réellement disponible au moment de l'implémentation
  (actuellement `0000`–`0004` sur main — le prochain index disponible est
  `0005`).
- Aucune dépendance nouvelle.
- Ne modifie ni PR #8 ni PR #9.
- C1 **n'implémente pas l'Orchestrateur** : seule une primitive pure de
  résolution d'usabilité est fournie (`resolveActiveCapability`).
- Toute capacité inconnue, non active, ou dont l'état ne peut être déterminé
  est traitée comme **inutilisable** (fail-closed) — jamais comme
  utilisable par défaut.
- Une capacité déclarée par ou assignée à un agent n'est jamais elle-même une
  autorisation d'exécution : `requiresHumanApproval` (D1) reste seul maître
  du risque réel et de l'approbation.

## Architecture retenue

### 1. Modèle métier — `Capability`

Le point de départ des 12 corrections est de **ne pas faire du `name` la
seule identité stable** (correction 1) et de **ne pas fixer le risque dans
Capability** (correction 2).

| Champ         | Type                                        | Remarques |
|---------------|----------------------------------------------|-----------|
| `id`          | `text` PK                                    | identifiant interne, généré, jamais réutilisé comme référence métier stable inter-domaines |
| `key`         | `text`, **unique, immuable après création**  | identifiant métier stable, ex. `code.review`, `code.write`, `crm.read` ; format proche de `idSchema` existant (`^[a-z0-9][a-z0-9_-]+$`, adapté avec un séparateur `.` pour les segments de domaine — à confirmer au moment du contrat Zod) |
| `name`        | `text`                                       | libellé humain **mutable** — jamais utilisé comme référence stable par Task/Agent/Skill |
| `description` | `text`, optionnel                            | |
| `category`    | `text`                                       | regroupement fonctionnel simple (ex. `code`, `data`, `communication`) — pas une taxonomie de risque |
| `status`      | `text` CHECK enum `proposed\|active\|deprecated\|retired` | état courant authoritatif — voir lifecycle |
| `provenance`  | `jsonb`, optionnel                           | traçabilité d'origine (ex. import, source), jamais interprétée comme autorisation |
| `riskHint`    | `text`, optionnel, **informationnel seul**   | jamais lu par une décision de permission ou de policy ; absence de valeur ≠ risque faible (voir invariants) |
| `createdAt`   | `timestamptz`                                | |
| `updatedAt`   | `timestamptz`                                | |

**Explicitement exclus du modèle** (et pourquoi) :

- `sensitive: boolean default false` — rejeté (correction 2) : crée une
  équivalence fausse Capability=Risque, entre en concurrence avec D1
  Policy/Approval v2, et surtout un défaut `false` n'est **pas** fail-closed.
  Le risque réel dépend de l'action, du contexte, de la donnée, de la cible,
  de l'effet externe — jamais de la capacité seule.
- `version` — voir §3 ci-dessous (correction 7).
- `inputSchema` / `outputSchema` — voir §3 ci-dessous (correction 7).
- `capability_status_history` (table séparée) — voir §2 ci-dessous
  (correction 3).

Toute référence future depuis Task, Agent ou Skill à une Capability utilise
l'`id` interne ou le `key` stable — **jamais** `name`/`displayName`.

### 2. Historique des transitions d'état

Correction 3 : ICOS possède déjà un Event/Audit Journal append-only
(`audit_entries`, garanti par trigger SQL `icos_forbid_audit_mutation`,
SQLSTATE `IC001`). Introduire une seconde table `capability_status_history`
créerait une seconde source de vérité pour la même information sans besoin
métier démontré.

**Décision retenue** : `capabilities.status` = état courant authoritatif ;
`audit_entries` (événement `capability.status_changed`) = historique
immuable des transitions. Aucune table `capability_status_history` n'est
créée. Si un besoin métier concret et démontré émerge plus tard
(ex. requête de reporting fréquente incompatible avec le format `details
jsonb` de l'audit), une table dédiée additive pourra être proposée à ce
moment — pas préventivement ici.

### 3. `version` / `inputSchema` / `outputSchema` — décision retenue

Correction 7 applique le test : *« Est-ce nécessaire pour C1 lui-même, ou
seulement pour C2/D2/D4 ? »*

- **`version`** : le versionnement pertinent porte sur le **Skill** qui
  implémente la Capability (COMMENT), pas sur la Capability elle-même
  (QUOI) — une Capability comme `code.review` reste stable conceptuellement
  même si le Skill qui la sert évolue. **Non retenu dans C1.** Si un besoin
  de version de Capability apparaît (ex. changement de contrat sémantique
  incompatible), il sera réévalué avec preuve à l'appui — hors périmètre
  actuel.
- **`inputSchema` / `outputSchema`** : utile comme contrat potentiel, mais
  aucun besoin C1 actuel ne le justifie — c'est un besoin de C2/D2/D4
  (sélection/exécution). Les ajouter maintenant reviendrait à construire C2
  à l'intérieur de C1. **Non retenus dans C1.**

Ce choix n'interdit pas leur ajout ultérieur par migration additive quand un
besoin concret de C2/D2/D4 l'exigera.

### 4. Relation Agent ↔ Capability — `agent_capabilities`

Correction 5 valide le principe : la relation est explicite et gouvernée,
mais **ne doit pas copier mécaniquement** `HumanAgentLink`. Vérification
faite : `human_agent_links` existe sur main (créée par la migration
`0004_new_white_tiger.sql` du Lot 2B-2) avec la forme suivante :

```
human_agent_links(id, human_user_id → user.id RESTRICT,
                   agent_id → agents.id RESTRICT,
                   relation CHECK IN ('supervisor','operator','observer'),
                   created_at, created_by_human_user_id → user.id RESTRICT)
UNIQUE(human_user_id, agent_id)
```

Cette table modélise une **supervision humain↔agent** (qui supervise qui).
L'assignation d'une Capability à un Agent est un concept métier différent :
« cet agent est autorisé/désigné pour porter cette capacité », sans notion
de supervision. Le modèle `agent_capabilities` est donc adapté, pas copié :

| Champ                | Type                                   | Remarques |
|----------------------|------------------------------------------|-----------|
| `id`                 | `text` PK                              | |
| `agentId`            | `text` → `agents.id` `ON DELETE RESTRICT` | |
| `capabilityId`       | `text` → `capabilities.id` `ON DELETE RESTRICT` | |
| `assignedAt`         | `timestamptz`                          | |
| `assignedByUserId`   | `text` → `user.id` `ON DELETE RESTRICT` | qui a décidé l'assignation — jamais l'agent lui-même |

`UNIQUE(agent_id, capability_id)`.

Invariants préservés :

- Agent → 0..N capacités ; Capability → assignable à 0..N agents.
- **Assignation ≠ permission.** Une ligne dans `agent_capabilities` ne
  confère aucune autorité d'exécution ; elle documente seulement quelles
  capacités sont reconnues à un agent, à vérifier par les policies (D1) au
  moment de la décision.
- **Aucune auto-attribution** : une capacité déclarée par un agent
  lui-même (via son propre code, un Tool, ou un Skill) n'est jamais
  automatiquement assignée — cf. `icos-security` : « une capacité déclarée
  est une exigence à vérifier, jamais un octroi ».
- La relation est authoritative en PostgreSQL (pas de cache, pas de
  déduction implicite depuis un autre champ).

Pas de champ `relation` de type supervision ici : la sémantique est
« assignation de capacité », pas « lien de supervision ».

### 5. API de la relation Agent ↔ Capability — `CONFIRMED`

Le modèle `agent_capabilities` ci-dessus ne suffit pas seul : son
administration nécessite un contrat d'API minimal. Proposition conceptuelle,
alignée sur les conventions confirmées du Lot 2B-2 (`agentLinks.read` /
`agentLinks.write`, routes `api/agents/[id]/...`) :

- `GET /api/agents/[id]/capabilities` — liste les capacités assignées à un
  agent. Permission indicative : `agentCapabilities.read`.
- `POST /api/agents/[id]/capabilities` — assigne une capacité existante à un
  agent (`capabilityId` dans le corps). Permission indicative :
  `agentCapabilities.write`.
- `DELETE /api/agents/[id]/capabilities/[capabilityId]` — révoque
  l'assignation. Permission indicative : `agentCapabilities.write`.

**`CONFIRMED`** : le chemin `api/agents/[id]/capabilities` est cohérent
avec les conventions du Lot 2B-2 fusionné (`api/agents/[id]/links`,
`api/users/[id]`, `api/tasks`, `api/actions`). Le nommage des permissions
(`agentCapabilities.read`, `agentCapabilities.write`) suit le modèle
resource-action granulaire confirmé (`users.read`, `users.create`,
`agentLinks.read`, etc.). L'administration complète (`GET`/`POST`/`DELETE`)
est du périmètre C1.

### 6. Permissions — `CONFIRMED`

Correction 4 : une permission unique `capabilities.manage` est trop large,
en particulier au vu du découpage déjà observé sur le Lot 2B-2 (constaté
directement dans son `permissions.ts` : `users.read` / `users.create` /
`users.role.write` / `users.status.write`, `agentLinks.read` /
`agentLinks.write` — un modèle par ressource et par action, jamais un
omnibus). Proposition conceptuelle à confirmer après fusion :

- `capabilities.read`
- `capabilities.create`
- `capabilities.status.write`
- `agentCapabilities.read`
- `agentCapabilities.write`

**`CONFIRMED`** : le modèle définitif du Lot 2B-2 fusionné utilise un
découpage resource-action granulaire (14 permissions, pas d'omnibus). Le
découpage proposé (`capabilities.read`, `capabilities.create`,
`capabilities.status.write`, `agentCapabilities.read`,
`agentCapabilities.write`) est cohérent et sera ajouté tel quel dans
`permissions.ts` lors de l'implémentation C1. Rôle minimal : `admin` pour
`capabilities.create`, `capabilities.status.write` et
`agentCapabilities.write` (gouvernance de la flotte d'agents) ;
`viewer` pour les permissions en lecture.

### 7. Lifecycle — transitions autorisées

Correction 8 : `proposed → active → deprecated → retired` est validé.
Règles de transition et d'utilisabilité (fail-closed) :

| État        | Sélectionnable pour nouvel usage | Références historiques |
|-------------|-----------------------------------|--------------------------|
| `proposed`  | **non**                           | n/a (jamais encore actif) |
| `active`    | **oui** — seul état sélectionnable | oui |
| `deprecated`| **non** (pas de nouvelle sélection) | **oui** — les références déjà existantes (ex. `agent_capabilities` déjà assignées, historique d'audit) restent valides et lisibles |
| `retired`   | **non**                           | oui, en lecture seule (audit) |

Transitions autorisées : `proposed → active`, `active → deprecated`,
`deprecated → active` (réactivation explicite, décision humaine),
`deprecated → retired`, `active → retired` (retrait direct, cas
exceptionnel). Transition interdite : tout retour depuis `retired` (état
terminal — une capacité retirée nécessite une nouvelle Capability si le
besoin métier ressurgit, jamais une résurrection de l'ancienne `key`).

Une capacité **inconnue** (aucune ligne trouvée pour un `key`/`id` donné) est
traitée strictement comme **inutilisable** — jamais comme équivalente à
`active` par absence d'information (fail-closed, cf. `icos-security`).

**C1 ne fournit pas l'Orchestrateur.** Elle fournit uniquement une primitive
pure :

```
resolveActiveCapability(key: string): { usable: true; capability: Capability }
                                     | { usable: false; reason: "unknown" | "not_active" }
```

Cette primitive ne décide d'aucune exécution ; elle répond uniquement à la
question « cette capacité est-elle actuellement utilisable ». L'Orchestrateur
(hors périmètre C1) consommera cette primitive plus tard.

### 8. Audit

Correction 9 : éviter les événements redondants. Événements retenus (à
ajouter à `auditEventTypeSchema` par future migration additive, suivant
exactement le motif DROP+ADD `CHECK` déjà utilisé par
`drizzle/0003_dark_logan.sql` sur `audit_event_type_check`) :

- `capability.created`
- `capability.updated` (changement de `name`/`description`/`category`/
  `provenance`/`riskHint` — hors changement de `status`)
- `capability.status_changed` (couvre toute transition de lifecycle, y
  compris le retrait — **`capability.retired` n'est pas ajouté séparément**,
  il serait redondant avec `capability.status_changed` transitionnant vers
  `retired`)
- `agent_capability.granted`
- `agent_capability.revoked`

Le Journal d'Événements (`audit_entries`) reste la seule vérité historique ;
aucune table de log parallèle n'est introduite pour ces événements.

## Persistance (conception, aucune migration réelle)

Conventions Drizzle confirmées sur `src/server/database/schema.ts` et
strictement respectées ci-dessous : `text("id").primaryKey()` (jamais
`uuid`), `CHECK` pour tout champ énuméré, FK toujours
`{ onDelete: "restrict" }`, `timestamp(..., { withTimezone: true }).notNull()`
partout, `unique(...)` et `index(...)` via les helpers Drizzle existants.

```ts
export const capabilities = pgTable(
  "capabilities",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category").notNull(),
    status: text("status").notNull(),
    provenance: jsonb("provenance"),
    riskHint: text("risk_hint"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("capabilities_key_unique").on(t.key),
    check(
      "capabilities_status_check",
      sql`${t.status} in ('proposed','active','deprecated','retired')`,
    ),
    index("capabilities_status_idx").on(t.status),
  ],
);

export const agentCapabilities = pgTable(
  "agent_capabilities",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    capabilityId: text("capability_id")
      .notNull()
      .references(() => capabilities.id, { onDelete: "restrict" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull(),
    assignedByUserId: text("assigned_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
  },
  (t) => [
    unique("agent_capabilities_agent_capability_unique").on(t.agentId, t.capabilityId),
    index("agent_capabilities_agent_idx").on(t.agentId),
    index("agent_capabilities_capability_idx").on(t.capabilityId),
  ],
);
```

Cette conception ne modifie aucun fichier réel ; elle documente la forme
attendue pour l'implémentation future (Task 2 du plan associé).

La migration additive future (numéro à déterminer au moment réel de
l'implémentation, après fusion éventuelle du Lot 2B-2) devra : créer les deux
tables ci-dessus, puis appliquer le motif DROP+ADD déjà utilisé par
`0003_dark_logan.sql` pour étendre `audit_event_type_check` avec les 4
nouveaux types d'événements listés en §8.

## Interface API prévue

Voir §5 (relation Agent↔Capability, `CONFIRMED`). Pour la Capability
elle-même (hors relation), contrat minimal envisagé (non détaillé ici tant
que non prioritaire pour C1) :

- `GET /api/capabilities` — liste, filtrable par `status`. Permission :
  `capabilities.read` (`CONFIRMED`).
- `POST /api/capabilities` — création (`status` initial toujours
  `proposed`). Permission : `capabilities.create` (`CONFIRMED`).
- `PATCH /api/capabilities/[id]/status` — transition de lifecycle
  uniquement (jamais de mutation directe de `status` via l'endpoint
  générique de mise à jour). Permission : `capabilities.status.write`
  (`CONFIRMED`).

Toute route suit l'ordre de vérification confirmé dans
`protect-route.ts` : container → session → permission → origine → corps
JSON → validation métier → exécution, et audite tout refus via
`appendSecurityAudit`.

## Erreurs publiques

Aucune erreur SQL brute, aucun détail de contrainte interne, aucun
`DATABASE_URL` ou stack trace exposé. Une transition de lifecycle invalide
retourne un refus typé (`invalid_transition`), jamais une erreur 500 brute.
Une capacité inconnue référencée par un `key` retourne `not_found`, jamais
un comportement silencieux équivalent à « utilisable ».

## Tests

Correction 10 : C1 ne contient pas encore l'Orchestrateur — ne pas fabriquer
un scénario complet de « sélection d'exécution » pour tester « capacité
désactivée → non sélectionnable ». Tester uniquement la primitive propre à
C1 :

### Tests unitaires

- `resolveActiveCapability("unknown.key")` → `{ usable: false, reason:
  "unknown" }`.
- `resolveActiveCapability(key)` pour une capacité `proposed`,
  `deprecated`, ou `retired` → `{ usable: false, reason: "not_active" }`.
- `resolveActiveCapability(key)` pour une capacité `active` → `{ usable:
  true, capability }`.
- Transitions de lifecycle : chaque transition autorisée réussit, chaque
  transition interdite (notamment tout départ depuis `retired`) est
  rejetée explicitement.
- `key` dupliqué à la création → refus typé (contrainte unique), jamais un
  écrasement silencieux.
- Assignation `agent_capabilities` dupliquée (même paire agent/capacité) →
  refus typé.

### Tests d'intégration PostgreSQL 16 réelle (Testcontainers)

- Contrainte `UNIQUE(key)` réellement appliquée en base.
- Contrainte `UNIQUE(agent_id, capability_id)` réellement appliquée en base.
- FK `ON DELETE RESTRICT` empêche la suppression d'un agent ou d'une
  capacité référencée par `agent_capabilities`.
- Écriture d'un `audit_entries` pour chaque transition de statut et pour
  `agent_capability.granted`/`revoked`, sans donnée sensible dans `details`.

## Hors périmètre

- L'Orchestrateur de sélection/exécution de capacités (C2 et suivants).
- `version`, `inputSchema`, `outputSchema` (voir §3) — non retenus tant
  qu'un besoin concret ne les justifie pas.
- `capability_status_history` en tant que table séparée (voir §2).
- Toute classification de risque authoritative portée par Capability (reste
  entièrement de la responsabilité de D1 Policy/Approval).
- ~~Le chemin exact et le nommage définitif des permissions et de l'API de la
  relation Agent↔Capability~~ — **`CONFIRMED`** (vérifié contre main/7b99c41,
  §5 et §6).
- Relation Skill↔Capability (mentionnée dans la mission d'origine comme
  « future ») — non modélisée ici, à traiter dans un lot dédié une fois le
  modèle Skill lui-même stabilisé.
- Toute migration réelle, tout code sous `src/`, toute dépendance nouvelle.
