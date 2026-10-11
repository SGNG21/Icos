# Diagnostic du cockpit live — 2026-10-11 (FABLE 5.1)

Méthode : lecture seule. Base live `icos_app` via `docker exec … psql` (requêtes agrégées, aucun
identifiant extrait), `journalctl -u icos-web/icos-omniroute` (24 h, filtré des secrets), code
déployé `/srv/icos/worktrees/vps-deploy` @049a7d9, trois appels de sonde à OmniRoute en loopback
(`stream:false`, `max_tokens:5`). Aucun service, aucune configuration, aucune ligne modifiés.

## 1. Le cockpit dit-il vrai ? Oui — il mesure un runtime @049a7d9 sans aucune capacité d'exécution

| Ligne cockpit | Source dans le code déployé | Mesure réelle | Verdict |
| --- | --- | --- | --- |
| PostgreSQL = LIVE | `icos-app-postgres` 127.0.0.1:5433 | sain, 0 mission, 0 tâche, 0 dispatch | exact |
| Workers routables 6/8 | `workers.health='healthy' and availability='available'` | 6 healthy / 2 unhealthy (`oc/*`), sondés 18:40:31 | exact |
| Aucun cerveau durable | `workforce_agents.kind='DURABLE_AGENT'` | table `workforce_agents` : **0 ligne** | exact |
| Tools governed = NOT_CONNECTED | `toolsUsable \|\| governedExecutors` ; connecteurs = `tool_connector_health` ∩ `ICOS_TOOL_GATEWAY_CONFIG` | `tool_grants` 0, `tool_executions` 0, `tool_connector_health` 0 lignes, `ICOS_TOOL_GATEWAY_CONFIG` absent | exact |
| Connecteurs = 0, External realtime = NOT_CONNECTED | `countRealtimeConnectors(db, env)` | aucun connecteur web/recherche déclaré | exact |
| Exécuteurs = 0 | `executableRuntimes(parseWorkerExecCommands(env.ICOS_WORKER_EXEC_COMMANDS)).length` | **`ICOS_WORKER_EXEC_COMMANDS` absent de `/srv/icos/etc/icos.env`** | exact |
| Deux probes oc/Nemotron échouées | sonde `probe_workers` ~30 s | `oc/nemotron-3-ultra-free` → HTTP 403 « OpenCode's free tier can only be used from within OpenCode » ; `oc/oc/nemotron-3-super-free` → HTTP 401 « Model … is not supported » ; contrôle `nvidia/nvidia/nemotron-3-super-120b-a12b` → HTTP 200 en 0,57 s | exact : **fournisseur retiré**, pas une panne ICOS |
| 26 accès refusés / 24 h | `audit_entries` | 23 `auth.access.denied` (21 `ws.voice`, 2 `api.voice.status`, raison `missing_session`) + 11 `auth.login.rejected` (`invalid_credentials`), 12 `auth.login.succeeded`, du 10/10 18:52 au 11/10 18:02 | voir §4 |
| Safe mode OFF / New dispatch ON / Integration ON / External actions ON | `autonomous_mission_runtime` | les interrupteurs sont ouverts, mais rien ne peut passer : 0 exécuteur, 0 poller Temporal | **cohérent mais trompeur** : « ON » sans capacité derrière |
| Global = DEGRADED | agrégat self-model | découle des lignes ci-dessus | exact |

## 2. Pourquoi 0 exécuteur en prod alors que Claude Code tourne au labo

L'exécuteur n'est jamais inféré : il est **déclaré** par `ICOS_WORKER_EXEC_COMMANDS` (« an executor
ICOS cannot name is one it must not claim », `src/server/cognitive/index.ts`). En prod, la variable
est absente ; au labo elle pointe sur `bin/icos-claude-worker.mjs` (W10). De plus :

1. le fichier `bin/icos-claude-worker.mjs` **n'existe pas** dans l'arbre déployé @049a7d9 (il arrive avec W10 = `02b6706`, dans le hub `d3edd8a`) ;
2. aucun worker Temporal ne tourne en prod : `temporal task-queue describe icos-tasks` → **0 poller** ; le scheduler/superviseur dans `icos-web` ne peut donc rien dispatcher ;
3. `ICOS_REPO_PATH` / `ICOS_WORKER_WORKSPACE_ROOT` absents → repli sur `/Users/coco` (audit M1–M2).

Autrement dit : le runtime live est un cockpit + voix + cognition **sans bras**. Le labo a les bras
(W10), mais sur un autre arbre, une autre base (`icos_lab_run4`), un autre Temporal (`p0au-temporal`).

## 3. Liaison workers ↔ cerveaux ↔ CORE3 ↔ Temporal (live)

| Lien | État live | Preuve |
| --- | --- | --- |
| icos-web → PostgreSQL | OK | `PostgreSQL=LIVE`, requêtes OK |
| icos-web → OmniRoute (cognition, voix, sondes) | OK mais fragile | sondes ok sur 6 modèles ; `COMPUTE_BOOTSTRAP PROVIDER_UNAVAILABLE` ×2 (timeout) dans le journal 24 h ; `/v1/models` a dépassé 10 s à 20:19 sous charge 13.9 |
| Flotte compute (8 `workers`) → routage | 6 routables | `health/availability` ; les 2 `oc/*` sont retirés côté fournisseur et restent en table : le code live ne connaît pas la retraite gouvernée (W1, ADR 0064 amendée, hub) |
| Cerveaux logiques (DURABLE_AGENT) | **non reliés : 0** | `workforce_agents` vide ; la composition au boot (W3 `da85417`, W4 `8368db4`) n'est pas déployée |
| CORE3 (missions/tâches/QC) → Temporal | **câblé, jamais exercé** | `TEMPORAL_ADDRESS/NAMESPACE/TASK_QUEUE` définis en prod ; 0 mission, 0 dispatch, 0 poller |
| Temporal → worker d'exécution | **absent** | aucune unité `icos-temporal-worker` (kit 449fda6 préparé, non installé) |
| Temporal prod | partagé avec les tests | `icos-test-temporal`, namespace `default` uniquement (R3) |

## 4. Les 26 refus d'accès : harnais de test vocal, pas une intrusion

- 21 `ws.voice` + 2 `api.voice.status` refusés pour `missing_session` : connexions WebSocket/API
  vocales sans cookie de session. Fenêtre 10/10 18:52 → 11/10 18:02, concordante avec les
  exécutions du harnais `scripts/voice-e2e.ts` (lane `fix/voice-e2e-auth`, commits « resume before
  the TTL », « the harness reads the password from the terminal ») et les tests de reprise après
  expiration de session (`continuityWithoutSession`).
- 11 `auth.login.rejected` (`invalid_credentials`) vs 12 `auth.login.succeeded` : même fenêtre ; les
  commits `5c35da7` « a pasted password is not the password that was pasted » et `3580ed2` « raw mode
  OR readline » décrivent exactement un mot de passe altéré par le terminal avant Better Auth.
- Les refus viennent de `actor_type=system` sur loopback/Tailscale ; aucun motif d'accès externe
  (SSH :22 et tailnet seuls exposés ; OmniRoute loopback). Aucun identifiant ni jeton n'a été lu.
- Action : aucune sur la prod. Le compteur est sain (il refuse ce qui doit l'être). À surveiller si
  des refus apparaissent hors des fenêtres de test vocal.

## 5. Les deux échecs Nemotron (`oc/*`)

Fournisseur OpenCode : le palier gratuit n'est plus servi hors de l'application OpenCode (403) et
l'un des deux identifiants n'est plus supporté (401). Ce sont des **retraits fournisseur** ; les
quatre autres routes Nemotron (nvidia direct, openrouter `:free`) répondent 200. Le code live n'a
pas de chemin de retraite : les deux lignes resteront `unhealthy` et continueront d'être sondées
(~30 s, coût R6). Le hub contient la réponse canonique : classe d'échec persistée (`0062`), retraite
gouvernée auditée des workers retirés par le fournisseur (W1 `246b816`, `062954a`). Rien à corriger
à la main : c'est le déploiement du hub qui règle la ligne, par la voie gouvernée.

## 6. Corrections priorisées pour AUTONOMY_NOW (ordre d'effet)

1. **Déployer la convergence** (hub `d3edd8a` + `449fda6` + voix) sur un répertoire de release : fait apparaître W1–W11, `bin/icos-claude-worker.mjs`, la retraite gouvernée, la composition des cerveaux et le self-model READY/PARTIAL/AUTONOMOUS_BY_POLICY (W3 `94826fc`). Sans ce déploiement, aucune ligne du cockpit ne peut changer honnêtement. — autorisation F1.
2. **Déclarer l'exécuteur et les chemins** (`icos.env.sovereignty.example` + `icos.env.autonomy.example`) → `Exécuteurs = 1`, `Tools governed = GOVERNED (exécuteurs gouvernés disponibles)`, `MAC_DEPENDENCY_ZERO = PASS`. — B1/B2.
3. **Installer le worker Temporal** (`icos-temporal-worker.service`) + namespace `icos-prod` → 2 pollers sur `icos-tasks`, `ICOS_WORKERS_VPS = PASS`. — B3/D.
4. **Reviewer réel** (`ICOS_REVIEWER_MODEL`, retirer `printf`) — B2.
5. **Lane W10** : résoudre `error_max_budget_usd` (verdict run3) avant toute mission prod — hors de mon périmètre, prérequis de E.
6. **OmniRoute** : « Require API key » (C) ; stabilité sous charge (lane OmniRoute) ; registre de prix vide → budgets en tokens seulement (décision propriétaire).
7. Connecteurs realtime / `ICOS_TOOL_GATEWAY_CONFIG` : **hors MVP** — la première mission n'a besoin d'aucun connecteur web.

## 7. Matrice LIVE / LAB / CODE_READY / MISSING

| Capacité | LIVE (@049a7d9) | LAB (hub d3edd8a, `icos_lab_run4`) | CODE_READY (commit) | MISSING |
| --- | --- | --- | --- | --- |
| Cockpit, voix, cognition, sondes flotte | OUI (`icos-web` systemd, 0 restart) | OUI (:3210 détaché) | — | — |
| Exécuteur Claude Code via OmniRoute (bwrap, proxy compté) | NON (var absente, fichier absent) | OUI, preuve `hello.txt` + ledger 9 937 tokens | W10 `02b6706` | déclaration prod (B2) |
| Worker Temporal (`icos-tasks`) | NON (0 poller) | OUI (`icos-n1-lab`, 2 pollers) | unité 449fda6 (kill -9 → relance 10 s) | installation (B3) |
| Détection → objectif → mission → tâches → dispatch | NON (0 ligne) | OUI (run3 : goal 18:27:45 → dispatch → QC → `mission.failed` 18:28:37, 11 audits) | W11 `aece80b`, W2, W9 | artefact réussi (lane W10) |
| Retraite gouvernée des workers retirés (oc/*) | NON (2 unhealthy permanents) | OUI (code) | W1 `246b816`, `062954a`, 0062 | déploiement |
| Cerveaux durables / composition au boot | NON (0) | OUI (CLIENT_DIRECTORY_SEEDED, boot seed) | W3 `da85417`, W4 `8368db4` | déploiement |
| Self-model READY/PARTIAL/AUTONOMOUS_BY_POLICY | NON (ancien self-model) | OUI | W3 `94826fc`, `5d4c19c` | déploiement |
| Gate sandbox + PG jetable + rapport durable | NON | OUI (config `ICOS_GATE_COMMANDS`) | W7 `eabdbfd`, 0063 | PG jetable prod (B2) |
| Reviewer indépendant | NON (`printf`) | configuré (`ICOS_REVIEWER_MODEL`), pas encore exercé | W6 `f15f255` | B2 + run4 |
| Chemins sans Mac | NON (repli `/Users/coco`) | OUI | env example 449fda6 | B1 |
| Sauvegardes | NON | prouvé (restauration 1000/1000, labo) | 449fda6 | B4 + copie hors-hôte |
| Temporal isolé des tests | NON (`default` partagé) | OUI (`icos-fable-lab` créé sur le labo) | commande validée | D (`icos-prod`) |
| OmniRoute `/v1` authentifié | NON (200 sans clé) | NON | — | C (propriétaire) |
| Prix des modèles (budget en devise) | NON (registre vide) | NON (48/48 UNPRICED) | `src/core/pricing/registry.ts` | décision propriétaire |
| Connecteurs realtime | NON | NON | tool-gateway W3 | hors MVP |
| Cycle complet avec artefact + revue + intégration | NON | **PAS ENCORE** (run4 en cours) | W6 harness `f15f255` | verdict run4 |
