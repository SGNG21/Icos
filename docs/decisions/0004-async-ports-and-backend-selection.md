# ADR-0004 — Ports asynchrones et sélection explicite du backend

- Statut : accepté
- Date : 2026-07-22

## Contexte

La fondation de persistance PostgreSQL (Lot 2A) exige des accès asynchrones. Le
Lot 2A-1 prépare l'architecture sans connecter aucune base : le comportement
reste entièrement en mémoire.

## Décision

- **Ports asynchrones** : les abstractions d'accès vivent dans
  `src/server/repositories/ports.ts` (`AgentRepository`, `TaskRepository`,
  `ActionRepository`, `ApprovalRepository`, `AuditRepository`) et retournent des
  `Promise`. Le port de transaction multi-entités vit dans
  `src/server/uow/ports.ts`. L'ancien `src/server/services/ports.ts` est
  supprimé. Les fonctions purement métier (`decideExecution`, cycle de vie,
  validation Zod, mappings) restent synchrones.
- **Ressource absente** : convention uniforme `getById(): Promise<Entity | null>`
  (jamais `undefined`).
- **Repositories in-memory** : renommés `InMemory*Repository`, travail interne
  synchrone exposé en asynchrone ; invariants conservés (copies défensives,
  validation, audit avant mutation, intégrité référentielle, isolement).
- **UoW mémoire** : `commitDecision` est `async` mais sa **section critique ne
  contient aucun `await`** (revérification → validation d'audit → `appendMany` →
  application). Elle utilise directement le store et le journal **synchrones**
  internes. Garde de défense au point de mutation : action existante, statut non
  terminal, aucune approbation définitive déjà présente (`already_decided`).
  Cette atomicité vaut **uniquement au sein d'une instance JavaScript** ; elle
  n'assure ni durabilité, ni cohérence multi-processus/instances, ni isolation
  distribuée — ces garanties viendront de PostgreSQL (Lot 2A-2).
- **Sélection de backend** : variable `PERSISTENCE=memory|postgres`, résolue de
  façon déterministe (`resolvePersistence(env)`), **sans bascule silencieuse** :
  dev/test sans valeur → `memory` ; production sans valeur → erreur ;
  `postgres` → `BackendNotImplementedError` (aucun repli mémoire) ; valeur
  inconnue → erreur de validation Zod. La construction accepte un environnement
  explicite (`createContainer({ env })`) pour des tests déterministes.
- **Container** : `getContainer()` renvoie une `Promise<Container>` mémoïsée sur
  `globalThis`. Une initialisation réussie reste mémorisée ; une initialisation
  **rejetée libère le cache** (la promesse rejetée n'est pas figée), autorisant
  une nouvelle tentative après correction.

## Conséquences

- Aucune dépendance ajoutée ; aucun code PostgreSQL/Drizzle ; aucune connexion.
- Les Route Handlers, le Server Component et les use cases `await` désormais les
  accès ; les contrats HTTP publics, les routes, les statuts et le cockpit sont
  inchangés.
- Le backend PostgreSQL (Lot 2A-2) fournira une implémentation réellement
  asynchrone derrière les mêmes ports publics.
