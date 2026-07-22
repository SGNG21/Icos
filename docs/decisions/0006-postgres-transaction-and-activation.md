# ADR-0006 — Transaction PostgreSQL et activation du backend (Lot 2A-2b)

- Statut : accepté
- Date : 2026-07-22

## Contexte

Le Lot 2A-2a a posé la fondation PostgreSQL (schéma, migrations, repositories,
mappings) sans la câbler. Le Lot 2A-2b rend `PERSISTENCE=postgres` réellement
utilisable, avec une décision atomique et un durcissement append-only, tout en
conservant le backend in-memory par défaut.

## Décision

- **Tri déterministe partagé** (`src/core/ordering.ts`) : comparateurs appliqués
  aux deux backends — agents `authorizationLevel DESC, id ASC` ; tasks/actions
  `createdAt|requestedAt ASC, id ASC` ; approvals `decidedAt ASC, id ASC` ; audit
  `occurredAt ASC, id ASC`. Les horodatages sont comparés par instant pour
  coïncider avec l'ordre `timestamptz`. Parité memory ↔ postgres testée. Les
  agents n'ont pas d'horodatage : tri par niveau d'autorisation puis id.
- **UoW PostgreSQL** (`PostgresActionDecisionUnitOfWork`) derrière le port
  existant. Transaction Drizzle : `SELECT … FOR UPDATE` (`.for("update")`)
  verrouille l'action, revérifie existence/statut non terminal/absence
  d'approbation, insère l'approbation, met à jour l'action, insère l'audit, puis
  commit — ou rollback complet. La concurrence est gérée par le verrou + la
  contrainte `UNIQUE(action_id)` (ceinture-bretelles).
- **Mapping d'erreurs** : Drizzle enveloppe les erreurs postgres.js ; le SQLSTATE
  est lu en déroulant `cause` (`sqlStateOf`). `23505` sur
  `approvals_action_id_unique` → `already_decided` ; deadlock/sérialisation
  (`40001`/`40P01`) → `TransientConflictError` → HTTP 503 `transient_conflict`
  (+ `Retry-After: 1`, aucun retry serveur) ; connexion (`08*`/`57P0x`) →
  `PersistenceUnavailableError` → HTTP 503 `persistence_unavailable`. Aucun
  détail SQL/URL/hôte/secret n'est exposé.
- **Append-only SQL** (migration `0001_append_only_audit.sql`, `0000` inchangée) :
  fonction `icos_forbid_audit_mutation()` + trigger `audit_entries_append_only`
  `BEFORE UPDATE OR DELETE` levant un `SQLSTATE 'IC001'` (classe non réservée).
  Les triggers ROW ne se déclenchent pas sur `TRUNCATE` : l'isolation des tests
  reste fonctionnelle. Le repository d'audit n'expose ni update ni delete.
- **Container PostgreSQL** : un unique client partagé par les 5 repositories et
  l'UoW. `createContainer` (postgres) exige `DATABASE_URL`, crée le client
  paresseusement, **sonde connexion + schéma**, et échoue proprement sinon —
  **jamais de fallback mémoire**. Les migrations ne sont pas appliquées au
  démarrage (commande explicite `pnpm db:migrate`). `resetContainer()` ferme le
  pool (tests). Une initialisation rejetée purge le cache global.

## Conséquences

- `PERSISTENCE=memory` n'ouvre aucune connexion (le module client n'est pas
  instancié). `loadEnv()` est réellement utilisé pour la composition PostgreSQL.
- Les contrats HTTP publics et les 6 routes sont inchangés ; seuls deux codes
  d'erreur 503 sont ajoutés, mappés via un helper central (`toErrorResponse`).
- Tests : `pnpm test` reste sans Docker (tri, chemins d'erreur, 503) ;
  `pnpm test:integration` couvre migrations 0000+0001, container, routes,
  concurrence, rollback, trigger UPDATE/DELETE, TRUNCATE, parité.
- La gestion fine des privilèges du rôle applicatif est reportée au déploiement.
