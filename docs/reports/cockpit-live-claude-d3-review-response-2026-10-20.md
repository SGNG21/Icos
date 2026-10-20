# COCKPIT-LIVE-CLAUDE — D3 : réponse de l'auteur aux revues indépendantes

- **Revues :** sécurité, QA « breaker », architecture (`docs/reports/reviews/`), toutes trois REQUEST_CHANGES sur `a252d9d`, aucun P0.
- **Corrections :** commit `964114f` (+ `container.ts` ramené à la mise en forme de base si distinct). L'auteur n'a corrigé que les points identifiés ; les décisions propriétaire sont listées telles quelles.
- **Reviewer officiel ICOS :** indisponible (`ICOS_REVIEWER_MODEL` absent en prod, seul `ICOS_REVIEWER_COMMAND` placeholder) → reviewers séparés à contexte vierge (Claude Opus : famille différente de l'auteur Fable 5.1, même éditeur ; limite documentée).

## Autorisations propriétaire (P2-7 architecture)

| Étape | Référence |
| --- | --- |
| D0 | message propriétaire dans la session Claude Code du 2026-10-20 : « Lis entièrement le fichier de mission … Commence par D0 en lecture seule » |
| D1 (option A, base `b4d0968`) | message « Mission COCKPIT-LIVE — Option A autorisée sous conditions de sécurité », 2026-10-20 |
| D2 | message « ICOS — COCKPIT LIVE — D2 AUTORISÉ », 2026-10-20 |
| D3 | message « ICOS — D3 : REVUE INDÉPENDANTE OBLIGATOIRE », 2026-10-20 |

Ces messages sont des instructions du propriétaire reçues dans la session, non des messages d'agent.

## Constats et traitement

| Constat (revue) | Sév. | Traitement | Où |
| --- | --- | --- | --- |
| Zéro fabriqué sur les dispatches (Sec P2 / Arch P1-1 / QA P1) | P1 | `attempts`, `missions`, `scheduler` nullables avec `*ErrorCode` ; CORE3 `degraded` ; rendu « dispatches UNAVAILABLE (code) » ; tests | `live-overview.ts`, `live-sources.tsx`, tests |
| « No activity observed » affirmé sans mesure (QA P1) | P1 | `observedActivity` → `number \| null`, rendu « Activity UNKNOWN », aucune animation ; test | `live-sources.tsx` |
| Lecteur de dépense ignorant `cost_kind`/devises/FREE_TIER (Arch P1-2 / QA P2) | P1 | `readSpendFacts` par `cost_kind` et devise ; statuts `PRICED / FREE_TIER / UNPRICED / MIXED_CURRENCY / NO_TRAFFIC` ; montant seulement si tout `COST` en devise unique ; `UNMETERED` à part ; **un seul lecteur** pour la vue live et `loadTruthProjection` ; `costMetric` affiche `FREE_TIER (verified)` ; tests PostgreSQL (FREE_TIER, devises mixtes, UNMETERED, autre tenant) | `live-facts.ts`, `load.ts`, `truth-projection.ts` |
| Recoupement `load.ts` avec `cockpit-agentic-os` (Arch P1-3) | P1 coord. | **Décision propriétaire** : séquencer les deux lanes ; un seul module d'observation OmniRoute (santé ici, usage SQLite là-bas). Non corrigeable par l'auteur. | — |
| Portée `/telemetry` ≠ `/live` (Sec P2-1 / Arch P3-4) | P2 | `/telemetry` exige rôle `operator` **et** portée globale (403 sinon) ; tests | `telemetry/route.ts` |
| `/live` sans rate limit, agrégats doublés (Sec P2-3 / Arch P2-4 / QA P2) | P2 | limiteur 60/min sur `/live` (429) ; cache 10 s + délai 5 s des agrégats partagés ; `loadLiveOverview` passe `ctx.scope` et les faits préchargés | `live/route.ts`, `live-facts.ts`, `load.ts` |
| Projection dupliquée (Arch P2-1) | P2 | `readSpendFacts`/`readMemoryFacts` partagés | `live-facts.ts` |
| `forbidden` par regex (Arch P2-2 / QA P3) | P2 | marqueur structuré `FORBIDDEN_SCOPE` sur `Truth.requirement` (`scopeRefused`) | `observed.ts` |
| Étiquette tenant sans prédicat (Sec P3 / Arch P2-3) | P2 | prédicat `tenant_id` sur ledger, mémoire, entités, relations, log ; **écart constaté** : le ledger est écrit sous `icos-holding` (`SPEND_LEDGER_TENANT_ID`), la mémoire sous `default` ; le lecteur suit la constante du writer et l'expose (`ledgerTenantId`). **Décision propriétaire** : réconcilier les deux vocabulaires. | `live-sources.ts`, `live-facts.ts` |
| Code mort porté (Arch P2-5 / QA P3) | P2 | `telemetry-client/format/fixture` retirés ; schéma de réponse conservé comme contrat serveur | `server/telemetry/telemetry-contract.ts` |
| Troisième monitoring VPS non commité (Arch P2-6) | P2 | **Décision propriétaire** (lane `cockpit-vps-monitor`). | — |
| Dérive d'horloge (QA P2) | P2 | `FUTURE_SOURCE_TIMESTAMP` au-delà de 60 s ; test | `observed.ts` |
| Fraîcheur de flotte par la sonde la plus récente (QA P2) | P2 | `staleActive` (actifs sans preuve dans l'horizon) → `STALE_WORKER_EVIDENCE` ; `observedAt` documenté comme vivacité du balayage ; test | `live-overview.ts` |
| Incidents sur données périmées/historiques (QA P2) | P2 | incident seulement si source `ok` ; sondes échouées récentes sur workers actifs ; `dead24h` fenêtré ; tests unitaires et PostgreSQL | `live-overview.ts`, `live-facts.ts` |
| OmniRoute mixte `ok` (QA P2) | P2 | `degraded` + `LEDGER_UNAVAILABLE` / `GATEWAY_UNAVAILABLE` ; test | `live-overview.ts` |
| « NOT CONNECTED » pour un échec de lecture (QA P2) | P2 | `missingFor(code)` → vocabulaire exact ; test | `live-sources.tsx` |
| `cores: 0` → tuile rouge (QA P2) | P2 | `cores: number \| null`, `CPU_COUNT_UNKNOWN`, tuile charge sans ton ; test | `live-sources.ts`, `live-sources.tsx` |
| `loadLiveOverview` sans garde (QA P2) | P2 | `try/catch` → `null` ; portée passée | `load.ts` |
| Tokens NULL comptés 0 (QA P2) | P2 | par schéma (0055) un total NULL est un appel `UNMETERED` ; compté `tokensUnknown24h`, affiché « (+n unmetered) » | `live-facts.ts` |
| Redirections `fetch` (Sec P3) | P3 | `redirect: "error"` | `omniroute-monitoring.ts` |
| Pas de `statement_timeout` (Sec P3) | P3 | délai 5 s sur les agrégats (`LIVE_FACTS_DEADLINE`) | `live-facts.ts` |
| Message d'erreur du script (Sec P3) | P3 | code seul | `scripts/cockpit-live-verify.ts` |
| `UNKNOWN` troisième mot de prix (Arch P3-1) | P3 | `NO_TRAFFIC` | `live-overview.ts` |
| Pas de version (Arch P3-2) | P3 | `schema: 1` ; test | `live-overview.ts` |
| Singleton de sondes (Arch P3-3 / QA P3) | P3 | `setDatabase` à chaque appel | `service-probes.ts` |
| Bruit Prettier `container.ts` (Arch P3-5) | P3 | fichier de base + 3 lignes | `container.ts` |
| Missions illisibles → scheduler jeté (QA P3) | P3 | scheduler conservé, `missionsErrorCode` | `live-overview.ts` |
| `observedAt` OmniRoute = acquisition (QA P3) | P3 | documenté dans `LIVE_MAX_AGE_MS` et l'UI | `live-overview.ts`, `live-sources.tsx` |
| Vide = degraded non documenté (QA P3) | P3 | `EMPTY_SOURCE` explicite ; tests | `observed.ts` |
| `unsupported` non affiché (QA P3) | P3 | affiché | `live-sources.tsx` |
| Tons VPS en STALE (QA P3) | P3 | tons neutres hors `ok` | `live-sources.tsx` |
| `collectedAt` avant lectures (QA P3) | P3 | `now` pris après les lectures | `live-sources.ts` |
| PNG en dépôt (Arch P3-6), nom de branche (P3-7) | P3 | acceptés tels quels | — |

## Vérifications après corrections

| Gate | Résultat |
| --- | --- |
| `pnpm typecheck` | PASS |
| `pnpm exec eslint` (fichiers du périmètre) | PASS |
| Suites cockpit (`src/features/cockpit`, `src/components/cockpit`, `src/app/api/cockpit`, `src/server/telemetry`) | 28 fichiers, 283 tests PASS |
| `pnpm build` (sur `a252d9d`) | PASS |
| Suite unitaire complète (sur `aa1f997`, base de test isolée) | 349 fichiers, 5 043 tests PASS, 4 ignorés |
| Intégration PostgreSQL `live-sources.integration.test.ts` (base jetable `icos_cockpit_test`) | 7 tests PASS |
| Vérification réelle (lecture seule, `964114f`) | 5 sources `ok` ; ledger 25 491 appels `UNPRICED` sous `icos-holding` ; 12/15 routables, 2 sondes récentes en échec → incident ; preuve `evidence/cockpit-live-d3-verify-2026-10-20.json` |

## Décisions propriétaire en attente

1. Recoupement `src/features/cockpit/load.ts` avec l'index de `cockpit-agentic-os` et choix d'un module unique d'observation OmniRoute (Arch P1-3).
2. Deux vocabulaires de tenant dans le hub : `icos-holding` (ledger) vs `default` (mémoire, shim).
3. Troisième implémentation VPS non commitée dans `cockpit-vps-monitor` (Arch P2-6).
4. Déploiement : le hub (58 commits, migrations 0065/0066) reste le préalable.


## Re-vérifications (2026-10-20)

| Revue | Verdict sur `0f9730d` | Restes |
| --- | --- | --- |
| Sécurité | **APPROVE** | P3 : 403 de portée non audité sur `/telemetry` ; délai sans annulation SQL |
| Architecture | **APPROVE** (préconditions propriétaire : `load.ts`/module OmniRoute unique, lane `cockpit-vps-monitor`, déploiement avec le hub) | P2 propriétaire : vocabulaire tenant ; P3 : `loadLiveOverview` silencieux, délai sans annulation, fenêtre 100 % UNMETERED, estampille tenant sur la source OmniRoute |
| QA | **REQUEST_CHANGES (restreint)** | P2 : refus de portée non structuré dans `loadSources` ; `PRICED` malgré un appel non métré ; P3 : sonde future, clé de cache, suppressions à mentionner |

### Seconde passe de corrections (commit suivant)

- `loadSources` et `loadTruthProjection` utilisent `scopeRefused` (marqueur `FORBIDDEN_SCOPE`) : les écrans rendent `FORBIDDEN` pour un viewer, comme la route.
- `priceStatusOf` : tout appel `UNMETERED` (coût inconnu par schéma) rend la fenêtre `UNPRICED` ; `amount24h` nul dès qu'un appel de la fenêtre n'est pas chiffré ; assertions unitaires et PostgreSQL.
- Preuve de sonde future exclue de l'horizon (`FUTURE_TOLERANCE_MS`) ; test.
- Agrégats exécutés dans une transaction `transaction_read_only` avec `statement_timeout` côté serveur (5 s) en plus du délai client : plus de requête orpheline ; clé de cache documentée (fenêtre glissante, ±10 s) ; tests du cache (vol partagé, TTL, échec non mis en cache, délai).
- `/telemetry` : le 403 de portée est audité (`auth.access.denied`, `reason: forbidden`) ; test.
- `loadLiveOverview` : sur exception, vue avec toutes les sources `UNAVAILABLE` (`LIVE_VIEW_FAILED`) au lieu de panneaux absents.
- Source OmniRoute sans estampille tenant de surface (le ledger porte `ledgerTenantId`).
- **Suppressions déclarées (effectuées au commit `964114f`, première passe) :** `src/features/cockpit/telemetry-{client,client.test,format,format.test,fixture}.ts`, fichiers ajoutés par cette branche en D1 (commit `0c02453`), absents de la base ; retirés sur recommandation des revues (code mort). Aucun fichier de la base n'a été supprimé ; à faire acter par le propriétaire à la fusion.
- Non corrigé (choix documenté) : fenêtre 100 % UNMETERED rendue `UNPRICED` (le coût est inconnu : un seul mot, décision 0067).
