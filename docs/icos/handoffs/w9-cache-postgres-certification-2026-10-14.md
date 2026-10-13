# W9 — certification PostgreSQL isolée, 2026-10-14

Verdict : **CERTIFIÉ pour le périmètre PostgreSQL W9 décrit ci-dessous**.
Dispatch lu intégralement : `/home/icos/.icos-fable-lab/dispatch/w9-step3.md`.
Worktree unique : `/srv/icos/worktrees/fable-n1-w9-cache-ledger`.
Branche : `feat/fable-n1-w9-cache-ledger`. Base certifiée : `6daef30`.
Correctif de test séparé : `c6b6ae3` (`test(w9): verify lease renewal against PostgreSQL deadline`).

Toutes les connexions de certification ont ciblé exclusivement
`postgres://icos@127.0.0.1:55500/icos_test_w9_cache`, dans le conteneur fourni
`w9-pg-cert` (PostgreSQL 14). Les commandes psql ont utilisé explicitement
`docker exec w9-pg-cert psql -U icos -d icos_test_w9_cache`.
Aucune autre base, aucun autre worktree, aucune autre branche utilisés en écriture.

## Résultats

| Vérification                              | Résultat et preuve                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| État initial                              | PASS : HEAD `6daef30`, worktree propre ; `current_database()` = `icos_test_w9_cache`, zéro table hors catalogues avant setup                                                                            |
| Migration de la base vierge               | PASS : `pnpm test:db:setup`, code 0, `test database ready: icos_test_w9_cache` ; migrations du journal jusqu'à 0065                                                                                     |
| Schéma 0065                               | PASS : `\d spend_ledger` avant tests et après réapplication ; `cache_read` et `cache_creation` sont `bigint`, nullable, sans défaut                                                                     |
| Contraintes cache                         | PASS : `spend_ledger_cache_read_check`, `spend_ledger_cache_creation_check`, `spend_ledger_cache_usage_check` présents                                                                                  |
| Lot PostgreSQL W9                         | PASS : 62 tests, 2 fichiers, aucun skip, 31,35 s ; ledger 30 tests et réservations 32 tests                                                                                                             |
| Onze tests cache préparés                 | PASS : neuf combinaisons absent/0/positif sur deux compteurs, lecture SQL et mission, isolation tenant ; deux tests vérifiant les rejets des valeurs négatives et des compteurs sur UNMETERED           |
| Ancienne forme METERED                    | PASS : INSERT sans colonnes cache ; `listForMission` rend `cacheRead: null`, `cacheCreation: null`, total 12 ; aucun zéro inventé                                                                       |
| Ancienne forme UNMETERED                  | PASS : INSERT sans compteurs ; restitution cache et total à null, raison préservée                                                                                                                      |
| `windowFor` sur les deux lignes anciennes | PASS : deux appels, 12 tokens, un appel UNMETERED ; cette fenêtre agrège les totaux et n'expose pas de compteurs cache                                                                                  |
| Rejets SQL supplémentaires                | PASS : pour chaque colonne, zéro sur UNMETERED et valeur négative sur METERED rejetés ; quatre SQLSTATE `23514`                                                                                         |
| Coûts, UNPRICED et budgets                | PASS : suites existantes du lot, dont modèle sans prix, refus monétaire, total après reconnexion et plafond après redémarrage                                                                           |
| Tenant, attribution, append-only          | PASS : tests du lot ; UPDATE/DELETE ledger rejetés, isolation tenant et attribution des réservations préservées                                                                                         |
| Transactions, idempotence et fencing      | PASS : tests existants du lot réservations, dont double settlement, mauvais jeton, bail expiré et imputation issue de la réservation                                                                    |
| Rollback sur la seule base jetable        | PASS : deux lignes survivantes ; comparaison JSON de tous leurs champs hors cache identique avant/après ; les deux colonnes disparaissent                                                               |
| Réapplication manuelle 0065               | PASS : colonnes, types, nullabilité, défauts, contraintes, index et triggers identiques au snapshot avant rollback ; champs hors cache identiques ; cache NULL/NULL                                     |
| Concurrence après réapplication           | PASS : cinq tests sélectionnés, 27 hors sélection, un fichier, 8,85 s ; quatre workers avec settlements simultanés, seize réservations, instances distinctes, nouvelle connexion, course reserve/settle |
| Contrôles du correctif                    | PASS : `tsc --noEmit --incremental false`, ESLint du test, Prettier du test, `git diff --check` et revue du diff                                                                                        |

## Commandes et sorties conservées

Variable fixée avant chaque commande Node accédant à PostgreSQL :

```sh
export ICOS_TEST_DATABASE_URL=postgres://icos@127.0.0.1:55500/icos_test_w9_cache
pnpm test:db:setup
pnpm exec vitest run --config vitest.integration.config.ts src/server/budget/
pnpm exec tsx /tmp/w9-step3-probe.ts
pnpm exec vitest run --config vitest.integration.config.ts src/server/budget/postgres-spend-reservations.integration.test.ts -t 'LA PREUVE|DISPARAÎTRE'
```

Sortie finale du lot :

```text
Test Files  2 passed (2)
     Tests  62 passed (62)
  Start at  00:19:57
  Duration  31.35s (transform 2.48s, setup 0ms, import 8.54s, tests 21.57s, environment 0ms)
```

Sortie concurrence après réapplication :

```text
Test Files  1 passed (1)
     Tests  5 passed | 27 skipped (32)
  Start at  00:21:30
  Duration  8.85s (transform 1.43s, setup 0ms, import 3.11s, tests 5.35s, environment 0ms)
```

Le probe temporaire impose l'URL exacte avant ouverture de connexion. Il insère les deux
lignes anciennes, vérifie les deux API, contrôle les SQLSTATE et compare les snapshots
structurels et les lignes avant/après rollback. Sortie :

```text
PASS legacy METERED and UNMETERED: windowFor calls=2 tokens=12 unmetered=1; listForMission cache=null/null
PASS CHECK cache_read unmetered-zero: SQLSTATE 23514
PASS CHECK cache_read negative: SQLSTATE 23514
PASS CHECK cache_creation unmetered-zero: SQLSTATE 23514
PASS CHECK cache_creation negative: SQLSTATE 23514
PASS rollback: 2 rows and all non-cache fields preserved; cache columns absent
PASS reapply 0065: columns, defaults, nullability, constraints, indexes and triggers identical; surviving rows cache NULL/NULL
```

Traces locales non committées :

- `/tmp/w9-step3-budget-integration.log` : lot final PASS.
- `/tmp/w9-step3-budget-integration-sandbox-fail.log` : premier lot bloqué par EPERM.
- `/tmp/w9-step3-budget-integration-renew-fail.log` : premier lot hors sandbox, 61 PASS / 1 FAIL.
- `/tmp/w9-step3-renew-repro.log` : reproduction ciblée du défaut de timing.
- `/tmp/w9-step3-probe.ts` et `/tmp/w9-step3-probe.log` : anciennes lignes et rollback/réapplication.
- `/tmp/w9-step3-concurrency.log` : cinq tests de concurrence après réapplication.
- `/tmp/w9-step3-final-schema.log` : schéma final via psql.

## Échecs initiaux et correction

Le setup initial en sandbox a échoué avant accès SQL : socket IPC tsx, `listen EPERM`.
Le lot initial en sandbox a échoué avec `connect EPERM 127.0.0.1:55500` :
62 FAIL, 2 fichiers, 103,00 s. Relances hors sandbox explicitement autorisées,
sans changement d'URL ni assouplissement des contrôles de base.

La première passe hors sandbox a donné 61 PASS / 1 FAIL, 2 fichiers, 15,12 s :
`PROLONGE un bail vivant` attendait 60 ms avec un bail initial de 120 ms.
Le test ciblé a reproduit l'échec : 1 FAIL, 31 hors sélection, 7,80 s.
Une pause d'ordonnancement suffit à laisser expirer ce bail avant le renouvellement.

Le correctif `c6b6ae3` modifie exclusivement
`src/server/budget/postgres-spend-reservations.integration.test.ts` : bail configuré
à 60 s ; à chaque itération, fixture PostgreSQL d'un bail encore vivant de 30 s ;
renouvellement réel puis assertion SQL d'une échéance supérieure à maintenant + 45 s.
Trois renouvellements et refus d'une réservation supplémentaire vérifiés. L'expiration
et le fencing restent testés séparément. Aucun code de production modifié.

## SQL de rollback exécuté

Uniquement sur `icos_test_w9_cache` dans l'instance jetable fournie :

```sql
ALTER TABLE spend_ledger
  DROP CONSTRAINT spend_ledger_cache_usage_check,
  DROP CONSTRAINT spend_ledger_cache_read_check,
  DROP CONSTRAINT spend_ledger_cache_creation_check,
  DROP COLUMN cache_read,
  DROP COLUMN cache_creation;
```

Puis exécution manuelle du contenu exact de `drizzle/0065_spend_ledger_cache.sql`.
Le journal Drizzle n'a pas été réécrit : il conserve l'application initiale de 0065.
Aucun lancement du migrateur sur une base existante après le setup initial.
Aucun appel applicatif pendant l'absence des colonnes.

## Limites et NON certifié

- La réversibilité démontrée est structurelle et préserve les lignes et leurs champs
  hors cache. DROP COLUMN perdrait toute mesure cache présente : ce rollback ne restaure
  pas ces mesures. Les deux lignes du probe n'en portaient aucune. Les valeurs 0/positives
  ont été vérifiées dans les tests de round-trip avant rollback.
- Les tests de concurrence existants portent sur les budgets et settlements ; ils
  n'ajoutent pas de matrice de valeurs cache aux settlements concurrents.
- Les lignes de preuve du probe ont ensuite été nettoyées par les fixtures de la passe
  de concurrence ; leurs résultats sont consignés ci-dessus, sans prétendre les conserver
  comme données métier.
- L'ancienne forme de ligne est simulée par INSERT omettant le cache après migration.
  L'upgrade d'une base historique remplie, l'ancien binaire et un rollback applicatif
  ne sont pas certifiés ici.
- La suite complète mission-trace PostgreSQL, les parcours UI et N1 de bout en bout,
  les tests fournisseur, la production et une revue indépendante de cette étape ne
  sont pas certifiés. Le format de trace reste couvert par les tests locaux de l'étape 2.
- Le nouveau code exige le schéma 0065. Aucune compatibilité silencieuse avec l'ancien
  schéma n'est promise.
- Aucun déploiement, fusion, push, redémarrage, arrêt/suppression de conteneur ou appel
  fournisseur. Aucun accès aux autres bases. Rapport puis arrêt.
