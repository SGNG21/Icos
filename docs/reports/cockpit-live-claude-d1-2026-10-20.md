# COCKPIT-LIVE-CLAUDE — Rapport D1 (adapters de lecture / API, option A)

- **Date :** 2026-10-20 (vérification réelle 2026-10-19 23:44 UTC)
- **Base autorisée :** `feat/fable-5-1-convergence` = `b4d0968` (2026-10-14), vérifiée : contient `src/core/contracts/scheduler.ts`, `worker-registry.ts`, `features/cockpit/{load,truth,snapshot,live}.ts`, `server/scheduler/durable-scheduler.ts`, `server/budget/postgres-spend-ledger.ts`.
- **Branche D1 :** `feat/cockpit-live-d1-20261020` (créée par `git switch -c` depuis `b4d0968`, sans reset ni suppression ; l'ancienne branche `feat/cockpit-live-claude-20261020` = `b2ba10d` est conservée).
- **Commits :** `c362476` (rapport D0, cherry-pick) · `0c02453` (implémentation D1) · `470a678` (ce rapport, script de vérification, preuve masquée).
- **Statut :** D0 `REVIEW_READY` · **D1 `REVIEW_READY`** (reviewer indépendant + IntegrationGate non exécutés) · D2 `NOT_STARTED` · D3 `IN_PROGRESS` (tests d'autorisation et de fraîcheur livrés ; QA navigateur/mobile non faite).

Aucun merge, aucun déploiement, aucune écriture en base de production, aucun appel de modèle, aucun `.env` affiché. Hermes, FABLE et les 40 fichiers indexés de `cockpit-agentic-os` sont intacts (statuts `git` identiques avant/après : 43 / 5 / 0 lignes).

---

## 1. Ce qui est raccordé

| Source | Lecture réelle | Fraîcheur (`maxAgeMs`) | Où |
| --- | --- | --- | --- |
| CORE3 | `missions` + `mission_tasks` (sous portée), `dispatch_attempts` non terminaux, `scheduled_jobs` (actifs par kind, leases détenues, `dead`, `max(updated_at)`) | 120 000 | `live-sources.ts` → `container.mission`, `container.dispatchAttempts`, select borné `scheduledJobs` |
| Workers | `workers` (registre durable : statut, santé, disponibilité, `last_probe_outcome`, `last_probe_at`) + `listActiveWorkerAssignments()` | 120 000 (horizon de preuve de sonde M5.2) | `container.workerRegistryStore`, `container.dispatchAttempts` |
| OmniRoute | `GET /api/monitoring/health` natif (liste blanche, sans clé) + `spend_ledger` 24 h (appels, tokens, `UNPRICED`, montant seulement si tout est chiffré) | 30 000 | `omniroute-monitoring.ts`, select borné `spendLedger` |
| PostgreSQL / mémoire | `SELECT 1` sur le pool du container (`databaseHealth`), `memory_records`, `memory_retrieval_log` 24 h, `memory_entities`, `memory_relations` | `null` (append-only, pas de seuil) | `database/health.ts`, selects bornés |
| VPS | `/proc/{stat,meminfo,loadavg,uptime,net/dev,pressure/*}`, `/sys/class/net`, `statfs`, cgroup v2 | 30 000 | `server/telemetry/host-sampler.ts` (porté de `849627b`/`bb6ddc8`) |

**Contrat transversal** : `Observed<T>` (`src/features/cockpit/observed.ts`) au-dessus de `Truth<T>` existant, états `ok | stale | degraded | unavailable | forbidden`, `observedAt` (mesure source), `collectedAt` (acquisition), `maxAgeMs` documenté, `source`, `tenantId`, `data | null`, `errorCode` assaini. Écart documenté par rapport au contrat suggéré : `maxAgeMs` accepte `null` (aucun seuil inventé pour un journal append-only) et un état `degraded` existe pour « lu mais sans horodatage source » (registre jamais sondé ≠ worker vivant).

## 2. API raccordées (correspondance exacte avec la mission)

| Intention mission | Réalisé |
| --- | --- |
| `GET /api/cockpit/live/overview` + `…/missions` + `…/workers` + `…/omniroute` + `…/knowledge` | **`GET /api/cockpit/live`** (nouvelle, lecture seule) : `{ generatedAt, scope, sources: { core3, workers, omniroute, memory, vps }, incidents }`. Auth `cockpit.read` ; portée opérationnelle via `resolveOperationalScope` ; les sources tenant-wide répondent `forbidden` hors owner/admin ; tenant = `CURRENT_SINGLE_TENANT_ID` (jamais un paramètre client). |
| `…/resources` | **`GET /api/cockpit/telemetry`** (porté de `bb6ddc8`) : rôle `operator`, limite 60/min/utilisateur (429 + `Retry-After`), cache de sondes 15 s, capacité workers depuis le registre (`jobSlots` = somme `max_concurrency` des workers `active`, `activeJobs` = dispatches non terminaux), empreinte par worker `unavailable` (jamais estimée). |
| Lectures existantes réutilisées | `GET /api/cockpit`, `/api/missions`, `/api/goals`, `/api/scheduler/jobs` inchangées. Aucune nouvelle route d'écriture, aucun SQL arbitraire, aucun nouveau port réseau, aucun SSE. |

Vocabulaire d'honnêteté appliqué : `UNPRICED` (jamais `0`), `NO_TELEMETRY` (VRAM, pas de GPU), `NOT_CONNECTED` (pas de base), `NO_SOURCE_TIMESTAMP` (jamais sondé), `FORBIDDEN_SCOPE`, `STALE` au-delà du seuil.

## 3. Fichiers (commit `0c02453`, 31 fichiers, +5 250 / −2)

- **Portés tels quels** (`bb6ddc8`) : `src/core/telemetry/{host-telemetry,index}.ts` (+test), `src/server/telemetry/{proc-parsers,host-sampler,rate-limit}.ts` (+tests), `src/server/database/health.ts` (+test), `src/features/cockpit/{telemetry-client,telemetry-format}.ts` (+tests), `telemetry-fixture.ts` (fixture de test uniquement, jamais rendue).
- **Portés et adaptés** : `src/server/telemetry/omniroute-monitoring.ts` (parse inchangé + client HTTP autonome `fetchOmniRouteMonitoring`/`createOmniRouteMonitor`, le hub n'ayant pas d'adaptateur OmniRoute générique) ; `src/server/telemetry/service-probes.ts` (sans runtime cockpit `main` ; services : postgres, omniroute, nemotron, temporal `not_instrumented` ; `workerCapacity(headroom, FleetFacts)`) ; `src/app/api/cockpit/telemetry/route.ts` (+test).
- **Nouveaux** : `src/features/cockpit/observed.ts` (+test), `live-overview.ts` (pur, +test), `live-sources.ts` (lectures serveur scopées), `src/app/api/cockpit/live/route.ts` (+test).
- **Modifiés (minimal)** : `src/server/container.ts` (+`databaseHealth?: DatabaseHealthPort`, câblé sur `handle.sql` du container PostgreSQL), `src/server/http/errors.ts` (+`rate_limited` → 429).
- **Non portés volontairement** : `CkInfrastructure*`, `CkTelemetryCharts`, `telemetry-poller.ts`, `page.tsx`, `globals.css` de `bb6ddc8` (UI du cockpit V1 `main`, à refaire en D2 dans le Control Center `.cx-*`).
- **Jamais touchés** : scheduler, leases/fencing, budget (écriture), migrations, `.env`, `deploy/*`, autres worktrees.

## 4. Vérification sur données réelles (lecture seule)

Commande (script ajouté, reproductible) :

```bash
pnpm exec tsx scripts/cockpit-live-verify.ts --env-file /srv/icos/etc/icos.env \
  --out <fichier> --second-sample
```

Garde-fous : container minimal (repositories de lecture seulement, aucun scheduler/sweeper démarré), session PostgreSQL ouverte avec `default_transaction_read_only=on`, `application_name=icos-cockpit-live-verify`, DATABASE_URL lu en mémoire et jamais affiché, sortie refusée si elle contient un motif sensible. Preuve masquée : `docs/reports/evidence/cockpit-live-d1-verify-2026-10-20.json`.

Résultat (base `icos_app`, OmniRoute 127.0.0.1:20129, hôte `icos-web`) — vue construite en 612 ms :

| Source | État | `observedAt` (UTC) | Données réelles |
| --- | --- | --- | --- |
| core3 | `ok` | 23:44:31.200 | 0 mission, 0 tâche, 0 dispatch ; scheduler actif : `probe_workers` 1, `reconcile_compute_fleet` 1, `supervisor_observe` 1 ; 0 lease, 0 dead |
| workers | `ok` | 23:44:31.173 | 15 enregistrés, 14 actifs, **11 routables**, sondes `ok` 11 / `stale` 1 / `failed` 3 ; 0 affectation |
| omniroute | `ok` | 23:44:39.417 | santé `degraded` (« sain », disjoncteurs 5 fermés / 2 dégradés), Nemotron `operational` ; 24 h : **25 602 appels, 1 380 445 tokens, 25 602 `UNPRICED`, montant `null`, `priceStatus=UNPRICED`** |
| memory | `ok` | 16:07:22.808 | 99 records (99 actifs), 54 récupérations 24 h, 2 entités, 0 relation ; PostgreSQL `operational` |
| vps | `ok` | 23:44:39.857 | 8 vCPU, CPU 24,7 %, load1 2,26, RAM 34,9 %, disque 22,8 %, VRAM `NO_TELEMETRY` |

Incident confirmé (rouge) : `WORKER_PROBE_FAILED` — 3 workers avec sonde en échec datée (classes `AUTH_FAILURE`, `UNAVAILABLE`, `UNKNOWN`, relevé D0). Pas d'incident OmniRoute (dégradé ≠ panne), pas d'incident hôte.

Variation naturelle d'une métrique VPS, sans charge artificielle (deux échantillons à 11 s d'écart) : CPU 24,7 % → 12,5 %, load1 2,26 → 2,12, `at` 23:44:39.857 → 23:44:50.890. Capacité workers : `activeJobs` 0, `jobSlots` 14, empreinte et workers additionnels `unavailable` (non mesurés).

Cohérence avec D0 (23:20 UTC) : mêmes 15 workers / 11 routables, mêmes 3 jobs scheduler, ledger 25 636 → 25 602 appels sur fenêtre glissante, mémoire 99 records inchangée.

## 5. Tests et gates exécutés

| Gate | Commande | Résultat |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | PASS (0 erreur) |
| Lint | `pnpm exec eslint <fichiers modifiés>` | PASS |
| Format | `pnpm exec prettier --write <fichiers modifiés>` | appliqué |
| Tests ciblés | `pnpm exec vitest run src/features/cockpit/observed.test.ts src/features/cockpit/live-overview.test.ts src/app/api/cockpit src/server/telemetry src/server/database/health.test.ts src/core/telemetry src/features/cockpit/telemetry-client.test.ts src/features/cockpit/telemetry-format.test.ts` | **13 fichiers, 93 tests PASS** |
| Suites voisines | `pnpm exec vitest run src/features/cockpit src/components/cockpit src/app/api/routes.test.ts src/server/http src/server/container.test.ts` | **31 fichiers, 387 tests PASS** |
| Réel | `scripts/cockpit-live-verify.ts` | PASS (§4) |

Tests d'autorisation/tenant/fraîcheur livrés : 401 anonyme (audité `api.cockpit.live` / `api.cockpit.telemetry`), 403 viewer sur la télémétrie, viewer → sources tenant-wide `forbidden` sur `/live`, paramètres `?tenantId=&scope=` et en-tête `x-tenant-id` ignorés, 429 au-delà de 60 lectures/min, cache de sonde (61 lectures → 1 sonde OmniRoute), `stale` au-delà de 120 s de preuve, `degraded` sans horodatage, `UNPRICED` jamais `0`, aucun motif sensible dans les corps JSON.

Non exécutés : `pnpm build`, suite Vitest complète du hub, tests d'intégration PostgreSQL (`*.integration.test.ts`, base jetable), revue indépendante, IntegrationGate.

## 6. Risques, limites, blocages

1. **Lignée** : le hub `b4d0968` est 58 commits devant la release déployée `5719213` ; la branche D1 n'est déployable qu'avec le hub (décision propriétaire, hors mandat).
2. **Temporal** : aucune sonde de joignabilité en lecture seule composée ; affiché `not_instrumented` (0 poller `icos-tasks`, relevé D0), jamais « opérationnel ».
3. **Latence OmniRoute** : seule la latence de la route de monitoring est mesurée ; la latence par appel de modèle reste `NOT AVAILABLE` (`providerTelemetry()` inchangé).
4. **Lockfile** : hub ≠ `main` ; installation faite hors-ligne depuis le store (`pnpm install --frozen-lockfile --offline`, 6,4 s, lockfile inchangé).
5. **Mono-tenant** : `CURRENT_SINGLE_TENANT_ID` ; l'isolation tenant A/B n'est testable que par la portée opérationnelle tant qu'un seul tenant existe. Pas de RLS.
6. **Backend mémoire** : sans `operationalAccess` composé, toute session est en portée liée (fail-closed) ; les tests le composent explicitement.
7. **Deux writers max** : D2 (UI) devra être séquencé avec Hermes (R1-03c / CHAT-P0).
8. **Itération non commitée de `vps-monitor`** : le worktree `/srv/icos/worktrees/vps-monitor-20261017` contient 16 modifications non commitées datées du 2026-10-17 14:33–14:36 (`worker-capacity.ts`, `worker-footprint-source.ts`, retouches des sondes). Non portées (aucun SHA, propriété de cette lane) ; seul `bb6ddc8` l'a été. À réconcilier par le propriétaire.

## 7. Prochaine étape (D2, non démarrée)

Brancher `readLiveOverview` dans les écrans existants du Control Center (`/cockpit/system` : panneau VPS + services ; `/cockpit/providers` : santé OmniRoute + `priceStatus` ; `/cockpit/workers` : `lastProbeAt`/`stale` ; Overview : fraîcheur par source et incidents), avec `LiveRefresh` existant (polling 15 s), labels source/dernière mesure, et tons vert/orange/gris/rouge de `SOURCE_STATE_TONE`. Aucun redesign ; aucune animation décorative sans flux réel.

Remise au reviewer indépendant : branche `feat/cockpit-live-d1-20261020`, diff `b4d0968..HEAD`, ce rapport, la preuve masquée, la commande de vérification.


## Référence d'autorisation

Étape D1 autorisée par le propriétaire dans la session Claude Code du 2026-10-20 (message « Mission COCKPIT-LIVE — Option A autorisée sous conditions de sécurité »). Revues indépendantes et réponse : `docs/reports/reviews/`, `cockpit-live-claude-d3-review-response-2026-10-20.md`.
