# Revue indépendante — QA « breaker » (COCKPIT-LIVE D1 + D2)

- **Reviewer :** agent séparé `qa-breaker` (contexte vierge, modèle Claude Opus — même éditeur que l'auteur, famille différente ; limite documentée).
- **SHA examiné :** `a252d9d` (base `b4d0968`), D1 `0c02453`, D2 `aef657c`.
- **Verdict :** **REQUEST_CHANGES** — deux P1 d'honnêteté, dix P2, huit P3.
- **Exécuté par le reviewer :** 14 fichiers de test ciblés, 101 tests PASS ; `pnpm typecheck` PASS ; D1 seul (`git archive 0c02453`) : typecheck PASS, 11 fichiers / 85 tests PASS ; neuf tests-sondes jetables (B1–B9) hors dépôt, supprimés après usage.

## Constats

| Sév. | Emplacement | Constat | Correction |
| --- | --- | --- | --- |
| P1 | `live-overview.ts` (attempts), `live-sources.tsx` | Lecture des dispatches échouée → `{nonTerminal: 0}` rendu « 0 dispatch(es) » sous un badge LIVE (sonde B2). | `attempts` nullable + `attemptsErrorCode`, rendu UNAVAILABLE. |
| P1 | `live-sources.tsx` `observedActivity` | Inconnu → 0 → « No activity observed » affirmé sans mesure (B6). | `number \| null`, rendu « activity UNKNOWN ». |
| P2 | `observed.ts`, `primitives.tsx` | Dérive d'horloge : horodatage source futur → âge négatif → `ok` à vie (B1). | `degraded` + `FUTURE_SOURCE_TIMESTAMP` au-delà d'une tolérance. |
| P2 | `live-overview.ts` (workers) | Fraîcheur = sonde la plus récente : un worker frais rend toute la flotte LIVE même si les autres datent de 30 jours (B5). | Dégrader si un worker actif est périmé ou jamais sondé. |
| P2 | `live-overview.ts` (incidents) | Incidents rouges dérivés de données périmées ou historiques (VPS d'il y a 1 h, sonde échouée de 90 jours sur un worker inactif) (B3, B5). | Incident seulement si source `ok` ; workers actifs dans l'horizon. |
| P2 | `live-overview.ts`, `live-sources.ts` | `dead` compte tout l'historique → `SCHEDULER_DEAD_JOBS` rouge pour toujours. | Fenêtre 24 h ou avertissement. |
| P2 | `live-overview.ts` (omniroute) | Santé fraîche + ledger illisible → `ok` (B4) ; le test de route fige ce comportement. | Pire sous-état : `degraded` + `LEDGER_UNAVAILABLE`. |
| P2 | `live-sources.tsx` | Échec de lecture du ledger rendu « NOT CONNECTED » (B4). | Mapper le code vers `unknown`/`not_connected`/`not_available`. |
| P2 | `host-sampler.ts`, `live-sources.ts`, `live-sources.tsx` | `/proc/stat` illisible → `cores: 0` → « 0 vCPU » et tuile charge rouge (B7). | `cores` nullable, pas de ton sans cœurs. |
| P2 | `live-sources.ts` (+ `load.ts` pré-existant) | `coalesce(sum(total_tokens),0)` compte NULL comme 0 ; `sum(amount)` + `min(currency)` mélange les devises. | Compter les NULL ; `count(distinct currency)=1` pour PRICED. |
| P2 | `load.ts` | Lectures DB dupliquées (`loadTruthProjection` + `readLiveOverview`), `resolveOperationalScope` recalculé ; incohérences possibles dans un même rendu. | Passer `ctx.scope`, réutiliser les faits. |
| P2 | `load.ts`, 4 pages | `loadLiveOverview` sans garde : une exception de `resolveOperationalScope` fait échouer quatre écrans qui se dégradaient avant D2. | Envelopper, `null` sur erreur. |
| P2 | `api/cockpit/live/route.ts` | Pas de rate limit ; N+1 + ~7 agrégats par appel. | Limiteur / cache. |
| P3 | `live-overview.ts` | Missions illisibles → scheduler lisible jeté. | Conserver le scheduler. |
| P3 | `live-overview.ts` | `observedAt` OmniRoute/services = heure d'acquisition ICOS, fraîche par construction (TTL 15 s < seuil 30 s). | Documenter. |
| P3 | `live-overview.ts` | Vide → `degraded` non documenté/non testé. | Décider explicitement (`EMPTY`). |
| P3 | `live-sources.tsx` | Résultat de sonde `unsupported` jamais affiché. | Ajouter. |
| P3 | `live-sources.tsx` | Tuiles VPS gardent leurs tons quand la source est STALE. | Neutraliser. |
| P3 | `observed.ts` | `forbidden` par regex sur la raison. | Marqueur structuré. |
| P3 | `service-probes.ts` | Singleton capturant le premier `databaseHealth` → faux `POSTGRES_DOWN` après `resetContainer()`. | Réinjecter le port à chaque appel. |
| P3 | `telemetry-{client,format,fixture}.ts` | Code mort (tests seulement). | Brancher ou retirer. |
| P3 | `load.ts` | `collectedAt` pris avant les lectures → âge négatif masqué « 0s ago ». | `new Date()` après lectures. |

## Non cassé

`container.ts`/`errors.ts` additifs ; OmniRoute HTML/oversize/timeout/invalide corrects et testés ; coalescence des caches correcte ; `LiveRefresh` inchangé ; panneaux existants intacts.

## Tests manquants (13)

Horodatage futur ; `attempts`/`activeAssignments` manquants ; OmniRoute mixte ; incidents sur données périmées ; âges de sondes mixtes, registre vide, mémoire vide ; chemin SQL de `readLiveOverview` sur PostgreSQL ; tokens NULL, devises mixtes ; `loadLiveOverview` (préchargement, erreur) ; échec d'une seule source ; `/proc/stat` absent ; texte d'activité inconnue ; vocabulaire « ledger UNKNOWN » ; rate limit de `/live`.

Incertitudes signalées : comportement SQL lu sans exécution ; purge des jobs `dead` non vérifiée ; régression des pages déduite du code, non rendue.

## Re-vérification (HEAD `0f9730d`, correctif `964114f`)

- **Verdict : REQUEST_CHANGES (restreint)** — les deux P1 et presque tous les P2 initiaux sont corrigés et vérifiés (27 fichiers / 260 tests PASS, typecheck PASS, sondes jetables R1/R2) ; deux P2 nouveaux, d'une ligne chacun.
- **P2 nouveau 1 :** `loadSources` (et `loadTruthProjection`) construisent leur refus de portée avec `missing("not_available", …)` sans le marqueur `FORBIDDEN_SCOPE` : sur les quatre écrans (qui préchargent depuis `loadSources`), un viewer verrait Workers `UNAVAILABLE / NOT_AVAILABLE` au lieu de `FORBIDDEN` (la route construit sa propre valeur avec `scopeRefused`, ce qui masquait le cas). → `scopeRefused` dans `load.ts`.
- **P2 nouveau 2 :** les appels `UNMETERED` ont `cost_kind IS NULL` (coût inconnu) mais ne comptent pas dans `unpriced24h` : 10 appels chiffrés + 1 non métré → `PRICED` avec un montant présenté comme total complet. → `unmetered24h > 0` ⇒ `UNPRICED`, montant nul ; assertions dans les deux tests.
- **P3 :** horodatage de sonde futur compté « dans l'horizon » (appliquer `FUTURE_TOLERANCE_MS`) ; clé de cache sans `since` (documenter) ; suppressions de fichiers ajoutés par la branche à mentionner dans le rapport D3.
- **Tests manquants :** `loadSources` en portée liée ; `priceStatusOf` avec UNMETERED ; sonde future ; cache `live-facts` (vol partagé, délai, échec non mis en cache) ; test d'intégration lu mais non exécuté par le reviewer.

## Confirmation sur le delta final (`0f9730d..1255bf0`, HEAD `1255bf0`)

- **Reviewer :** agent vierge `qa-breaker` sur Claude Sonnet (les agents Opus ont été interrompus par une limite de dépense). **Verdict : APPROVE** (dimension QA).
- **Exécuté :** `pnpm typecheck` PASS ; 24 fichiers / 239 tests PASS (unitaires) ; test PostgreSQL lu et vérifié contre le code, non exécuté.
- **Constats :** P2 refus de portée structuré → FIXED (`load.ts`, `scopeRefused`, propagation vérifiée dans `observe`/`buildLiveOverview`, y compris `workspaces`) ; P2 appel non métré jamais `PRICED` → FIXED (`priceStatusOf`, `amount24h`, cas PostgreSQL « priced + unmetered ») ; P3 sonde future → FIXED ; P3 cache documenté et testé → FIXED ; aucune régression sur transaction lecture seule, 403 audité, repli `LIVE_VIEW_FAILED`, estampille tenant.
- **Incertitudes non bloquantes :** pas de test unitaire direct de la propagation du marqueur depuis `load.ts` (couvert au niveau `observe`) ; chemin d'échec en vol partagé du cache non testé ; sémantique PostgreSQL vérifiée par lecture.
