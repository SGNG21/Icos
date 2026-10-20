# Revue indépendante — architecture et gouvernance (COCKPIT-LIVE D1 + D2)

- **Reviewer :** agent séparé `principal-architect` (contexte vierge, modèle Claude Opus — même éditeur que l'auteur, famille différente ; limite documentée).
- **SHA examiné :** `a252d9d` (base `b4d0968`), 6 commits, 55 fichiers, +7 001 / −10.
- **Verdict :** **REQUEST_CHANGES** — aucun P0 ; deux P1 d'honnêteté (ADR 0062/0069/0078) et un P1 de coordination ; IntegrationGate bloquée tant que non corrigé et re-revu (ADR 0044).
- **Exécuté par le reviewer :** `pnpm typecheck` PASS ; 12 fichiers / 93 tests PASS (`--maxWorkers=2`). Build, suite complète, serveurs, bases, OmniRoute : non exécutés (consigne).

## Constats

| # | Sév. | Emplacement | Constat | Correction |
| --- | --- | --- | --- | --- |
| P1-1 | P1 | `live-overview.ts` (attempts) | Zéro fabriqué : lecture des dispatches échouée → `attempts: { nonTerminal: 0 }` dans une source `ok`, sans code d'erreur ; l'UI affiche « 0 dispatch(es) ». Contredit ADR 0062/0069 et la mission. | `attempts` nullable + `attemptsErrorCode`, source dégradée, test. |
| P1-2 | P1 | `live-sources.ts` (agrégat spend), `priceStatusOf` | Le lecteur ignore `cost_kind` : (a) les lignes `FREE_TIER` (montant 0, migration 0066) sont sommées comme coût → `PRICED 0.00` vert, contraire à ADR 0078 ; (b) `sum(amount)` mélange les devises avec `min(currency)` ; (c) les lignes `UNMETERED` comptées `UNPRICED`. Latent (pas de FREE_TIER en prod aujourd'hui). `loadTruthProjection` pré-existant a le même défaut. | Agréger par `cost_kind`/`currency` ; `PRICED` seulement si tout est `COST` en devise unique ; statut `FREE_TIER` explicite ; `UNMETERED` à part ; un helper partagé pour les deux lecteurs ; tests. |
| P1-3 | P1 (coordination) | `src/features/cockpit/load.ts` | Recoupement avec l'index non commité de `cockpit-agentic-os` (`loadGraph`, `src/server/providers/omniroute-telemetry.ts` = second port de télémétrie OmniRoute lisant la SQLite d'OmniRoute). | Décision propriétaire : séquencer les deux lanes et retenir un seul module d'observation OmniRoute. |
| P2-1 | P2 | `live-sources.ts` vs `loadTruthProjection` | Projection dupliquée (mémoire, spend) ; `/cockpit/system` exécute les deux copies par requête. | Factoriser `readSpendFacts`/`readMemoryFacts`. |
| P2-2 | P2 | `observed.ts` | `forbidden` détecté par regex sur une phrase de `Truth.reason`. | Marqueur structuré. |
| P2-3 | P2 | `live-sources.ts` | `tenantId` étiqueté sans prédicat `tenant_id` sur les agrégats (idem `loadTruthProjection`). | Filtrer `tenant_id` là où la colonne existe. |
| P2-4 | P2 | `GET /api/cockpit/live` | Pas de rate limit ; N+1 missions ; agrégat `observed_at` non indexé ; agrégats doublés à chaque tick `LiveRefresh`. | Limiteur, cache TTL court, prédicat indexable. |
| P2-5 | P2 | `telemetry-{client,format,fixture}.ts` | Code mort porté (seuls des tests l'importent) ; fixture datée hors `test/`. | Retirer ou déplacer. |
| P2-6 | P2 | worktree `cockpit-vps-monitor` | Une troisième implémentation VPS non commitée existe (`src/server/host-metrics/`, `api/cockpit/host/`). | Décision propriétaire : une seule lane. |
| P2-7 | P2 (gouvernance) | D0 → D1 → D2 | L'autorisation propriétaire de l'option A puis de D2 n'est pas référencée dans le dépôt. | Joindre la référence (date, canal) aux rapports. |
| P3-1 | P3 | `priceStatusOf` | `UNKNOWN` = troisième mot de prix (ADR 0067 : un seul `UNPRICED`). | Renommer `NO_TRAFFIC`. |
| P3-2 | P3 | `/api/cockpit/live` | Pas de champ de version. | `schema: 1` + test de contrat. |
| P3-3 | P3 | `getServiceProbes` | Le singleton capture le `databaseHealth` du premier appelant. | Port passé par appel. |
| P3-4 | P3 | autorisations | `/telemetry` (operator) ≠ `/live` (portée globale) sur les mêmes données. | Aligner. |
| P3-5 | P3 | `container.ts` | Deux reflows Prettier sans rapport. | Revenir. |
| P3-6 | P3 | `a252d9d` | ~3 Mo de PNG. | Acceptable ; LFS si convention. |
| P3-7 | P3 | nom de branche | `feat/cockpit-live-d1-20261020` ≠ nom de la mission (documenté). | Aucune. |

## Réponses aux sept questions (résumé)

1. Aucune source de vérité, scheduler, registre, store ni poller parallèle ; `Observed<T>` est une extension légitime de `Truth<T>` ; agrégats copiés de `loadTruthProjection` (P2-1) et héritant de son défaut (P1-2).
2. Couches respectées (`core/telemetry` pur, pages via `load*`, container minimal, `rate_limited` additif).
3. Port fidèle (5 fichiers identiques à `bb6ddc8`), adaptations correctes, orphelins P2-5.
4. Contrats : `/live` non versionné (P3-2) ; correspondance des routes suggérées raisonnable ; profondeur missions/knowledge non livrée (écart de périmètre, pas d'architecture).
5. Schéma prod : les requêtes ne touchent ni 0065 ni 0066 ; dégradation honnête ; la branche n'est déployable qu'avec le hub (décision propriétaire).
6. Propriété : Hermes intact ; intersection `cockpit-agentic-os` = `load.ts` ; FABLE intact.
7. Séparation D1/D2 propre ; trailers présents ; aucun push/merge.

## Matrice ADR / North Star

AGENTS.md (une étape, arrêt) : non vérifiable depuis le dépôt (P2-7) · ADR 0044 : conforme (gate bloquée) · 0062 : violation étroite (P1-1) · 0064 : conforme · 0066 : conforme avec risque de duplication · 0067 : partiel (P1-2b, P3-1) · 0069 : conforme sauf P1 · 0077 : n/a · 0078 : violation latente (P1-2a) · mission : conforme (une app, réutilisation, lecture seule, pas de démo au runtime), partiel sur backpressure (P2-4) et étiquette tenant (P2-3).

## Changements requis avant re-revue

1. P1-1 ; 2. P1-2 (une seule correction pour les deux lecteurs) ; 3. P1-3 (décision propriétaire). Recommandés : P2-1 à P2-5, P2-7, P3-1, P3-2.

## Re-vérification (HEAD `0f9730d`, correctif `964114f`)

- **Verdict : APPROVE** (architecture et gouvernance) — prête pour la gate, sous trois préconditions propriétaire à l'intégration.
- **Exécuté :** `pnpm typecheck` PASS ; 30 fichiers / 294 tests PASS (hors intégration) ; index de `cockpit-agentic-os` relu (toujours 40 fichiers). Test PostgreSQL non exécuté (consigne).
- **Constats antérieurs :** P1-1 corrigé (valeurs nulles avec codes, état dégradé) ; P1-2 corrigé (`readSpendFacts` par `cost_kind`/devise, FREE_TIER jamais compté comme 0, UNMETERED à part, montant seulement sans impayé et en devise unique, un seul lecteur partagé, colonnes ≤ 0064 donc compatible prod : 25 491 appels UNPRICED relus) ; P1-3 précondition propriétaire (recoupement `load.ts`) ; P2-1/2-2/2-3/2-4/2-5 corrigés ; P2-6 décision propriétaire ; P2-7 références jointes (non vérifiables depuis le dépôt) ; P3-1 à P3-5 corrigés.
- **Point de gouvernance :** deux vocabulaires de tenant sur le hub (`icos-holding` ledger, `default` mémoire), défaut pré-existant ; suivre chaque writer est le bon choix en lecture seule ; ADR ou décision propriétaire recommandée (deviendra un bug d'isolation dès un second tenant).
- **Restants (non bloquants) :** P2 propriétaire (vocabulaire tenant) ; P3 `loadLiveOverview` rend `null` sur erreur (panneaux absents plutôt qu'un état « indisponible » explicite) ; P3 délai sans annulation SQL ; P3 fenêtre 100 % UNMETERED rendue `UNPRICED` (état `UNMETERED` ou documentation) ; P3 `tenantId` « default » estampillé sur la source OmniRoute dont le ledger vient d'`icos-holding`.
- **Matrice ADR :** 0062, 0067, 0078, 0066 désormais conformes ; mission (tenant/auth, backpressure, pas de démo) conforme ; 0044 : la gate peut s'exécuter une fois les trois re-revues favorables.
- **Préconditions propriétaire avant fusion :** (1) séquencer `load.ts` avec `cockpit-agentic-os` et choisir un module unique d'observation OmniRoute ; (2) arbitrer entre cette branche et la lane `cockpit-vps-monitor` ; (3) déployer uniquement avec le hub (`b4d0968`, migrations 0065/0066).
