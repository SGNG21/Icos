# ADR-0025 — Durable Scheduler (Phase 7A)

- Statut : accepté
- Date : 2026-09-19
- Portée : 7A uniquement (pas de mémoire, goal intake, Guardian ni multi-worker)

## Contexte

La boucle Phase 6 est autonome une fois une Mission créée, mais rien ne permet de **différer** ou de
**planifier** un travail : une Mission naît d'un appel HTTP immédiat, un réveil n'existe qu'à la suite
d'un callback ou d'un sweep de récupération. Il faut une file durable d'actions différées, dont la
seule source de vérité est PostgreSQL.

Primitives existantes réutilisées (aucune reconstruction) :

| Besoin | Existant réutilisé |
| --- | --- |
| Boucle de déclenchement | `AutonomyRecoveryScheduler` (timer qui ne fait que **consulter** l'état durable via `sweep()`) |
| Claim / lease | pattern `quality_control_jobs` : `FOR UPDATE SKIP LOCKED`, horloge DB `now()`, jeton de propriétaire |
| Démarrer une Mission | `startAutonomousMission` / `AutonomousMissionRunner` (lease de runtime, planner, supervisor) |
| Réveiller une Mission | `AutonomyWakeupService.wake` (idempotent) |
| Composition process | `startProductionServices` (sweepers uniquement en `NODE_ENV=production` + PostgreSQL) |

Manques : table de jobs, création de Mission **idempotente** (`MissionRepository.create` ne prend pas
d'id), permission dédiée, exécuteur.

## Décision

### Table `scheduled_jobs` (migration additive `0030`)

`id`, `kind` (`start_mission` | `wake_mission`), `payload` jsonb, `payload_hash`, `idempotency_key`
(UNIQUE), `state` (`scheduled` | `running` | `succeeded` | `dead` | `expired`), `priority`,
`next_run_at`, `deadline_at?`, `attempt_count`, `max_attempts`, `backoff_base_ms`, `lease_owner?`,
`lease_until?`, `last_error?`, `mission_id?`, `created_at`, `updated_at`, `completed_at?`.
CHECK : un job `running` a toujours `lease_owner` et `lease_until`.

### Invariants

1. **PostgreSQL = vérité.** Le timer ne fait que déclencher `sweep()` ; l'état dû est recalculé en base.
2. **Une seule horloge : `now()` de PostgreSQL** pour `next_run_at`, `lease_until`, backoff, deadline
   (pas de dérive entre processus).
3. **Claim atomique** : une transaction sélectionne un job dû (`scheduled` et `next_run_at <= now()`,
   ou `running` à lease expirée) avec `FOR UPDATE SKIP LOCKED`, l'incrémente (`attempt_count + 1`) et
   pose un jeton de propriétaire **unique par claim**. Deux schedulers ne peuvent pas prendre le même job.
4. **Fencing par jeton** : `renew`, `complete`, `fail` n'aboutissent que si `state = running` et
   `lease_owner = jeton`. Un exécuteur dont la lease a été reprise ne peut plus rien écrire.
5. **Crash après claim** : la lease expire, le job redevient réclamable. Chaque claim consomme une
   tentative : un job qui fait planter le process est `dead` après `max_attempts` (pas de retry infini).
6. **Retry/backoff durables** : `fail(retryable)` remet `scheduled` avec
   `next_run_at = now() + min(backoff_base_ms * 2^(attempt-1), 1 h)` ; au-delà de `max_attempts` → `dead`.
   Erreur non retryable → `dead` immédiatement.
7. **Deadline** : un job dont `deadline_at` est dépassé n'est jamais exécuté → `expired`.
8. **Idempotence logique** : `idempotency_key` unique. Même clé + même `kind`/payload → le job existant
   est renvoyé (`created=false`) ; même clé + autre contenu → `SCHEDULER_IDEMPOTENCY_CONFLICT`.
9. **Effets externes idempotents** : les handlers sont rejouables sans doublon.
   - `start_mission` : l'`id` de la Mission est fixé **à l'enqueue** (`payload.missionId`) ;
     `MissionRepository.create({ id })` est idempotent (même id + même contenu → Mission existante).
     Un crash entre « Mission créée » et « job soldé » ne crée donc jamais une 2ᵉ Mission.
   - `wake_mission` : `AutonomyWakeupService.wake` (lease de runtime, dispatch ledger).
10. **Le scheduler ne dispatch rien lui-même** : il crée/réveille une Mission ; planification et dispatch
    restent au runner + Supervisor (dispatch ledger idempotent).
11. **Heartbeat** de lease pendant l'exécution d'un handler (renouvellement périodique) : ce n'est pas
    une source de vérité, seulement un prolongement de lease fencé.
12. **Autorisation** : nouvelle permission `scheduler.manage` (rôle `admin`, hérité par `owner`) ;
    routes protégées, sameOrigin, jamais de secret dans le payload.

### API

- `POST /api/scheduler/jobs` → `201` (créé) / `200` (rejeu idempotent) / `400` / `409` (conflit de clé).
- `GET /api/scheduler/jobs/{id}`.

- CLI opérateur : `pnpm scheduler:enqueue '<json>'` — adaptateur mince autour de `SchedulerService.enqueue`
  (même validation et idempotence que la route, sans session : accès shell + base requis).

### Récupération (7A)

Redémarrage : rien à reconstruire en mémoire. Au premier `sweep()` après restart, les jobs `scheduled`
dus et les jobs `running` à lease expirée sont revendiqués. Intervalle : celui du sweeper existant
(`AUTONOMY_RECOVERY_INTERVAL_MS`) ; lease : `SCHEDULER_LEASE_MS` (défaut 2 min).

## Hors périmètre 7A

Mémoire opérationnelle (7B), récupération générale de tous les états orphelins (7C), Goal Intake (7D),
multi-workers / backpressure / annulation (7E), Guardian. Pas de cron récurrent : un job récurrent
s'exprime en ré-enqueuant avec une nouvelle clé (extension ultérieure).

## Plan de tests

Contrat de dépôt commun (in-memory + PostgreSQL réel `icos_test`) : job futur non exécuté trop tôt ;
claim atomique ; double claim concurrent (N claimers) ; lease expirée reprise ; complétion d'un
propriétaire évincé refusée ; crash après claim + `max_attempts` ; clé d'idempotence (rejeu, conflit,
concurrence) ; retry/backoff durables ; deadline ; priorité. Service : deux schedulers concurrents ;
retry/permanent/dead ; crash simulé. Handlers : `start_mission` rejoué = une seule Mission.
HTTP : auth, création, rejeu, conflit, validation. Migration : base vierge. Live E2E : job futur puis dû
→ vraie Mission (Temporal/Hermes/QC) ; kill -9 pendant un job puis restart sans doublon.

## Validation (2026-09-19)

Tests : contrat de dépôt partagé in-memory + PostgreSQL réel (`icos_test`), 20 concurrents / 5 jobs,
mutation `FOR UPDATE SKIP LOCKED` détectée, exécuteur (2 schedulers, retry, permanent, crash, heartbeat,
perte de lease), handlers rejouables, création de Mission idempotente, routes HTTP (auth, 201/200/409/400).
Live E2E : (A) job à +40 s -> exécuté à l'échéance, Mission unique, Hermes, QC ACCEPT ; (B) `kill -9`
pendant le job `running` -> reprise après expiration de lease (`attempt_count = 2`), une seule Mission,
un seul dispatch, une seule exécution Temporal.
