---
name: icos-postgresql
description: Use when adding or changing a Drizzle schema, writing a migration, implementing a repository, touching transaction/unit-of-work code, or mapping Postgres errors to HTTP responses
---

# icos-postgresql

## Objectif

Garantir que toute persistance PostgreSQL respecte les invariants ICOS :
migrations additives uniquement, mapping Zod systématique, transactions
atomiques via verrouillage explicite, audit append-only garanti au niveau
SQL, erreurs mappées sans fuite de détails internes.

## Contexte d'utilisation

- Ajout ou modification d'une table dans `src/server/database/schema.ts`.
- Écriture d'une nouvelle migration Drizzle.
- Implémentation ou modification d'un repository Postgres.
- Toute logique de transaction multi-étapes (unité de travail).
- Mapping d'une erreur Postgres/Drizzle vers une réponse HTTP.

**Ne doit PAS s'activer quand** la question porte sur *qui* a le droit de
faire l'action plutôt que sur le stockage (→ `icos-security`), ou sur la
sémantique de rétention/fraîcheur/provenance d'un embedding une fois le
schéma en place (→ `icos-rag-memory`).

## Invariants ICOS

- Le schéma vit dans `src/server/database/schema.ts` ; contraintes CHECK sur
  les enums, `authorization_level BETWEEN 0 AND 3`, `timestamptz` partout,
  `details jsonb` pour les données structurées libres.
- `actions.task_id` est l'unique source de vérité de la relation
  tâche↔actions ; `Task.actionIds` est dérivé en lecture, jamais persisté.
- Une migration appliquée n'est **jamais** modifiée : seule une nouvelle
  migration additive peut faire évoluer le schéma (`0000`, `0001`, `0002`
  restent figées ; une extension se fait via `0003`, `0004`, etc.).
- Toutes les FK sont `ON DELETE RESTRICT`.
- Chaque ligne lue est revalidée via Zod `safeParse` avant d'être renvoyée ;
  une ligne invalide lève `RepositoryMappingError`, jamais un retour
  silencieux.
- L'audit (`audit_entries`) est append-only garanti par trigger SQL
  (`icos_forbid_audit_mutation`, `SQLSTATE 'IC001'`), en plus de la garantie
  applicative (aucune méthode `update`/`delete` exposée par
  `AuditRepository`).
- Une transaction critique (ex. décision d'approbation) utilise
  `SELECT ... FOR UPDATE` pour verrouiller la ligne, revérifie l'état avant
  d'écrire, et committe ou rollback intégralement — jamais d'écriture
  partielle.
- L'ordre des listes est déterministe et identique entre backends mémoire et
  Postgres (`src/core/ordering.ts`) : agents par `authorizationLevel DESC,
  id ASC` ; tâches/actions par `createdAt|requestedAt ASC, id ASC` ;
  approbations par `decidedAt ASC, id ASC` ; audit par `occurredAt ASC, id
  ASC`.
- `PERSISTENCE=memory|postgres` est résolu explicitement, sans bascule
  silencieuse ; en production, une valeur explicite est obligatoire ; le
  backend `postgres` ne retombe jamais sur `memory` en cas d'échec de sonde.
- Les migrations ne sont **jamais** appliquées automatiquement au démarrage ;
  seule la commande `pnpm db:migrate` explicite les applique.

## Ce qu'elle doit vérifier avant d'agir

1. La migration proposée est-elle additive, ou modifie-t-elle une migration
   déjà appliquée (`0000`–`0002`) ? Si modification, s'arrêter — c'est
   interdit.
2. Le nouveau champ de schéma a-t-il une contrainte CHECK/enum cohérente
   avec le contrat Zod correspondant dans `core/contracts` ?
3. Une transaction multi-étapes verrouille-t-elle la ligne concernée avant
   lecture-modification-écriture (`FOR UPDATE`) ?
4. Une nouvelle erreur Postgres est-elle mappée vers un SQLSTATE connu
   (`23505` conflit unique, `40001`/`40P01` conflit transitoire,
   `08*`/`57P0x` indisponibilité) plutôt que propagée brute ?
5. Le mapping ligne↔contrat revalide-t-il systématiquement via Zod ?
6. Le test d'intégration Postgres réel (Testcontainers) existe-t-il pour ce
   changement, ou seulement un test en mémoire ?

## Technologies autorisées

Drizzle ORM 0.45.2, drizzle-kit 0.31.10, postgres.js 3.4.9,
@testcontainers/postgresql 12.0.4 (tests uniquement). PostgreSQL 16
(version de test confirmée via `postgres:16-alpine`). Aucune autre
bibliothèque d'accès base de données.

## Anti-patterns

- Modifier une migration déjà appliquée au lieu d'en créer une nouvelle.
- Stocker `Task.actionIds` comme colonne persistée en plus de
  `actions.task_id`.
- Faire confiance à une ligne lue sans revalidation Zod.
- Décision + exécution en requêtes REST séparées sans transaction ni
  verrouillage (anti-pattern confirmé dans Holding IA : WF-A/B/C
  insèrent/décident/exécutent via des appels indépendants, sans atomicité —
  cf. `icos-legacy-reuse`).
- Laisser un webhook ou une mutation rejouable créer un doublon faute de clé
  d'idempotence.
- Exposer un message d'erreur SQL brut, une URL de connexion, ou un détail
  de schéma dans une réponse HTTP.
- Divergence de schéma entre le dépôt Git et la production sans migration
  documentée (anti-pattern confirmé dans Holding IA : `ETAT_ACTUEL.md`
  documente un schéma Git présenté comme sous-ensemble de la production
  réelle — jamais acceptable dans ICOS).

## Sécurité

Voir `icos-security` pour le contenu de l'audit. Ici : l'audit append-only
est un contrôle de sécurité technique (trigger SQL), pas seulement une
convention applicative — toute tentative de contournement (ex. requête SQL
directe hors repository) est un incident, pas une optimisation.

## Stratégie TDD

- Écrire le test de transaction concurrente (deux décisions simultanées sur
  la même action) avant d'implémenter le verrouillage — il doit d'abord
  échouer sans `FOR UPDATE`.
- Écrire le test de parité d'ordre mémoire/Postgres avant d'ajouter un
  nouveau critère de tri.
- Tests d'intégration réels via Testcontainers pour toute nouvelle
  transaction ou contrainte SQL ; jamais remplacés par des mocks ni
  présentés comme réussis s'ils sont ignorés faute de Docker.
- Test explicite qu'une migration additive laisse les données existantes
  intactes (pas de perte, pas de valeur par défaut silencieuse dangereuse).

## Définition de done

- `pnpm db:generate` produit une migration additive propre, sans modifier de
  fichier existant sous `drizzle/`.
- `pnpm test:integration` passe (Docker requis) pour tout changement de
  schéma, transaction, ou mapping d'erreur.
- Chaque nouvelle colonne a une contrainte cohérente avec son contrat Zod.
- `pnpm typecheck` et `pnpm lint` passent (drizzle/ exclu de Prettier comme
  convenu).
