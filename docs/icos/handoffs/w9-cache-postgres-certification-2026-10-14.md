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

## SQL de rollback exécuté à l’étape 3 — archive, ne pas réutiliser

Ce SQL historique exécutait la demande de l'étape 3 sur deux lignes sans cache.
La revue indépendante et le dispatch de l'étape 4 le remplacent comme procédure de
rollback : **conserver les colonnes et les mesures ; supprimer seulement les contraintes**.
Aucune suppression de colonne n'a été exécutée à l'étape 4.

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

## Étape 4 — corrections après revue indépendante

Dispatch lu intégralement : `/home/icos/.icos-fable-lab/dispatch/w9-step4.md`.
Revue lue intégralement en lecture seule :
`/srv/icos/worktrees/fable-5-1-convergence/docs/icos/handoffs/w9-cache-review-6daef30-2026-10-14.md`.
Base de cette étape : `e6e4970`, worktree propre avant modification.
L'autorisation de création de la migration et du schéma avait été donnée par le
propriétaire à l'étape 2 (« Le contrat de modification W9 est validé » et demande
explicite d'une migration additive). La correction de 0065 et ses deux réapplications
sur 55500 sont explicitement demandées par le dispatch de l'étape 4.

Le correctif de bail est déjà dans le commit distinct `c6b6ae3` ; aucun nouveau
commit ni changement du code des réservations n'est nécessaire pour ce point.
L'échec sous charge (1/62) et la preuve SQL renforcée sont documentés plus haut.

Modifications :

- `drizzle/0065_spend_ledger_cache.sql` : sections DATA SAFETY et ROLLBACK ;
  deux colonnes `IF NOT EXISTS`, trois gardes `pg_constraint` associant nom et
  table ; une seule instruction DO atomique. Même effet métier, aucun défaut,
  aucun backfill. Ajout des colonnes sans réécriture, validation des CHECK et
  verrou ACCESS EXCLUSIVE explicités ; trigger append-only non déclenché par ALTER.
- `src/server/budget/postgres-spend-ledger.integration.test.ts` : titre 0055/0065,
  commentaire indiquant l'URL du harness et l'exigence de 0065 pour les deux suites ;
  suppression du commentaire « Prepared only / never target the shared test database ».
- `src/server/mission/mission-trace.ts` : sept lignes de couverture facultative,
  par compteur, pour les seules entrées de cette mission. Un zéro explicite compte
  comme connu, NULL comme inconnu. Aucun total cache annoncé.
- `src/server/mission/mission-trace.test.ts` : couverture partielle et indépendante,
  zéro explicite, UNMETERED et exclusion des entrées goal-shared vérifiés.
- Ce rapport : résultats rejoués, rollback corrigé et limites.

### Preuves rejouées

Toujours exclusivement `postgres://icos@127.0.0.1:55500/icos_test_w9_cache`.
Aucun setup, aucune autre base, aucune réécriture du journal Drizzle.

| Vérification                                     | Résultat                                                                                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Deux réapplications manuelles du fichier 0065    | PASS, code 0 ; première et seconde sans changement du schéma ou des données                                                                   |
| Données et catalogue après chaque application    | PASS : snapshots de toutes les lignes, colonnes/types/nullabilité/défauts, définitions et OID des CHECK, index, trigger et son OID identiques |
| Mesures présentes avant réapplication            | PASS : lecture mission `read=0, creation=5` et `read=7, creation=null` identique après deux applications                                      |
| Tests locaux ciblés                              | PASS : 369/369, 16 fichiers, 26,55 s                                                                                                          |
| Lot budget PostgreSQL                            | PASS : 62/62, 2 fichiers, 14,38 s ; inclut les onze tests cache et les tests de concurrence, fencing et idempotence                           |
| `pnpm typecheck`                                 | PASS, code 0                                                                                                                                  |
| ESLint sur les trois fichiers TypeScript touchés | PASS, code 0, aucune erreur ni avertissement                                                                                                  |
| Prettier sur TypeScript et rapport touchés       | PASS                                                                                                                                          |
| Diff                                             | PASS : `git diff --check`, diff relu, périmètre W9 uniquement                                                                                 |

Commandes exécutées :

```sh
pnpm exec vitest run src/core/budget src/server/budget src/server/mission/mission-trace.test.ts
pnpm typecheck
pnpm exec eslint src/server/budget/postgres-spend-ledger.integration.test.ts src/server/mission/mission-trace.ts src/server/mission/mission-trace.test.ts
pnpm exec prettier --check src/server/budget/postgres-spend-ledger.integration.test.ts src/server/mission/mission-trace.ts src/server/mission/mission-trace.test.ts docs/icos/handoffs/w9-cache-postgres-certification-2026-10-14.md
export ICOS_TEST_DATABASE_URL=postgres://icos@127.0.0.1:55500/icos_test_w9_cache
pnpm exec tsx /tmp/w9-step4-idempotence.ts
pnpm exec vitest run --config vitest.integration.config.ts src/server/budget/
git diff --check
```

Les commandes PostgreSQL ont été autorisées hors sandbox pour le socket tsx et
l'accès à 55500 ; aucune modification de cible. Le probe impose l'URL exacte,
contrôle `current_database()`, insère deux fixtures mesurées, capture les snapshots,
exécute le fichier SQL deux fois et contrôle la restitution. Aucun rollback exécuté.

```text
PASS replay 1: rows, columns, defaults, CHECK definitions/OIDs, indexes and trigger unchanged
PASS replay 2: rows, columns, defaults, CHECK definitions/OIDs, indexes and trigger unchanged
PASS measured cache retained: read=0 creation=5; read=7 creation=NULL
PASS both cache columns nullable with no default; no rollback or column deletion performed

Test Files  16 passed (16)
     Tests  369 passed (369)
  Duration  26.55s

Test Files  2 passed (2)
     Tests  62 passed (62)
  Duration  14.38s
```

Les NOTICE PostgreSQL `42701` (« already exists, skipping ») sur les colonnes sont
attendues avec IF NOT EXISTS ; aucune exception et code final 0.
Logs locaux : `/tmp/w9-step4-idempotence.ts`, `/tmp/w9-step4-idempotence.log`,
`/tmp/w9-step4-local-tests.log`, `/tmp/w9-step4-integration.log`,
`/tmp/w9-step4-typecheck.log`, `/tmp/w9-step4-eslint.log`, `/tmp/w9-step4-prettier.log`.
SHA256 du SQL 0065 rejoué :
`e5ea3bd007814e487df2bb0106e1ae0f6a318654865298c0d0951d25b1cdae2d`.

### Rollback désormais documenté — colonnes conservées

```sql
ALTER TABLE spend_ledger
  DROP CONSTRAINT IF EXISTS spend_ledger_cache_usage_check,
  DROP CONSTRAINT IF EXISTS spend_ledger_cache_read_check,
  DROP CONSTRAINT IF EXISTS spend_ledger_cache_creation_check;
```

Les deux colonnes et toutes les mesures restent présentes. Réappliquer 0065
restaurerait les CHECK si les valeurs retenues sont valides. Ce rollback corrigé
est documenté, pas exécuté à l'étape 4 ; l'archive destructive de l'étape 3
ne constitue plus une instruction applicable.

### Portée de la certification après correction

**CERTIFIÉ** : preuves W9 demandées sur l'instance isolée, idempotence de la
réapplication sur le schéma déjà installé, mesures conservées, tests locaux et
budget PostgreSQL PASS. Les limites de l'étape 3 restent applicables.

**NON CERTIFIÉ** : première installation de la nouvelle version du bloc DO sur
une nouvelle base vierge, exécution du rollback corrigé, compatibilité avec un
schéma historique incomplet, migrations sur une base existante hors laboratoire,
parcours UI/N1, production, fournisseurs et approbation finale du reviewer.
Le journal de la base jetable conserve le hash de la version 0065 appliquée à
l'étape 3 ; modifier le fichier conformément à cette revue ne réécrit pas ce hash.
Un contrôle d'égalité des hashes du journal avec le fichier corrigé n'est donc
pas une preuve fournie ; aucun alignement forcé n'a été effectué.

Aucun autre worktree modifié, aucun push, fusion, déploiement, redémarrage,
arrêt de conteneur, appel fournisseur ou suppression de colonne à l'étape 4.
Les nettoyages de fixtures des tests restent limités à la base jetable.
Rapport puis arrêt.

## Première installation et rollback, base vierge n°2

Étape 5, dispatch `/home/icos/.icos-fable-lab/dispatch/w9-step5.md` lu intégralement.
Base de code `8e4f844`, worktree propre avant exécution. Aucun code ni migration
modifié à cette étape ; seul ce rapport change.

La seconde base `icos_test_w9_fresh` a été créée dans le conteneur jetable fourni
`w9-pg-cert`. La seule connexion de maintenance à `postgres` est celle explicitement
prescrite pour CREATE DATABASE ; elle n'a servi à aucune autre opération. Toutes
les preuves utilisent ensuite exclusivement
`postgres://icos@127.0.0.1:55500/icos_test_w9_fresh`.
La première base `icos_test_w9_cache` n'a pas été sollicitée à cette étape.

### Résultats

| Vérification                          | Résultat                                                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Création et état initial              | PASS : CREATE DATABASE réussi ; `current_database()` = `icos_test_w9_fresh`, zéro table hors catalogues avant setup                                                               |
| Première installation du nouveau 0065 | PASS : `pnpm test:db:setup`, code 0 ; migrations du journal jusqu'à 0065, avec le bloc DO de `8e4f844`                                                                            |
| Schéma initial                        | PASS : `\d spend_ledger` ; `cache_read` et `cache_creation` bigint nullable sans défaut ; trois CHECK cache présents et trigger append-only intact                                |
| Journal Drizzle                       | PASS : `LEDGER_OK 62 rows match the journal; migrate() would apply nothing` ; comparaison de tous les hashes et timestamps, y compris le nouveau texte 0065                       |
| Lot budget sur la seconde base        | PASS : 62/62, deux fichiers, aucun skip, 13,10 s ; inclut round-trips cache, contraintes, concurrence, transactions, attribution, fencing et idempotence                          |
| Rollback exact de l'en-tête           | PASS : seules les trois contraintes cache ont disparu ; toutes les colonnes, leurs numéros d'attribut, toutes les valeurs des lignes, index, trigger et journal Drizzle inchangés |
| Lecture pendant le rollback           | PASS : `listForMission` identique avant/après ; compteurs `[0,5]`, `[7,null]`, `[null,null]`, UNMETERED `[null,null]` préservés                                                   |
| Réapplication manuelle de 0065        | PASS : trois CHECK restaurés avec les mêmes définitions ; colonnes inchangées, toutes les données conservées, journal inchangé                                                    |
| Contraintes restaurées effectives     | PASS : pour chaque compteur, valeur négative sur METERED et zéro sur UNMETERED rejetés avec SQLSTATE `23514` ; quatre rejets contrôlés                                            |
| Contrôle final du journal             | PASS : les 62 hashes et timestamps correspondent toujours aux fichiers du repository après rollback/réapplication                                                                 |
| Contrôles du rapport                  | Prettier et `git diff --check` ; diff relu, seul fichier autorisé modifié                                                                                                         |

### Commandes exécutées

Création explicitement prescrite :

```sh
docker exec w9-pg-cert psql -U icos -d postgres -c 'create database icos_test_w9_fresh'
```

Ensuite, sur la seconde base uniquement :

```sh
export ICOS_TEST_DATABASE_URL=postgres://icos@127.0.0.1:55500/icos_test_w9_fresh
pnpm test:db:setup
docker exec w9-pg-cert psql -U icos -d icos_test_w9_fresh -c '\d spend_ledger'
pnpm db:verify-ledger postgres://icos@127.0.0.1:55500/icos_test_w9_fresh
pnpm exec vitest run --config vitest.integration.config.ts src/server/budget/
pnpm exec tsx /tmp/w9-step5-rollback.ts
pnpm db:verify-ledger postgres://icos@127.0.0.1:55500/icos_test_w9_fresh
```

Sorties conservées :

```text
CREATE DATABASE
icos_test_w9_fresh|0
test database ready: icos_test_w9_fresh
LEDGER_OK 62 rows match the journal; migrate() would apply nothing

Test Files  2 passed (2)
     Tests  62 passed (62)
  Start at  00:35:06
  Duration  13.10s (transform 938ms, setup 0ms, import 3.52s, tests 8.91s, environment 0ms)

PASS header rollback: exactly three cache CHECKs removed; columns/attribute numbers, ALL row values, indexes, trigger and migration journal preserved
PASS cache after rollback: [0,5], [7,NULL], [NULL,NULL], UNMETERED [NULL,NULL]; mission read-back identical
PASS replay 0065: three CHECK definitions restored; columns are a no-op; all data and journal unchanged
PASS restored CHECK cache_read unmetered-zero: SQLSTATE 23514
PASS restored CHECK cache_read negative: SQLSTATE 23514
PASS restored CHECK cache_creation unmetered-zero: SQLSTATE 23514
PASS restored CHECK cache_creation negative: SQLSTATE 23514
PASS final state: same rows, columns, CHECK definitions, indexes, trigger and migration journal as before rollback
```

Le probe temporaire impose l'URL exacte et contrôle `current_database()` avant
opération. Après les tests budget, il insère quatre fixtures (deux ventilations
mesurées, une METERED sans cache et une UNMETERED), puis capture les données et le
catalogue. Le SQL de rollback exécuté est comparé au texte de l'en-tête de 0065
avant exécution :

```sql
ALTER TABLE spend_ledger
  DROP CONSTRAINT IF EXISTS spend_ledger_cache_usage_check,
  DROP CONSTRAINT IF EXISTS spend_ledger_cache_read_check,
  DROP CONSTRAINT IF EXISTS spend_ledger_cache_creation_check;
```

Le contenu exact de `drizzle/0065_spend_ledger_cache.sql` est ensuite rejoué.
Les NOTICE « already exists, skipping » sont attendues ; aucune exception.
Les OID des contraintes recréées ne sont pas supposés identiques ; leurs noms
et définitions le sont. Le trigger append-only et son OID restent inchangés.
Aucune suppression de colonne, aucune perte de mesure, aucun ajustement manuel
du journal. Aucun second lancement du migrateur après l'installation initiale.

SHA256 de 0065 installé puis rejoué :
`e5ea3bd007814e487df2bb0106e1ae0f6a318654865298c0d0951d25b1cdae2d`.
Logs locaux : `/tmp/w9-step5-setup.log`, `/tmp/w9-step5-schema.log`,
`/tmp/w9-step5-ledger.log`, `/tmp/w9-step5-integration.log`,
`/tmp/w9-step5-rollback.ts`, `/tmp/w9-step5-rollback.log`,
`/tmp/w9-step5-ledger-final.log`.

### Verdict après l'étape 5

**CERTIFIÉ** : première installation du bloc DO corrigé de 0065 sur base vierge,
journal Drizzle conforme au texte actuel, lot budget PostgreSQL, rollback conservant
les colonnes et les mesures, restauration des CHECK puis rejets SQL effectifs.
Les deux réserves correspondantes de l'étape 4 sont levées sur cette seconde base.
La différence de hash historique signalée sur la première base n'est pas corrigée
ni masquée : elle ne concerne pas le journal neuf et conforme de cette seconde base.

**NON CERTIFIÉ** : N1, production, déploiement, fournisseurs, parcours UI et revue
indépendante finale. Les autres limites hors périmètre de la certification W9
restent applicables. Aucun accès à une autre base que la création de maintenance
explicitement demandée et `icos_test_w9_fresh`, aucun autre worktree modifié,
aucun push, aucune fusion, aucun arrêt de conteneur. Rapport puis arrêt.
