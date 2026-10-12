# Plan de déploiement suivant — première mission autonome sur le VPS (2026-10-12)

État : **D appliqué** (namespace `icos-prod`), tout le reste préparé et non activé. Décisions
propriétaire reçues : exécuteur `codex/gpt-5.5-low`, reviewer `cx/gpt-5.6-sol` (sous réserve),
porte sur `icos-gate-postgres`.

## 0. D — fait (2026-10-12 07:04 UTC), preuves

| Vérification demandée            | Résultat                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Serveur réellement ciblé         | `icos.env` : `TEMPORAL_ADDRESS=127.0.0.1:7233` → `docker-proxy` du conteneur **`icos-test-temporal`** (`7233/tcp -> 127.0.0.1:7233`). Le labo N1 vise `localhost:17233` → conteneur **`p0au-temporal`** : un autre serveur. `icos-web` n'avait aucune connexion ouverte vers :7233 (il ne dispatche rien).                                                                                                                           |
| Pourquoi « icos-test-temporal »  | Créé le 2026-10-07 14:00:01 UTC, 17 s après `icos-test-postgres` (volume **anonyme**), image `temporalio/auto-setup`, sans compose ni unité : c'est l'infrastructure montée pour les suites d'intégration, que `icos.env` a ensuite désignée comme Temporal de production (risque R3 de l'audit souveraineté). Le nom dit son origine, pas son rôle.                                                                                 |
| Namespaces / workflows avant     | `temporal-system`, `default` ; 298 workflows, 220 `Running`, **tous** sur des queues `icos-test*` (suites) ; `icos-tasks` : 0 workflow, 0 poller — aucun workflow de production n'existe.                                                                                                                                                                                                                                            |
| Additif, idempotent, sans impact | `describe` d'abord (absent) → `namespace create icos-prod --retention 720h` → `Registered`, `WorkflowExecutionRetentionTtl 720h`, archivage désactivé, 0 workflow, 0 poller. Après : namespaces `icos-prod temporal-system default`, `default` toujours 298 workflows, 0 poller sur `icos-tasks`, `icos-web`/`icos-omniroute` actifs, `icos.env` md5 `34325566dad2` inchangé. Aucun producteur, poller, workflow ni service modifié. |

Reste à faire pour D (avec B1/B2 env) : `TEMPORAL_NAMESPACE=icos-prod` dans `icos.env`, lu par
`icos-web` **et** le worker (même fichier) ; `container.ts:899-911` passe ce namespace au
dispatcher (« THE SAME NAMESPACE THE WORKER POLLS »).

## 1. Reviewer `cx/gpt-5.6-sol` — vérifié

- Routage réel : `/v1/chat/completions` `stream:false` → `served: gpt-5.6-sol`, 3/3 réponses en
  5,7–7,2 s, verdict structuré (`REQUEST_CHANGES: x is unused…`), 39 tokens in / 24–28 out.
- Disponibilité : worker `cx/gpt-5.6-sol` sain dans la flotte live, sondé `ok` toutes les 30 s.
- Indépendance (décision 0054, `sameEffectiveModel`) : même juge si clés normalisées égales **ou
  même famille** (`GPT_SOL` = tout `gpt-5*-sol*`, `NEMOTRON_550B`, `NEMOTRON_120B`, familles Claude).
  - vs `codex/gpt-5.5-low` (clé `gpt-5.5`, pas de famille) → **indépendant**.
  - vs `codex/gpt-5.6-sol` ou `cx/gpt-5.6-sol` comme writer → **même juge → la porte refuse**.
  - vs nemotron → indépendant.

## 2. Le point qui bloque la paire choisie : `codex/gpt-5.5-low` n'est pas routable

- L'exécuteur ne choisit pas son modèle : `{{model}}` est substitué depuis le **worker routé**
  (grant W10), parmi les workers sains de la flotte.
- `codex/gpt-5.5-low` répond sur `/v1/messages` (PONG, preuve labo) mais **n'est pas dans la liste
  `/v1/models` d'OmniRoute** (432 modèles ; famille 5.5 absente) → la réconciliation ne l'inscrit
  jamais comme worker → il ne sera pas routé. Workers sains routables aujourd'hui : `codex/gpt-5.6-sol`,
  `cx/gpt-5.6-sol`, nemotron super/ultra (nvidia, openrouter).
- Conséquence avec reviewer `cx/gpt-5.6-sol` : un writer routé sur `codex|cx/gpt-5.6-sol` serait
  refusé par la porte (même famille) — fermeture sûre, mais mission bloquée.

Options (décision propriétaire) :

| Option          | Writer                                                                                                                                                                               | Reviewer                                                                    | Pour                                                                                                     | Contre                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A               | pool borné aux nemotron (`ICOS_AUTONOMY_ALLOWED_MODELS=nvidia/nvidia/nemotron-3-super-120b-a12b,nvidia/nvidia/nemotron-3-ultra-550b-a55b`, `ICOS_AUTONOMY_ALLOWED_PROVIDERS=nvidia`) | `cx/gpt-5.6-sol` (choix propriétaire)                                       | indépendant, tout est listé et sain                                                                      | Claude Code via `/v1/messages` sur nemotron **non prouvé** (outils) ; réponse vide à 8 tokens observée                                                  |
| B (recommandée) | `codex/gpt-5.6-sol` (`ICOS_AUTONOMY_ALLOWED_MODELS=codex/gpt-5.6-sol`, `…PROVIDERS=codex`)                                                                                           | `nvidia/nvidia/nemotron-3-ultra-550b-a55b` (déjà planner/cognition, 0,57 s) | writer de la même filière que la preuve labo (`/v1/messages` PONG 1,9 s), reviewer indépendant et rapide | reviewer ≠ choix initial ; qualité de revue nemotron à observer sur le canari                                                                           |
| C               | `codex/gpt-5.5-low` (choix propriétaire)                                                                                                                                             | `cx/gpt-5.6-sol`                                                            | la paire voulue, indépendante                                                                            | exige qu'OmniRoute **liste** `gpt-5.5-low` (lane OmniRoute) ou une inscription manuelle de worker que la retraite gouvernée (ADR 0064) pourrait écarter |

Dans tous les cas la porte refuse un auto-jugement : une mauvaise paire ne passe jamais en
silence (`auto-revue : même modèle en écriture et en revue`).

## 3. Plafonds de dépense (env, tous bornés avant tout appel)

| Plafond                                | Valeur                                               | Où                                                                                     |
| -------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Tokens par objectif                    | 450 000                                              | `ICOS_GOAL_MAX_TOTAL_TOKENS` (DENY 402 avant l'appel, W10)                             |
| Tokens par proposition self-dev        | 50 000                                               | `ICOS_SELF_DEVELOPMENT_PROPOSAL_MAX_TOTAL_TOKENS`                                      |
| Propositions par jour                  | 1                                                    | `ICOS_SELF_DEVELOPMENT_MAX_PROPOSALS_PER_DAY`                                          |
| USD par run Claude Code (garde du CLI) | 1,50                                                 | `--max-budget-usd` (le run3 du labo s'est arrêté dessus : réglage à confirmer par W10) |
| Durée d'un run                         | 840 s (activité 900 s)                               | `--timeout-ms`, `ICOS_WORKER_EXECUTION_TIMEOUT_MS`                                     |
| Revue                                  | 120 s                                                | `ICOS_REVIEWER_TIMEOUT_MS`                                                             |
| Retries QC                             | bornés (W8, `QC retry exhaustion` prouvé)            | code                                                                                   |
| Devise                                 | **non opposable** (registre de prix vide → UNPRICED) | décision propriétaire                                                                  |

## 4. Isolation

- Namespace `icos-prod` (fait) ; labo sur un autre serveur (`p0au-temporal`), mon namespace d'essai
  `icos-fable-lab` n'y touche pas.
- Porte : conteneur dédié `icos-gate-postgres` (:5434, volume nommé), nom de base contenant `test`
  (garde), jamais la base live (5433) ni le Postgres de Temporal (5432).
- Worker : bubblewrap, réseau coupé, seule sortie = proxy compté ; `/srv/icos/workers` pour les
  worktrees ; cible d'intégration `integration/autonomy-now-001`, jamais `main`, jamais de push.
- Services : `icos-temporal-worker` sous systemd avec cgroups ; `icos-web` inchangé.

## 5. Séquence restante (une autorisation par étape, retour arrière indiqué)

| #   | Étape                                                                                                                                                | Preuve attendue                                                                                                                                                                 | Retour arrière                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | **Choix A/B/C** (§2)                                                                                                                                 | —                                                                                                                                                                               | —                                          |
| 2   | B2-gate : `docker run … icos-gate-postgres`                                                                                                          | `icos-autonomy-check.sh` PASS « ICOS_TEST_DATABASE_URL (gate) »                                                                                                                 | `docker rm -f` + volume                    |
| 3   | B1/B2/D env : `.bak`, fusion des exemples + allowlist du §2, retrait de `ICOS_REVIEWER_COMMAND`, `TEMPORAL_NAMESPACE=icos-prod` ; restart `icos-web` | check : seuls « pollers » et « unité » en FAIL ; `health-check.sh 3100 5719213` PASS ; `TTS health: fish=READY`                                                                 | restaurer `.bak`, restart                  |
| 4   | B3 : unité worker, `enable --now`                                                                                                                    | `AUTONOMY_READY=PASS` ; 2 pollers sur `icos-tasks`@`icos-prod` ; `kill -9` → relance ≤ 15 s ; `icos-sovereignty-check.sh` → `ICOS_WORKERS_VPS=PASS`, `MAC_DEPENDENCY_ZERO=PASS` | `disable --now`, retirer l'unité           |
| 5   | B4 : `icos-backup.timer`                                                                                                                             | premier dump planifié + SHA256SUMS                                                                                                                                              | `disable --now`                            |
| 6   | C : « Require API key » (dashboard) puis `omniroute-remote-access.sh --apply`                                                                        | `/v1` sans clé → 401 ; ICOS inchangé                                                                                                                                            | `--rollback`                               |
| 7   | Prérequis de confiance : W6/W8 rejouent la preuve « reprise sans double exécution » (handoff du 2026-10-12) et le labo atteint `mission.succeeded`   | suite verte + mission labo `succeeded`                                                                                                                                          | —                                          |
| 8   | E : `ICOS_SELF_DEVELOPMENT=enabled`, restart `icos-web` → canari `AUTONOMY-NOW-001` au prochain passage du scheduler                                 | critères du contrat ; `pnpm autonomy:assess --direct` passe L0 → ≥ L2 **par des lignes réelles** ; `pnpm mission:trace <id>`                                                    | `disabled`, suppression branche + worktree |

Retour arrière global : `.bak` sur `icos.env`, `disable --now icos-temporal-worker icos-backup.timer`,
restart `icos-web`, `health-check.sh`. Le namespace et le conteneur de porte peuvent rester (inertes).
