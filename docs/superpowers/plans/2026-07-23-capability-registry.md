# Lot C1 — Capability Registry Implementation Plan

> **REQUIRED SUB-SKILL: superpowers:subagent-driven-development**
>
> Ce plan est écrit pour une future exécution par un agent implémenteur. Il
> n'a fait l'objet d'aucune exécution dans la mission qui l'a produit :
> aucun commit, aucune migration réelle, aucune modification sous `src/`.
> Chaque case à cocher ci-dessous est une instruction pour l'agent qui
> implémentera ce lot plus tard, pas une action déjà réalisée.

## Goal

Fournir un registre PostgreSQL authoritatif des Capacités ICOS (`capabilities`)
et de leur assignation aux agents (`agent_capabilities`), avec une primitive
pure de résolution d'usabilité (`resolveActiveCapability`), sans introduire
d'Orchestrateur ni de classification de risque dans la Capability elle-même.

## Architecture

Persistance PostgreSQL via Drizzle (schéma additif, conventions identiques au
reste d'ICOS : `text id` PK, `CHECK` sur les enums, FK `RESTRICT`,
`timestamptz`). Contrats Zod dans `core/contracts/capability.ts`. Repository
ports suivant le style de `server/repositories/ports.ts`. Services purs dans
`core/` pour le lifecycle (`resolveActiveCapability`, validation des
transitions), sans dépendance à la couche HTTP. Routes API suivant le motif
`protectRoute` déjà en place pour `api/agents`.

## Tech Stack

Drizzle ORM 0.45.2, drizzle-kit 0.31.10, postgres.js 3.4.9,
@testcontainers/postgresql 12.0.4 (tests uniquement), PostgreSQL 16, Zod 4,
Next.js 16 route handlers (`runtime = "nodejs"`, `dynamic = "force-dynamic"`).
Aucune dépendance nouvelle.

## Global Constraints

- Aucune modification sous `drizzle/` avant ce lot : la migration créée ici
  est **additive**, numérotée à l'index réellement disponible au moment de
  l'implémentation (vérifier `drizzle/` et l'état du Lot 2B-2 avant de
  choisir le numéro — ne pas assumer un numéro fixe).
- Aucune migration déjà appliquée n'est modifiée.
- `capabilities.status` est la seule source authoritative de l'état courant ;
  aucune table `capability_status_history` n'est créée (cf. design §2).
- Aucun champ de risque authoritatif sur `capabilities` (pas de `sensitive`,
  pas de classification) — voir design §1.
- Pas de `version`/`inputSchema`/`outputSchema` sur `capabilities` — voir
  design §3.
- `key` est unique et immuable après création ; `name` n'est jamais utilisé
  comme référence stable.
- Toute ligne lue est revalidée par Zod `safeParse` (`RepositoryMappingError`
  sinon).
- Ordre de vérification HTTP : container → session → permission → origine →
  corps JSON → validation métier → exécution (suivre `protect-route.ts`).
- Les permissions exactes (`capabilities.read/create/status.write`,
  `agentCapabilities.read/write`) et le chemin API de la relation
  Agent↔Capability sont **`CONFIRMED`** : vérifiés contre main/7b99c41
  (Lot 2B-2 fusionné), alignés sur le modèle resource-action granulaire
  (14 permissions, pas d'omnibus). Rôle minimal : `admin` pour
  `capabilities.create`, `capabilities.status.write` et
  `agentCapabilities.write` (gouvernance de la flotte d'agents) ;
  `viewer` pour les lectures.
- L'implémentation ne fournit **pas** l'Orchestrateur : seule la primitive
  `resolveActiveCapability` est fournie.

## File Map

**Create:**

- `src/core/contracts/capability.ts` — schémas Zod `capabilitySchema`,
  `capabilityStatusSchema`, `agentCapabilitySchema`.
- `src/core/capabilities/lifecycle.ts` — `isTransitionAllowed(from, to)`,
  `resolveActiveCapability(key, lookup)`.
- `src/core/ordering.ts` (modification, voir Modify) — `compareCapabilities`.
- `src/server/repositories/capability-ports.ts` — `CapabilityRepository`,
  `AgentCapabilityRepository` (ports).
- `src/server/repositories/memory/capability-repository.ts` — implémentation
  mémoire.
- `src/server/repositories/postgres/capability-repository.ts` —
  implémentation Postgres.
- `src/server/repositories/memory/agent-capability-repository.ts`
- `src/server/repositories/postgres/agent-capability-repository.ts`
- `src/server/services/capability-service.ts` — cas d'usage : créer,
  changer de statut, assigner/révoquer.
- `src/app/api/capabilities/route.ts` — `GET`/`POST`.
- `src/app/api/capabilities/[id]/status/route.ts` — `PATCH` (transition
  uniquement).
- `src/app/api/agents/[id]/capabilities/route.ts` — `GET`/`POST`
  (**`CONFIRMED`** : chemin cohérent avec `api/agents/[id]/links` du Lot
  2B-2).
- `src/app/api/agents/[id]/capabilities/[capabilityId]/route.ts` — `DELETE`
  (**`CONFIRMED`**).
- `drizzle/000X_capability_registry.sql` — migration additive (numéro réel à
  déterminer à l'implémentation).
- Fichiers de test correspondants sous `tests/` (unitaires + intégration),
  suivant la convention existante du dépôt.

**Modify:**

- `src/server/database/schema.ts` — ajout des tables `capabilities` et
  `agent_capabilities` (voir design, section Persistance).
- `src/core/contracts/audit.ts` — extension de `auditEventTypeSchema` avec
  `capability.created`, `capability.updated`, `capability.status_changed`,
  `agent_capability.granted`, `agent_capability.revoked`.
- `src/core/contracts/index.ts` — export du nouveau `capability.ts`.
- `src/core/identity/permissions.ts` — ajout des permissions
  **`CONFIRMED`** (`capabilities.read`, `capabilities.create`,
  `capabilities.status.write`, `agentCapabilities.read`,
  `agentCapabilities.write`) — vérifiées contre le modèle définitif du Lot
  2B-2 fusionné (resource-action granulaire, 14 permissions existantes).
- `src/core/ordering.ts` — ajout de `compareCapabilities` (par `createdAt`
  ASC, `id` ASC, cohérent avec les autres comparateurs).
- `src/server/container.ts` — exposition de `capabilities` et
  `agentCapabilities` dans l'interface `Container`, câblage mémoire/Postgres.

## Task 1: Contrats Zod et modèle de lifecycle

**Files:**

- Create: `src/core/contracts/capability.ts`
- Create: `src/core/capabilities/lifecycle.ts`
- Test: `tests/core/capabilities/lifecycle.test.ts`

**Interfaces:**

- Produced: `capabilitySchema`, `capabilityStatusSchema` (enum
  `proposed|active|deprecated|retired`), `agentCapabilitySchema`.
- Produced: `isTransitionAllowed(from: CapabilityStatus, to: CapabilityStatus): boolean`.
- Produced: `resolveActiveCapability(key: string, lookup: (key: string) => Promise<Capability | null>): Promise<{ usable: true; capability: Capability } | { usable: false; reason: "unknown" | "not_active" }>`.

- [ ] **Step 1: Write failing tests** pour `isTransitionAllowed` (toutes les
      transitions autorisées/interdites du design §7, y compris qu'aucune
      transition ne part de `retired`) et pour `resolveActiveCapability`
      (`unknown`, `not_active` pour chaque statut non-`active`, `usable:true`
      pour `active`).
- [ ] **Step 2: Run tests** (`pnpm test tests/core/capabilities/lifecycle.test.ts`) — doivent échouer (fichiers non créés).
- [ ] **Step 3: Implement** `capability.ts` et `lifecycle.ts`.
- [ ] **Step 4: Run tests** — doivent passer.
- [ ] **Step 5: Commit** `git add src/core/contracts/capability.ts src/core/capabilities/lifecycle.ts tests/core/capabilities/lifecycle.test.ts && git commit -m "feat: define capability contract and lifecycle primitive"`

## Task 2: Schéma Drizzle et migration additive

**Files:**

- Modify: `src/server/database/schema.ts`
- Modify: `src/core/contracts/audit.ts`
- Create: `drizzle/000X_capability_registry.sql` (numéro réel à déterminer)
- Test: `tests/server/database/schema-capability.integration.test.ts`

**Interfaces:**

- Produced: tables Drizzle `capabilities`, `agentCapabilities` (voir design,
  section Persistance, pour le détail exact des colonnes/contraintes).
- Produced: extension `auditEventTypeSchema` avec les 5 nouveaux types
  (design §8).

- [ ] **Step 1: Write failing integration test** (Testcontainers) vérifiant
      que `UNIQUE(key)`, `UNIQUE(agent_id, capability_id)`, et les FK
      `RESTRICT` sont bien appliquées, et que les CHECK de statut/événement
      rejettent une valeur hors énumération.
- [ ] **Step 2: Run** (nécessite Docker) — doit échouer (tables absentes).
- [ ] **Step 3: Implement** le schéma dans `schema.ts`, générer la migration
      via `pnpm db:generate` (jamais modifier une migration déjà appliquée),
      puis appliquer le motif DROP+ADD déjà utilisé par
      `drizzle/0003_dark_logan.sql` pour étendre `audit_event_type_check`.
- [ ] **Step 4: Run** l'intégration — doit passer.
- [ ] **Step 5: Commit** `git add src/server/database/schema.ts src/core/contracts/audit.ts drizzle/ tests/server/database/schema-capability.integration.test.ts && git commit -m "feat: add capability registry schema"`

## Task 3: Repository ports et implémentations mémoire/Postgres

**Files:**

- Create: `src/server/repositories/capability-ports.ts`
- Create: `src/server/repositories/memory/capability-repository.ts`
- Create: `src/server/repositories/postgres/capability-repository.ts`
- Create: `src/server/repositories/memory/agent-capability-repository.ts`
- Create: `src/server/repositories/postgres/agent-capability-repository.ts`
- Modify: `src/core/ordering.ts`
- Test: `tests/server/repositories/capability-repository.test.ts` (mémoire +
  intégration Postgres réelle, jamais remplacée par un mock pour la partie
  intégration)

**Interfaces:**

- Produced: `CapabilityRepository` (`getById`, `getByKey`, `list`, `create`,
  `updateStatus`) — retour `Promise<Capability | null>` jamais `undefined`.
- Produced: `AgentCapabilityRepository` (`listByAgent`, `grant`, `revoke`).
- Produced: `compareCapabilities` dans `ordering.ts`.

- [ ] **Step 1: Write failing tests** pour chaque méthode des deux
      repositories (mémoire d'abord, puis les mêmes scénarios contre
      Postgres réel via Testcontainers), incluant le cas de revalidation Zod
      d'une ligne invalide (`RepositoryMappingError`).
- [ ] **Step 2: Run** — doit échouer.
- [ ] **Step 3: Implement** les ports et les deux implémentations, plus
      `compareCapabilities`.
- [ ] **Step 4: Run** — doit passer (mémoire sans Docker, intégration avec
      Docker ; ne jamais présenter l'intégration comme réussie si elle a été
      ignorée faute de Docker).
- [ ] **Step 5: Commit** `git add src/server/repositories src/core/ordering.ts tests/server/repositories/capability-repository.test.ts && git commit -m "feat: implement capability repositories"`

## Task 4: Service métier (cas d'usage) et audit

**Files:**

- Create: `src/server/services/capability-service.ts`
- Test: `tests/server/services/capability-service.test.ts`

**Interfaces:**

- Produced: `createCapability(input)`, `changeCapabilityStatus(id, target)`,
  `grantCapability(agentId, capabilityId, byUserId)`,
  `revokeCapability(agentId, capabilityId)` — chacun écrivant l'événement
  d'audit correspondant (design §8) via `AuditRepository.append`, jamais de
  donnée sensible dans `details`.

- [ ] **Step 1: Write failing tests** : création avec `key` dupliqué →
      refus typé ; transition interdite → refus typé ; transition autorisée
      → `status_changed` audité ; assignation dupliquée → refus typé ;
      assignation/révocation → événements `granted`/`revoked` audités sans
      donnée sensible.
- [ ] **Step 2: Run** — doit échouer.
- [ ] **Step 3: Implement** le service, en s'appuyant sur les ports du Task 3
      et sur `resolveActiveCapability`/`isTransitionAllowed` du Task 1.
- [ ] **Step 4: Run** — doit passer.
- [ ] **Step 5: Commit** `git add src/server/services/capability-service.ts tests/server/services/capability-service.test.ts && git commit -m "feat: implement capability service with audited transitions"`

## Task 5: Permissions et câblage du container — `CONFIRMED`

**Files:**

- Modify: `src/core/identity/permissions.ts`
- Modify: `src/server/container.ts`
- Test: `tests/core/identity/permissions.test.ts` (extension)

**Interfaces:**

- Produced: permissions `capabilities.read`, `capabilities.create`,
  `capabilities.status.write`, `agentCapabilities.read`,
  `agentCapabilities.write` — **`CONFIRMED`** contre main/7b99c41 (Lot 2B-2
  fusionné). Découpage resource-action granulaire validé, cohérent avec les
  14 permissions existantes.
- Produced: `Container.capabilities`, `Container.agentCapabilities`.

- [x] **Step 0 (préalable obligatoire)** : ~~relire `feat/user-agent-administration`~~ **`CONFIRMED`** : main/7b99c41 vérifié, permissions `CONFIRMED` dans le design §6.
- [ ] **Step 1: Write failing tests** pour chaque nouvelle permission
      (rôle minimal requis, héritage correct).
- [ ] **Step 2: Run** — doit échouer.
- [ ] **Step 3: Implement** l'ajout des permissions et le câblage du
      container (mémoire + Postgres).
- [ ] **Step 4: Run** — doit passer.
- [ ] **Step 5: Commit** `git add src/core/identity/permissions.ts src/server/container.ts tests/core/identity/permissions.test.ts && git commit -m "feat: wire capability permissions and container"`

## Task 6: Routes API — `CONFIRMED` pour la relation Agent↔Capability

**Files:**

- Create: `src/app/api/capabilities/route.ts`
- Create: `src/app/api/capabilities/[id]/status/route.ts`
- Create: `src/app/api/agents/[id]/capabilities/route.ts`
- Create: `src/app/api/agents/[id]/capabilities/[capabilityId]/route.ts`
- Test: `tests/app/api/capabilities.test.ts`, `tests/app/api/agent-capabilities.test.ts`

**Interfaces:**

- Produced: routes suivant exactement le motif de
  `src/app/api/agents/route.ts` (`runtime = "nodejs"`,
  `dynamic = "force-dynamic"`, `protectRoute`, `toErrorResponse`).
- Consumed: `capability-service.ts` (Task 4), permissions (Task 5).

- [ ] **Step 1: Write failing HTTP tests** pour chaque route : refus typés
      (`unauthenticated`, `session_expired`, `account_disabled`,
      `forbidden`, `cross_origin`) avant tout succès ; succès nominal pour
      chaque méthode.
- [ ] **Step 2: Run** — doit échouer.
- [ ] **Step 3: Implement** les routes.
- [ ] **Step 4: Run** — doit passer.
- [ ] **Step 5: Note explicite** : le chemin et les permissions de la
      relation Agent↔Capability sont **`CONFIRMED`** (vérifiés contre
      main/7b99c41). Les routes `GET`/`POST`/`DELETE` sont du périmètre
      complet de C1.
- [ ] **Step 6: Commit** `git add src/app/api/capabilities src/app/api/agents tests/app/api/capabilities.test.ts tests/app/api/agent-capabilities.test.ts && git commit -m "feat: expose capability and agent-capability routes"`

## Task 7: Push et pull request sans fusion

- [ ] `git branch --show-current`
- [ ] `git status`
- [ ] `git log --oneline main..HEAD`
- [ ] `git push -u origin <branch>`
- [ ] `gh pr create --title "feat: C1 capability registry" --body "..."`
- [ ] `gh pr view`
- [ ] **Ne jamais fusionner** sans autorisation explicite de l'utilisateur.

## Self-review

- **Couverture** : chaque table, permission et route a un test écrit avant
  implémentation (TDD strict) ; intégration Postgres réelle jamais
  remplacée par un mock.
- **Types** : `pnpm typecheck` doit passer sans `any` non justifié ; tout
  retour de repository est `Promise<T | null>`, jamais `undefined`.
- **Scope** : aucun champ de risque, version, ou schema d'E/S ajouté à
  `capabilities` sans besoin C1 démontré ; aucune table d'historique
  redondante avec `audit_entries` ; aucune permission omnibus si un
  découpage granulaire est confirmé possible après le Lot 2B-2.
- **Exécution** : ce plan n'a fait l'objet d'aucune exécution dans la
  mission qui l'a produit — toutes les cases ci-dessus sont pour un futur
  agent implémenteur, avec autorisation explicite avant tout commit/push.
