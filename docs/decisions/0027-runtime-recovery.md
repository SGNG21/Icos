# ADR-0027 — Runtime Wakeup / Recovery généralisé (Phase 7C)

- Statut : accepté
- Date : 2026-09-19
- Portée : 7C uniquement (ni scheduler 7A, ni mémoire 7B, ni Goal Intake / Guardian / multi-workers)
- Objectif : `kill process → restart → ICOS continue`, sans intervention humaine, sans double exécution,
  sans perte d'état, sans faux succès.

## 1. Inventaire des états récupérables

| #   | État durable (PostgreSQL)                                                                                                                  | Couvert avant 7C ?                                                                                                 | Mécanisme 7C                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 1   | Runtime `running`/`replanning`, lease expirée ou absente                                                                                   | oui (`AutonomyRecoverySweeper`)                                                                                    | inchangé                                                                  |
| 2   | Runtime `waiting`, **aucune tâche active**, mission non terminale (callback traité mais réveil perdu ; toutes tâches terminales)           | **non** (`listRecoverable` exclut `waiting`)                                                                       | unité `waiting_settled`                                                   |
| 3   | `dispatch_attempts.prepared` sans claim vivant (crash entre `prepare` et confirmation)                                                     | seulement si un runner autonome tourne                                                                             | unité `dispatch_prepared_stale` (indépendante du runtime)                 |
| 4   | `dispatch_attempts.dispatched` sans `task_execution_results`, ancienne (workflow Temporal interrompu / non corrélé / callback perdu)       | **non**                                                                                                            | unité `dispatch_orphaned` + sonde Temporal                                |
| 5   | `task_execution_results` sans `quality_control_jobs` (crash après callback avant enregistrement QC ; l'enregistrement est fire-and-forget) | partiel : `recoverUnregistered` n'était atteint que si la mission avait déjà un autre job listé                    | `listRecoverableMissionIds` inclut les missions à résultat non enregistré |
| 6   | QC `review_pending`/`reviewing`/`decision_ready`/`review_unavailable` (claim expiré / cooldown écoulé)                                     | listé, mais **un job `reviewing` à claim expiré n'était jamais reprenable** (`claimNext` l'ignorait : défaut réel) | `claimNext` reprend aussi `reviewing` (et compte la tentative)            |
| 7   | QC `wakeup_pending` (action appliquée, réveil non livré)                                                                                   | oui (outbox)                                                                                                       | inchangé                                                                  |
| 8   | Jobs `scheduled_jobs` dus ou `running` à lease expirée                                                                                     | oui (7A, `DurableScheduler`)                                                                                       | **non touché** — déjà composé via `sweepWithScheduler`                    |

## 2. Machine d'état de recovery (unité de reprise)

Une _unité_ = `(kind, unit_key)` dans `recovery_units`. `unit_key` embarque une **empreinte de l'état
observé** (ex. `missionId@runtime.updatedAt`) : un scan périmé ne peut pas rejouer une unité déjà résolue.

```
(non vue) --claim--> claimed --resolved--> resolved (terminal, jamais supprimée)
                        |--defer (cooldown, sans compter)--> unclaimed  (ex. workflow encore RUNNING)
                        |--fail (attempt_count+1, backoff)--> unclaimed
                        |--lease expirée (crash)--> unclaimed
unclaimed --attempt_count >= max--> exhausted (terminal ; rapportée UNE fois → escalade humaine)
```

## 3. Règles d'idempotence

1. Toute action de reprise est rejouable : Temporal (`workflowId` déterministe + `REJECT_DUPLICATE` +
   `USE_EXISTING`), `executionResults.record` (unique par `workflowId`), `claimPrepared`/`markDispatched`,
   QC `applyAction` (verrou de ligne), `wake` (lease de runtime).
2. `recovery_units` ajoute la garantie **une seule reprise par unité et par fenêtre de lease** et un
   **budget de tentatives** (pas de boucle infinie sur une unité empoisonnée).
3. Un échec du reviewer ≠ un échec du worker : 7C ne touche jamais l'issue d'un résultat worker ; une
   exécution perdue est enregistrée comme **échec worker** (`UNKNOWN_EFFECT` / `WORKER_UNAVAILABLE`),
   jamais comme succès, puis passée au QC (RETRY borné par le budget QC existant).
4. `wake` renvoyant `AUTONOMY_RUNTIME_ALREADY_OWNED` = un propriétaire vivant existe → `defer`, pas `resolved`.

## 4. Lease / ownership

- **Horloge unique : `now()` PostgreSQL** (comme ADR-0025).
- Claim atomique : `INSERT … ON CONFLICT (kind, unit_key) DO UPDATE … WHERE resolved_at IS NULL AND
(lease_until IS NULL OR lease_until <= now()) AND attempt_count < max` → exactement un gagnant.
- Fencing : `complete`/`defer`/`fail` exigent `owner_token = jeton du claim`.
- Les arbitres de domaine restent la source d'exclusion réelle et ne sont **pas** remplacés :
  lease de runtime (`AutonomousMissionRunner.claim`), `claimPrepared`, claim de job QC, lease `scheduled_jobs`.
  `recovery_units` protège uniquement les nouvelles unités qui n'avaient aucun arbitre propre.

## 5. Détection des orphelins

Scans SQL bornés (`limit`), tous en horloge DB, sans état en mémoire :

- `waiting_settled` : runtime `waiting`, lease libre, `updated_at` plus vieux que `graceMs`, mission non
  terminale, **aucune** tâche en `queued/running/review_pending/awaiting_approval`. (Un runtime `waiting` avec
  travail actif est légitime et n'est jamais réveillé : évite de brûler le budget `maxCycles`.)
- `dispatch_prepared_stale` : `prepared`, claim absent/expiré, `updated_at` plus vieux que `graceMs`, mission non
  terminale, et **aucune lease de runtime vivante** sur la mission (un runner vivant réconcilie lui-même à chaque cycle).
- `dispatch_orphaned` : `dispatched` depuis plus de `orphanAfterMs`, aucun `task_execution_results` pour
  ce `workflowId`, tâche de mission `queued`/`running`. Sonde `WorkflowProbe` (abstraite ; adaptateur Temporal) :
  `running`/`unknown` → `defer` ; `not_found` → re-dispatch même `workflowId` ; clos sans callback → échec
  worker enregistré.

## 6. Frontières de fichiers

Nouveaux : `src/core/contracts/recovery.ts`, `src/server/recovery/*`, `drizzle/0031_recovery_units.sql`,
ce document. Patchs minimaux dans des fichiers partagés (voir §7) :
`src/server/database/schema.ts` (+1 table en fin de fichier), `drizzle/meta/_journal.json` (+1 entrée),
`src/server/repositories/postgres/quality-control-repository.ts` (`listRecoverableMissionIds` inclut les
résultats non enregistrés ; `claimNext` reprend `reviewing` à claim expiré) et son miroir
`src/server/services/in-memory/quality-control-repository.ts` (`claimNext` uniquement), `src/server/system/production-services.ts` (composition du sweeper 7C).

## 7. Risques de conflit avec 7A / 7B

- **Migration** : `0031_recovery_units` + entrée de journal `idx 28`. 7B (mémoire) vise probablement aussi
  `0031` → à l'intégration, renuméroter l'une des deux (fichier SQL, tag, `idx`, `when` strictement
  croissant — `migration-journal.test.ts` le vérifie). La table est indépendante (aucune FK) : l'ordre
  relatif n'a pas d'importance fonctionnelle.
- `schema.ts` : ajout en fin de fichier ; conflit textuel trivial avec une table 7B ajoutée au même endroit.
- `production-services.ts` : 7A y a déjà branché `sweepWithScheduler` ; 7C ajoute un sweeper dans la même chaîne
  (un bloc). Résolution : conserver les deux.
- Aucun changement de `env.ts` / `container.ts` (paramètres par défauts dans le module 7C).

## Sécurité / données

Aucune donnée tenant : missions et runtimes sont à portée système (comme les sweepers existants ; le tenant
n'existe que sur le domaine skills). `recovery_units` ne stocke ni prompt, ni secret, ni contenu de résultat :
uniquement identifiants, compteurs, codes d'erreur stables. **Rollback** : `DROP TABLE recovery_units`
(table de coordination reconstructible : les scans recalculent tout depuis l'état métier ; les unités
`resolved` sont un journal, pas une donnée métier). Aucun agent n'accède directement à la base : les scans
passent par le repository serveur.

## Limites connues

- Une tâche active sans aucun attempt/job/résultat (état incohérent hors flux normal) n'est pas réparée
  automatiquement : signalée par l'absence de progression (stagnation → escalade du runner).
- Purge des unités `resolved` : non implémentée (croissance = 1 ligne par incident de reprise).
- La sonde Temporal réelle n'est vérifiée qu'avec un client simulé (pas de serveur Temporal en CI locale).
