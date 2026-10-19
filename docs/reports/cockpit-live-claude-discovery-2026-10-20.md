# COCKPIT-LIVE-CLAUDE — Rapport D0 (inventaire de réalité, lecture seule)

- **Date :** 2026-10-20 (relevés 2026-10-19 23:16 → 23:21 UTC, soit 01:16 → 01:21 CEST)
- **Mission :** `docs/worker-missions/COCKPIT_LIVE_CLAUDE_2026-10-20.md`
- **Worktree :** `/home/icos/icos-worktrees/cockpit-live-claude`, branche `feat/cockpit-live-claude-20261020`, HEAD `ca138e2` (= `main`)
- **Méthode :** lecture seule. Aucun fichier d'un autre worktree modifié, aucune session interrompue, aucune écriture en base, aucun appel LLM facturable. Lectures externes : `git ls-tree`/`git show` sur d'autres refs (sans checkout), `docker exec … psql` en requêtes agrégées sans identifiant, `temporal task-queue describe`, deux `GET` loopback vers OmniRoute (`/api/monitoring/health`, `/v1/models`, aucun appel de modèle), `systemctl show/cat`, `/proc`.
- **Statut de phase :** D0 `REVIEW_READY` · D1/D2/D3 `BLOCKED` (obstacle de lignée, §8).

---

## 1. Résultat en une page

1. **Il n'y a pas un cockpit mais trois états de cockpit**, sur deux lignées Git qui ont divergé à `0a91604` (80 commits de `main` d'un côté, 519 à 579 commits de l'autre) :
   - **`main` (ca138e2, base de cette branche)** : cockpit V1 « supervision » (`CkSupervisorSurface` rendu sur `/`), API `POST /api/cockpit/jobs` + `GET /api/cockpit/jobs/[id]`, fixtures locales. **Aucune** page `src/app/cockpit/*`, aucun graphe, aucune table CORE3/scheduler/registre de workers/ledger (10 migrations seulement, 8 ADR).
   - **Lignée déployée (`feat/cockpit-agentic-os` = `5719213`, `/srv/icos/current`, service `icos-web`, port 4173)** : **ICOS Control Center** (`src/app/cockpit/{page,executive,workers,providers,system,missions,pipeline,alerts,audit,autonomy,ask,self-development,settings}`), chargeur serveur `src/features/cockpit/load.ts` (lecture canonique sous scope), `snapshot.ts`, `truth-projection.ts` (ADR 0069), `live.ts` (polling 15 s, `STALE` > 45 s). 64 migrations, 62 ADR (0001 → 0078).
   - **Carte cognitive / cockpit A0 « graph »** : existe uniquement sous forme de **40 fichiers indexés, non commités** dans `/srv/icos/worktrees/cockpit-agentic-os` (`src/app/cockpit/graph/page.tsx`, `graph-view.tsx`, `graph-panels.tsx`, `graph-layout.ts`, `graph-telemetry*`, `scripts/lab-seed-cockpit-graph.mts`, `audit/cockpit-agentic-os/*`). Propriété : la lane cockpit-agentic-os, pas la mienne. Aucun SHA.
2. **Le hub de convergence** `feat/fable-5-1-convergence` (`b4d0968`) est 58 commits devant la release déployée (ADR 0078 FREE_TIER, cache ledger W9/W10, recovery heartbeat, meta-routes). `feat/worker-footprint-20261017` (`53ff234`) ajoute par-dessus la mesure cgroup v2 des workers (ADR 0083 proposé).
3. **Les cinq sources demandées existent en production — sur la lignée déployée, pas sur `main`** (§5). Les tables sont réelles et fraîches : 15 workers sondés à 23:20:17 UTC, 3 jobs scheduler actifs, 25 636 appels OmniRoute en 24 h dans `spend_ledger` (100 % `UNPRICED`), 99 `memory_records`. En revanche **0 mission / 0 goal / 0 dispatch**, 0 poller Temporal sur `icos-tasks` (`default` et `icos-prod`) : le runtime live est « cockpit + cognition + sondes sans bras », conclusion identique au diagnostic du 2026-10-11 (`docs/icos/COCKPIT_LIVE_DIAGNOSTIC_2026-10-11.md` sur le hub).
4. **Source VPS (`/proc`)** : absente des deux lignées déployée/hub. Elle existe sur `main` dans la branche non intégrée `feat/vps-monitor-20261017` (`849627b` + `bb6ddc8`, 2 commits, lignée `main`, `node_modules` présents dans son worktree) : `src/server/telemetry/{host-sampler,proc-parsers,service-probes,rate-limit}.ts`, `src/core/telemetry/host-telemetry.ts`, `GET /api/cockpit/telemetry` (rôle `operator`, rate-limit), `src/server/ai/omniroute-monitoring.ts` (route native `/api/monitoring/health`, liste blanche de champs).
5. **Obstacle (§8)** : implémenter D1/D2 sur `main` reviendrait à créer une deuxième application cockpit sans les sources réelles, ce que la mission interdit (« ne jamais ajouter une deuxième application », « brancher les composants existants », « conserver le cockpit A0 et sa carte cognitive »). Il faut un arbitrage propriétaire sur la lignée de base avant toute modification.

---

## 2. Dépôt, worktrees, lignées (sans modification)

| Élément | Valeur |
| --- | --- |
| Dépôt principal | `/srv/icos/repo` @ `ca138e2` [`main`], remote `origin = github.com:SGNG21/Icos.git` |
| Ce worktree | `/home/icos/icos-worktrees/cockpit-live-claude` @ `ca138e2` [`feat/cockpit-live-claude-20261020`], propre sauf `docs/worker-missions/` (non suivi, déposé par le propriétaire) et ce rapport |
| Worktrees actifs | 101 (`git worktree list`) ; aucun autre worktree n'a été ouvert en écriture |
| Release déployée | `/srv/icos/current -> /srv/icos/releases/5719213` ; `icos-web.service` actif depuis 2026-10-18 17:49 CEST, `NRestarts=0`, `WorkingDirectory=/srv/icos/current`, `EnvironmentFile=/srv/icos/etc/icos.env` (noms de variables seuls relevés, jamais les valeurs) |
| Autres unités | `icos-omniroute.service` (OmniRoute 3.8.49, `serve --port 20129`, loopback) ; aucune unité `icos-temporal-worker` installée |
| Lignée `main` | `ca138e2` ← PR #20 hardening (NF-1/NF-3/NF-5, CI minimal `.github/workflows/ci.yml`) |
| Lignée produit | `0a91604` (merge-base) → `5719213` (déployé, `feat/cockpit-agentic-os`) → `b4d0968` (`feat/fable-5-1-convergence`, +58) → `53ff234` (`feat/worker-footprint-20261017`, +2) ; `origin/deployed/vps-20261010` = `dec9fcb` (427 commits devant `main`) |
| Branche VPS monitor (lignée `main`) | `feat/vps-monitor-20261017` = `ca138e2` + `849627b` + `bb6ddc8` (non intégrée) |
| Commits cockpit non intégrés dans `main` | tous ceux de la lignée produit (519 → 579) ; côté `main` : `feat/vps-monitor-20261017` (2) |

Base de données applicative : conteneur `icos-app-postgres` (127.0.0.1:5433, base `icos_app`), **61 migrations Drizzle appliquées**, 75 tables publiques (dont `workers`, `scheduled_jobs`, `goals`, `missions`, `mission_tasks`, `dispatch_attempts`, `quality_control_jobs`, `icos_workspace_registry`, `spend_ledger`, `spend_reservations`, `memory_records`, `memory_retrieval_log`, `audit_entries`, `workforce_agents`, `cognitive_*`, `control_*`, `tool_*`). Le schéma Drizzle de `main` (21 tables) ne décrit qu'un sous-ensemble : **`main` ne peut pas lire ces tables sans le code de la lignée produit.**

Autres instances (ne pas confondre) : `icos-test-postgres` :5432, `icos-gate-postgres` :5434, `fable-pg-lab` :55460, `icos-test-temporal` :7233 (namespaces `default`, `icos-prod`, `temporal-system`), `p0au-temporal` :17233 (labo).

---

## 3. Le cockpit réel : composants, endpoints, authentification

### 3.1 Sur `main` (base de cette branche)

| Chemin | Rôle | Auth |
| --- | --- | --- |
| `src/app/page.tsx` | rend `CkCockpitApp` après `resolveCockpitAccess` (`cockpit.read`) ; `force-dynamic` | redirect `/login` si non authentifié, `forbidden()` sinon |
| `src/components/cockpit/Ck*.tsx` (8 composants + tests) | shell, sidebar, conversation, composer, `CkSupervisorSurface` (missions/tâches/workers/bloqueurs) | — |
| `src/features/cockpit/{clients,http-clients,development-adapters,store,mocks/*}.ts` | contrat `CockpitJobProjection`, client HTTP Zod, **fixtures locales** (`dataLabel: "Données locales simulées — aucune autorité d'exécution"`) | — |
| `POST /api/cockpit/jobs` | soumet un job (idempotency UUID, `operator`, same-origin) → `getCockpitRuntime().submitJob` | `protectRoute` + `tenantResolver.resolve` (mono-tenant `default`) |
| `GET /api/cockpit/jobs/[id]` | projection d'un job | `cockpit.read` + tenant |
| `src/server/cockpit/{runtime,job-registry,projection,request-router}.ts` | runtime mémoire, mission en mémoire (`InMemoryMissionRepository`) | — |

Autres routes `main` : `/api/{agents,tasks,actions,audit,capabilities,skills,users,admin,auth}`. Permissions (`src/core/identity/permissions.ts`) : `viewer ⊂ operator ⊂ admin ⊂ owner`, `cockpit.read` dès `viewer`, `audit.read.full` dès `operator`. Tenant : `SingleTenantResolver` (fail-closed sans session, ignore tout header client ; tests TENANT-01…09). Aucune RLS PostgreSQL dans les migrations de `main` (ni dans celles de la lignée produit relevées).

### 3.2 Sur la lignée déployée (`5719213`)

| Chemin | Rôle | Auth / scope |
| --- | --- | --- |
| `src/app/cockpit/layout.tsx` | Control Center (PWA, rail, `LiveRefresh`), `force-dynamic` | `getCockpitContext()` → `resolveCockpitAccess` ; refus rendu explicitement (« Access denied ») |
| `src/app/cockpit/page.tsx` | Overview : 14 tuiles `MetricKey` (`globalHealth`, `autonomyLevel`, `activeMissions`, `activeWorkers`, `readyQueue`, `reviewBacklog`, `integrationBacklog`, `mustNow`, `providerHealth`, `cost`, `tokenThroughput`, `latency`, `humanInterventions`), `SystemMap`, alertes | idem |
| `/cockpit/executive`, `/workers`, `/providers`, `/system`, `/missions[/id]`, `/pipeline`, `/alerts`, `/audit`, `/autonomy`, `/ask`, `/self-development`, `/settings`, `/control-room` | écrans existants | idem ; `/system` expose des commandes (safe mode) via control plane |
| `src/features/cockpit/load.ts` (431 l.) | **seul point de contact** cockpit → ICOS : `loadSources`, `loadTruthProjection`, `loadSystemFacts`, `loadReadModels` ; chaque source lue isolément → `Truth<T>` `real`/`missing(code, reason, requirement)` | scope opérationnel `resolveOperationalScope` ; mémoire/ledger/backlog **owner/admin (global) seulement** |
| `src/features/cockpit/snapshot.ts` (965 l.) | read model unique, tons `flow/ok/critical/autonomy/warn/unknown` | pur |
| `src/features/cockpit/live.ts` | polling 15 s, backoff ≤ 120 s, `STALE_AFTER_MS = 45 000`, états `LIVE/STALE/OFFLINE/ERROR/UNAVAILABLE` | — |
| `GET /api/cockpit` | projection READ-ONLY (counts, activeWork, attentionRequired, recentResults, pendingApprovals) | `cockpit.read` + `listForScope` |
| `GET /api/control/state`, `/api/scheduler/jobs`, `/api/goals`, `/api/missions`, `/api/voice/status`, `/api/tool-gateway/cockpit` | lectures existantes | `protectRoute` |

Le contrat transversal demandé par la mission (`Observed<T>` avec `state/observedAt/collectedAt/maxAgeMs/source`) a déjà un équivalent canonique sur cette lignée : `Truth<T>` (`src/features/cockpit/truth.ts`) + `LinkState` (`live.ts`) + `ServiceHealth/Measured<T>` (`feat/vps-monitor-20261017`). **Un nouveau vocabulaire ne doit pas être introduit** ; au plus une extension (`observedAt`, `maxAgeMs`) à documenter.

---

## 4. Concurrence effective (observée, non touchée)

| Session / processus | État | Portée connue |
| --- | --- | --- |
| tmux `icos-hermes` (attachée), Hermes PID 802911 (python, cwd `/home/icos/icos-hermes-handoff`) + LSP tsserver 841921/841933 | actif | Passation 2026-10-19 : R1-03c (`/srv/icos/worktrees/r1-03c-operator-escalation`, `6934d68`), puis audit des 10 worktrees CHAT-P0 ; Codex via OmniRoute ; « pas plus de deux writers simultanés », « jamais deux writers sur les mêmes fichiers » |
| Claude PID 846872 (cwd `/home/icos/icos-hermes-handoff`) | actif | reviewer lecture seule pour Hermes (checkpoint 00:12) |
| tmux `icos-cockpit-live-claude` (cette session, PID 851439) | actif | ce worktree uniquement |
| tmux `polivia-preview` ; `next-server` PID 251537 (`/srv/icos/labs/polivia-site-factory/...`, :4173 ?) | actif | Site Factory, hors périmètre |
| FABLE (`/srv/icos/worktrees/fable-autonomy-convergence-20261017`, `ca138e2`) | pas de tmux `icos-fable` observé | lane propriétaire ; la mission qualifie FABLE de coordinateur **provisoire** et le mandat Hermes le place en lecture seule ; **non vérifié comme enregistrement natif CORE3** (`workforce_agents` = 0 ligne) |
| `icos-web` (PID 2447, 2,7 Go RSS, 31 % CPU cumulé), `omniroute` (PID 86645, 1,8 Go RSS) | prod | ne pas redémarrer |

Aucune interaction avec ces sessions. Worktrees de la lignée produit avec modifications non commitées : `cockpit-agentic-os` (40 fichiers indexés, graphe A0), `fable-5-1-convergence` (5 docs non suivis). Je ne les prends pas.

**Ressources VPS au relevé :** 8 vCPU, load 2,05 / 2,15 / 1,63 ; RAM 24 031 Mo dont 8 692 utilisés, 15 338 disponibles ; swap 0 ; disque `/` 290 Go, 66 Go utilisés (23 %) ; **aucun GPU** (`/dev/nvidia*` absent, pas de `nvidia-smi`) → VRAM = `NO_TELEMETRY`, à ne jamais afficher autrement. Ubuntu 24.04.5, noyau 6.8.0-147. Marge suffisante pour `pnpm test`/`typecheck` (1 processus, pas de `pnpm build` concurrent).

---

## 5. Matrice des cinq sources

Légende : état **sur la lignée déployée/hub** (ce que la prod sait lire) et **sur `main`** (ce que cette branche sait lire aujourd'hui). Horloge de référence : base `now() = 2026-10-19 23:20:54 UTC`.

### 5.1 CORE3 / Goal Planner / scheduler durable

| Critère | Valeur |
| --- | --- |
| État déployé | **PRESENT (vide côté missions)** : tables `goals` (0), `missions` (0), `mission_tasks` (0), `dispatch_attempts` (0, colonnes `claim_token/claim_until/execution_lease_owner/execution_lease_until/routing_decision/failure_class`), `quality_control_jobs` (0), `icos_workspace_registry` (0), `scheduled_jobs` (23 486 lignes ; 3 actives : `probe_workers` → 23:20:30, `reconcile_compute_fleet` → 23:25, `supervisor_observe` → 23:30 ; `max(updated_at)` 23:20:24) |
| État `main` | **MISSING** : aucune de ces tables dans `src/server/database/schema.ts` ; `src/core/supervisor`, `src/server/mission/in-memory` = DAG/mission **en mémoire** seulement |
| Contrat connu | `src/core/contracts/scheduler.ts` (ADR-0025 : `ScheduledJob`, `claimDue/renewLease/complete/fail`, fencing par `leaseOwner`), `src/core/contracts/high-level-goal.ts`, `src/core/mission/contracts.ts`, `dispatch-attempt.ts` (lignée produit) |
| Source de vérité | PostgreSQL `icos_app` ; Temporal `icos-test-temporal` namespace `icos-prod` (0 poller sur `icos-tasks`, backlog 0) |
| Lecture exposée | `loadSources` (missions + tasks + attempts + qualityJobs + workspaces), `GET /api/missions`, `/api/goals`, `/api/scheduler/jobs` |
| Permissions | `cockpit.read` + scope opérationnel ; QC/workspaces owner/admin |
| Freshness | `scheduled_jobs.updated_at`, `dispatch_attempts.updated_at`, `missions.updated_at` ; polling cockpit 15 s / stale 45 s |
| Propriétaire technique | lanes CORE3/scheduler (ADR 0025, 0044, 0045, 0074) ; **hors scope d'écriture** |

### 5.2 Worker Registry / Runtime (flotte)

| Critère | Valeur |
| --- | --- |
| État déployé | **PRESENT** : `workers` = 15 lignes, 11 `healthy+available`, `last_probe_outcome` : 11 `ok`, 3 `failed` (classes `AUTH_FAILURE`, `UNAVAILABLE`, `UNKNOWN`), 1 `stale` ; `max(last_probe_at) = 23:20:17 UTC` (sonde `probe_workers` ~30 s, vivante). Cerveaux logiques : `workforce_agents` = **0** (aucune composition déployée). Affectations : `dispatch_attempts` = 0 |
| État `main` | **MISSING** : pas de `src/core/contracts/worker-registry.ts`, pas de table `workers` ; `src/server/worker/worker-manager.ts` = gestionnaire local en mémoire |
| Contrat connu | `workerRegistryEntrySchema` (`health`, `availability`, `lastProbeAt`, `lastProbeOutcome never/ok/failed/unsupported/stale`, `lastProbeErrorClass`, `maxConcurrency`, `capacityPool`), `listActiveWorkerAssignments()` (ledger de dispatch), ADR 0031/0032/0036/0054/0064 |
| Source de vérité | table `workers` + preuve de sonde ; **jamais** la session tmux ou l'existence d'un processus |
| Lecture exposée | `loadSources.workers` (owner/admin), `/cockpit/workers`, `providerHealthMetric` (routables / enregistrés) |
| Freshness | `last_probe_at` (ADR 0036 : preuve sans date = non fiable ; `stale` posé durablement par le sweeper) |
| Propriétaire | lanes W1/W6/W11, worker-footprint (cgroup v2, ADR 0083 proposé) |

### 5.3 OmniRoute (appels, usage, coût, latence, erreurs, quotas, route)

| Critère | Valeur |
| --- | --- |
| État déployé | **PARTIAL** : (a) `spend_ledger` = 198 874 lignes ; 24 h : **25 636 appels, 25 636 `UNPRICED`**, `cost_kind=UNPRICED`, `max(observed_at)` 23:20:16 UTC (colonnes `model_id`, `brain_id`, `goal_id`, `usage_kind`, `prompt/completion/total_tokens`, `unmetered_reason`, `unpriced_reason`) → tokens réels, **coût inconnu, jamais 0** (ADR 0067-pricing, 0078 FREE_TIER sur le hub) ; (b) `/api/monitoring/health` natif OmniRoute 3.8.49 : HTTP 200 en 78 ms, `status=healthy`, uptime 91 457 s, disjoncteurs `closed 5 / degraded 2 / open 0 / total 7`, providers `configured 15 / active 8 / monitored 7 / catalog 299` ; (c) `/v1/models` : HTTP 200 sans clé (point C du diagnostic 10-11, toujours ouvert). **Latence** : non mesurée côté ICOS (`providerTelemetry()` rend `missing`), `execution_duration_ms` seulement sur `dispatch_attempts` (0). **Erreurs/quotas par route** : dans `storage.sqlite` d'OmniRoute (382 Mo, `/srv/icos/omniroute`, lecture par un tiers = DENIED par principe : pas de compte minimal ni de contrat) |
| État `main` | **PARTIAL** : `src/server/ai/omniroute-adapter.ts` (hooks `onRequestCompleted` avec `latencyMs/providerId/modelId/tokens/costUsd`, non persistés), `AiHealthPort.check()` ; **aucun ledger**. `feat/vps-monitor-20261017` ajoute `omniroute-monitoring.ts` (liste blanche : `status`, `circuitBreakers`, `providerSummary`, `providerHealth.state/failures` ; jamais `lastFailure`, sessions, quotas, credentials) |
| Source de vérité | `spend_ledger` (ADR 0055/0056, « une absence n'est jamais un zéro ») pour usage/coût ; route monitoring pour santé ; sondes `workers` pour disponibilité par modèle |
| Permissions | ledger : owner/admin ; monitoring : rôle `operator` (vps-monitor) ; aucune donnée client dans ces surfaces |
| Freshness | `observed_at` ; monitoring TTL 15 s (`ServiceProbes`) |
| Propriétaire | lanes budget/pricing (0067, 0078), OmniRoute hotfix 3.8.49 (déployé 2026-10-18, ne pas toucher) |

### 5.4 PostgreSQL / mémoire (états durables, événements, provenance)

| Critère | Valeur |
| --- | --- |
| État déployé | **PRESENT** : `memory_records` = 99 (`max(updated_at)` 2026-10-19 16:07 UTC ; colonnes `tenant_id`, `epistemic`, `provenance`, `sensitivity`, `retention`, `valid_from/until`, `supersedes_id`, `contradicts_id`), `memory_retrieval_log` = 534, `memory_entities/relations`, `audit_entries` = 2 845 (0 sur 24 h via `created_at`), `cognitive_*`, `control_state_versions`, `checkpoints`. Connexion : `PERSISTENCE=postgres` (nom de variable présent dans `icos.env`), pool du container |
| État `main` | **PARTIAL** : `audit_entries` append-only (trigger 0001), `mission_contexts` (0009), `execution_records`, `execution_grants`, `idempotency_entries` ; **pas** de mémoire durable ni de graphe de connaissances |
| Contrat connu | `loadTruthProjection.memory` (`records`, `active`, `retrievals24h`), `DurableImprovementBacklog`, `measureRuntimeCapabilities` (ADR 0062/0069) |
| Permissions | owner/admin pour mémoire ; `audit.read.full` pour la timeline ; `tenant_id` colonne présente mais résolveur mono-tenant `default` → **aucune RLS**, isolation = scope applicatif |
| Freshness | `updated_at`, `retrieved_at` ; aucune projection « knowledge » par nœuds/relations n'est exposée au cockpit (candidat `GET …/knowledge` = **MISSING** côté lecture, tables `memory_entities/relations` présentes mais non comptées ici) |
| Propriétaire | lanes cognitive/memory (0011, 0031, 0050, 0054) |

### 5.5 VPS (`/proc`, OS, ressources, files)

| Critère | Valeur |
| --- | --- |
| État déployé / hub | **MISSING** : aucun module télémétrie hôte dans `5719213` ni `b4d0968` ; `system-status.ts` ne fait que dériver l'état des dépendances de la config (sans mesure) ; `worker-footprint` (53ff234) mesure les **workers** (cgroup v2), pas l'hôte |
| État `main` | **MISSING sur `ca138e2`, PRESENT sur `feat/vps-monitor-20261017`** (`bb6ddc8`) : `host-sampler.ts` (CPU, par-cœur, iowait, load, mémoire, disque, réseau, PSI `/proc/pressure`), `host-telemetry.ts` (`Measured<T>`, tons `ok/degraded/incident/improve`), `GET /api/cockpit/telemetry` (operator, rate-limit, anti-cache), `service-probes.ts` (PostgreSQL ping, OmniRoute monitoring, runtime cockpit ; « un service sans sonde est Non instrumenté, jamais Opérationnel »), 28 fichiers / ~7 200 lignes avec tests |
| Mesure directe au relevé | §4 (8 vCPU, load 2,05, RAM 8 692/24 031 Mo, disque 23 %, pas de GPU) |
| Source de vérité | `/proc` de l'hôte où tourne `icos-web` ; horodatage de l'échantillon ; VRAM = `NO_TELEMETRY` |
| Permissions | `operator` et plus (données d'infrastructure) |
| Freshness | échantillonnage ~10 s, TTL 15 s |
| Propriétaire | branche `feat/vps-monitor-20261017` (G. Nozza, 2026-10-17), non intégrée, non revue |

### 5.6 Synthèse

| Source | Déployé/hub | `main` | Candidat le plus proche |
| --- | --- | --- | --- |
| CORE3/scheduler | PRESENT (vide) | MISSING | `loadSources` + `scheduled_jobs` |
| Workers | PRESENT | MISSING | `workers` + ledger dispatch |
| OmniRoute | PARTIAL (coût UNPRICED, latence non mesurée) | PARTIAL (adapter sans ledger) | `spend_ledger` + `omniroute-monitoring.ts` |
| PostgreSQL/mémoire | PRESENT (pas de projection knowledge) | PARTIAL | `loadTruthProjection` + `memory_entities/relations` |
| VPS | MISSING | MISSING (PRESENT sur `vps-monitor`) | `host-sampler.ts` + `service-probes.ts` |

---

## 6. État des tests

- **Ce worktree : aucun test exécuté.** `node_modules` absent ; `pnpm install` non lancé (mission : pas d'install massif non justifié). Lockfile identique à `/srv/icos/repo` et à `/srv/icos/worktrees/vps-monitor-20261017` (qui possède ses `node_modules`) ; store pnpm `~/.local/share/pnpm/store/v11` présent → un `pnpm install --frozen-lockfile --offline` serait peu coûteux **si** la lignée reste `main`. Sur la lignée produit, le lockfile diffère (à vérifier avant tout install).
- CI (`.github/workflows/ci.yml`) : lint → typecheck → test → build → compliance (markers, secrets), `NODE_ENV`/`PERSISTENCE` non définis. `gh` absent sur l'hôte : statut CI de `ca138e2` non vérifié ici.
- Conventions : Vitest `src/**/*.test.ts(x)` (composants cockpit rendus en `renderToStaticMarkup`, env node), intégration PG via Testcontainers `*.integration.test.ts` (Docker), `GlobalGates` séquentielles avec allowlist d'env (NF-5). Lignée produit : tests de rendu `src/components/cockpit/render.test.ts`, `src/features/cockpit/*.test.ts`, `pnpm autonomy:assess` (ADR 0077).

---

## 7. Gouvernance relevée (à respecter en D1–D3)

- `AGENTS.md` : une étape à la fois, arrêt après rapport ; aucune suppression, aucun secret, aucun push/force-push/action externe sans autorisation.
- ADR 0044 : IntegrationGate seulement après revue indépendante ; 0045 : gate « pending review » = balayage de reprise. ADR 0069 : la couche produit **projette une vérité mesurée** (`NOT AVAILABLE` + code d'exigence, jamais une estimation). ADR 0077 : autonomie mesurée depuis des preuves durables. ADR 0062/0064 : self-model mesuré, flotte réconciliée jamais « activée ». ADR 0067/0078 : prix = registre daté, argent en micros entiers, `UNPRICED`/`FREE_TIER` explicites, jamais 0 par défaut.
- Passation Hermes 2026-10-19 : ≤ 2 writers simultanés sur le VPS, jamais deux writers sur les mêmes fichiers ; pas de scheduler bis ; CORE3/Work OS/Goal Planner/Durable Scheduler/IntegrationGate restent les autorités.
- `docs/ICOS_ULTIMATE_NORTH_STAR.md` : **absent** des deux lignées (grep). Master plan = `docs/ICOS_MASTER_PLAN.md` ; constitution au sens strict : non trouvée sous ce nom ; les ADR font autorité.

---

## 8. Obstacle et arbitrage demandé

**Constat.** La branche de mission est basée sur `main`, où ni le cockpit A0 (Control Center + carte cognitive), ni les tables CORE3/scheduler/registre/ledger/mémoire n'existent. Implémenter D1 sur `main` produirait un second cockpit avec des adaptateurs sans sources (ou des accès SQL ad hoc à des tables que le schéma Drizzle de la branche ne connaît pas), en contradiction avec §1 et §5 de la mission. Je m'arrête donc avant toute modification de code.

**Options (décision propriétaire, pas la mienne) :**

| Option | Base | Ce que D1/D2 deviennent | Risques |
| --- | --- | --- | --- |
| **A (recommandée)** | Recréer `feat/cockpit-live-claude-20261020` depuis le hub `feat/fable-5-1-convergence` (`b4d0968`) | Le Control Center, `load.ts`, `Truth`, `live.ts`, `spend_ledger`, `workers`, `scheduled_jobs` sont déjà là. Travail réel = (1) **VPS** : porter `host-sampler/proc-parsers/service-probes/rate-limit` + `GET /api/cockpit/telemetry` depuis `bb6ddc8` (fichiers nouveaux, port presque mécanique), brancher sur `/cockpit/system` ; (2) **OmniRoute santé** : porter `omniroute-monitoring.ts` (liste blanche) et remplacer la tuile `Latency = missing` par une mesure réelle ou laisser `NOT AVAILABLE` ; (3) **fraîcheur** : exposer `observedAt/maxAgeMs` par source dans `snapshot` (extension de `Truth`, pas nouveau vocabulaire) ; (4) **knowledge** : compter `memory_entities/relations` dans `loadTruthProjection` (owner/admin) ; (5) tests Vitest + rendu + autorisation (viewer/operator/non-authentifié) | Lockfile différent → `pnpm install` à justifier ; hub en mouvement (Hermes, FABLE) ; la carte cognitive reste hors d'atteinte tant qu'elle n'est pas commitée par sa lane |
| **B** | Rester sur `main` | Intégrer `feat/vps-monitor-20261017` (2 commits, déjà `main`-compatible, 7 200 lignes testées) après revue ; le cockpit V1 reçoit VPS + santé OmniRoute + PostgreSQL ping. CORE3/workers/ledger/mémoire restent **MISSING** par construction | Ne répond pas au mandat « cockpit A0 / Executive Office » ; `main` n'est pas ce qui est déployé |
| **C** | `feat/cockpit-agentic-os` + graphe | Même chose que A plus la carte cognitive | Exige que la lane cockpit-agentic-os **commite** ses 40 fichiers indexés ; je ne dois pas les prendre ; 58 commits derrière le hub |

**Fichiers que je modifierais sous l'option A (déclaration, aucun touché) :** `src/server/telemetry/*` (nouveaux), `src/core/telemetry/*` (nouveaux), `src/app/api/cockpit/telemetry/route.ts` (nouveau), `src/server/ai/omniroute-monitoring.ts` (nouveau), `src/features/cockpit/{load,snapshot,truth-projection}.ts` (extension lecture seule), `src/app/cockpit/{system,providers}/page.tsx` + un composant d'infrastructure (affichage), `src/server/container.ts` (port `databaseHealth` en lecture), tests associés, `docs/reports/*`. **Jamais :** `src/server/scheduler/*`, `src/server/execution/*`, `src/server/budget/*` (écriture), migrations, `.env`, `deploy/*`.

**Proposition de correspondance endpoints (mission → existant, option A) :**

| Intention mission | Existant / à faire |
| --- | --- |
| `GET /api/cockpit/live/overview` | `GET /api/cockpit` (existant) + `snapshot.health/alerts` ; ajouter la fraîcheur par source |
| `…/missions` | `GET /api/missions`, `/api/goals`, `/api/scheduler/jobs` (existants) |
| `…/workers` | `loadSources.workers` + `/cockpit/workers` (existant) |
| `…/omniroute` | `loadTruthProjection.spend` (existant, `UNPRICED` explicite) + monitoring santé (à porter) |
| `…/resources` | `GET /api/cockpit/telemetry` (à porter depuis `bb6ddc8`) |
| `…/knowledge` | extension de `loadTruthProjection.memory` (à faire, owner/admin) |

Aucune nouvelle route n'est nécessaire sauf `telemetry` ; pas de SSE/WebSocket (le polling `live.ts` existe), pas de nouveau port.

---

## 9. Risques, limites, blocages

1. **Lignée** (bloquant) : voir §8.
2. **Deux writers max** : Hermes (R1-03c puis CHAT-P0) + éventuellement un writer Nemotron ; ma phase D1 compterait comme writer. À séquencer avec le propriétaire.
3. **Coût** : la lecture seule n'engendre aucun appel modèle ; `GET /v1/models` et `/api/monitoring/health` sont gratuits mais `/v1` reste **sans clé** (C non appliqué).
4. **Isolation tenant** : mono-tenant `default`, pas de RLS ; « tenant A ≠ tenant B » n'est testable que par le résolveur (déjà couvert) tant qu'il n'existe qu'un tenant.
5. **Temporal** : prod partage `icos-test-temporal` ; 0 poller → toute tuile « exécution » doit rester `UNPROVEN`, pas rouge (aucun incident, une absence).
6. **GPU** : aucun ; VRAM à afficher `NO_TELEMETRY` (gris) sans exception.
7. **Audit** : `audit_entries` 0 sur 24 h via `created_at` alors que des sondes tournent → vérifier quelle colonne porte l'horodatage avant d'afficher « 24 h ».

---

## 10. Statut

| Phase | Statut | Preuve |
| --- | --- | --- |
| D0 | `REVIEW_READY` | ce rapport ; relevés horodatés §2, §4, §5 |
| D1 | `BLOCKED` | arbitrage de lignée (§8) |
| D2 | `BLOCKED` | idem ; carte cognitive non commitée dans sa lane |
| D3 | `BLOCKED` | idem |

Aucun merge, aucun déploiement, aucune certification. Prochaine action possible après décision : recréer la branche sur la base choisie, puis D1 restreint aux fichiers déclarés.
