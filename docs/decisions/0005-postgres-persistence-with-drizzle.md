# ADR-0005 — Persistance PostgreSQL avec Drizzle (Lot 2A-2a)

- Statut : accepté (sous-lot 2A-2a)
- Date : 2026-07-22

## Contexte

Le Lot 2A-1 a rendu les ports d'accès asynchrones. Le Lot 2A-2a pose la
fondation PostgreSQL : schéma, migrations, client, mappings et repositories de
base, avec tests d'intégration réels. Les implémentations in-memory restent en
place et par défaut. Le câblage du container PostgreSQL et la transaction de
décision relèvent du Lot 2A-2b.

## Décision

- **Stack** : `drizzle-orm@0.45.2` + driver `postgres@3.4.9` ; migrations via
  `drizzle-kit@0.31.10` (SQL lisible, revu) ; tests d'intégration via
  `@testcontainers/postgresql@12.0.4` (avec `testcontainers` transitif). Versions
  épinglées exactement ; aucune beta/RC. Compatibilité vérifiée (Node 24, TS 6,
  Next 16, Vitest 4, pnpm 11) — `typecheck` vert sous TypeScript 6.
- **Approbation de builds** : `esbuild` (requis par drizzle-kit) activé dans
  `pnpm-workspace.yaml` ; `cpu-features`, `ssh2`, `protobufjs` (transitifs
  optionnels de Testcontainers) explicitement désactivés (repli JS, Docker via
  socket local).
- **Schéma** (`src/server/database/schema.ts`) : tables `agents`, `tasks`,
  `actions`, `approvals`, `audit_entries` ; `CHECK` sur les enums et
  `authorization_level BETWEEN 0 AND 3` ; `UNIQUE(action_id)` sur `approvals` ;
  FK toutes `ON DELETE RESTRICT` ; `timestamptz` ; `details jsonb`.
- **Source unique tâche↔actions** : `actions.task_id`. `Task.actionIds` n'est PAS
  persisté ; il est **dérivé en lecture** (`SELECT id FROM actions WHERE task_id`).
- **Divergences de nommage documentées** :
  - `actions.created_at` porte la valeur métier `AgentAction.requestedAt` ;
  - `actions.updated_at` est une métadonnée de traçage de statut, non surfacée ;
  - `approvals.decided_by_label` ↔ `Approval.decidedBy` ;
  - `audit_entries.actor_type/actor_label` ↔ `AuditEntry.actor.{kind,id}`.
    Aucune colonne métier forward-compat inutilisée n'a été ajoutée : `execution_status`
    a été **écarté** (absent du contrat `AgentAction` fusionné).
- **Mapping** (`mappers.ts`) : lignes converties vers les contrats et **revalidées
  par Zod** (`safeParse`) ; une ligne invalide lève `RepositoryMappingError`
  (jamais un retour silencieux) ; les contrats n'importent pas Drizzle.
- **Repositories** (`repositories/postgres/*`) : implémentent exactement les ports
  fusionnés. `create`/`transition` des tâches écrivent la ligne et son audit dans
  une **transaction** unique (atomicité). L'`AuditRepository` n'expose **ni update
  ni delete** (garde applicative ; la protection SQL par trigger arrive en 2A-2b).
- **Client** (`client.ts`) : `createDatabase(url)` (postgres.js + Drizzle),
  connexion paresseuse, `close()` pour les tests ; runtime Node.js ; jamais
  importé côté client.
- **Migrations** : schéma dans `src/server/database/schema.ts`, migrations SQL
  dans `drizzle/`, config `drizzle.config.ts`. Scripts `db:generate`, `db:migrate`.
  Une migration appliquée ne se modifie jamais : toute correction est une nouvelle
  migration. `drizzle/` est exclu de Prettier (artefacts générés).
- **Tests** : `pnpm test` reste **sans Docker** (les `*.integration.test.ts` sont
  exclus) ; `pnpm test:integration` (config dédiée) démarre un conteneur
  PostgreSQL, applique les migrations depuis une base vide, isole par `TRUNCATE`,
  ferme conteneur et client, et **se saute si Docker est absent**.

## Conséquences

- Aucune connexion n'est établie tant que `PERSISTENCE=memory` (le module client
  n'est instancié que par le futur container PostgreSQL, Lot 2A-2b).
- Le Lot 2A-2b ajoutera : UoW transactionnel `FOR UPDATE`, câblage du container
  PostgreSQL, tests de concurrence/rollback, et la protection append-only par
  trigger SQL. La gestion fine des privilèges du rôle applicatif viendra avec le
  déploiement.
