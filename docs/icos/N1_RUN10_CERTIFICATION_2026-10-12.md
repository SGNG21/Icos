# N1 — run 10 : la chaîne complète jusqu'à l'IntegrationGate, verdict N1_CERTIFIED (2026-10-12)

Un seul run, en laboratoire isolé (jamais la production), après préflight PASS. Writer **Claude
Code CLI 2.1.292 sur `cc/claude-sonnet-5`**, reviewer **`codex/gpt-5.6-sol`** (famille ≠ writer,
décision 0054), planner **`codex/gpt-5.5-low`**. Mission canari : la déclaration inutilisée
`signature` (`src/core/autonomy/learning-harvester.ts:204`, ESLint `no-unused-vars`), périmètre
`src/core/autonomy/*`. Rien n'a touché `icos.env`, `icos-web`, OmniRoute, Temporal prod, ni le labo
N1 de W6/W8 (namespace `default` du serveur labo : 64 workflows en cours, non touchés).

## Verdict

**N1_CERTIFIED : FAIL.** `mission.succeeded` n'a pas été atteint. La chaîne est allée plus loin que
tous les runs précédents — **détection → goal → mission → plan → dispatch → worker → exécution
(3 tentatives) → revue indépendante (RETRY, RETRY, APPROVE) → IntegrationGate (typecheck PASS,
lint PASS, secrets PASS, périmètre PASS, tests unitaires FAIL) → REJECT → settlement →
`mission.failed`** — et s'est arrêtée sur une cause unique, identifiée et reproduite (§5). Deux
interventions de l'opérateur ont eu lieu pendant le run (§4) ; elles sont taguées et expliquées, et
à elles seules elles interdisent de qualifier ce run d'« autonome sans intervention ».

## 1. Préflight (tous PASS avant le lancement, 13:33–13:36 UTC)

| Prérequis            | Preuve                                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W10 corrigé + tests  | `b3e0ffb`, `07ceb0d` ; `worktree-dependencies.test.ts` 9/9 ; suites `execution/temporal` + `workspace-manager` 342/342 ; install hors ligne confiné mesuré : 649 paquets en 61 s, réseau coupé, store `ro` ; eslint 10,8 s / vitest 25 tests 4,4 s dans le sandbox             |
| W7 corrigé + tests   | `b3e0ffb` : bloc « Execution environment » dérivé de `--allow-bash` ; handoffs `docs/icos/handoffs/w10-…`, `w7-…`                                                                                                                                                              |
| Routage OmniRoute    | appels bornés (8 tokens) : `cc/claude-sonnet-5` → servi `claude-sonnet-5` 2,0 s ; `codex/gpt-5.6-sol` → `gpt-5.6-sol` 4,1 s ; `codex/gpt-5.5-low` → `gpt-5.5` 2,2 s ; HTTP 200                                                                                                 |
| Reviewer indépendant | `sameEffectiveModel("codex/gpt-5.6-sol","cc/claude-sonnet-5") = false` ; planner vs reviewer `= false`                                                                                                                                                                         |
| PG / Temporal isolés | base **neuve** `icos_fable_lab_run10` (73 tables migrées ; la base run 9 conservée intacte) ; namespace `icos-fable-lab` : 0 workflow en cours ; `icos-prod` (serveur prod, lecture seule) : 0                                                                                 |
| Ressources VPS       | 13,1 Go libres / 24 Go, charge 4,2, disque 256 Go libres ; build Next `.next` 170 s OK                                                                                                                                                                                         |
| Plafonds             | `ICOS_GOAL_MAX_TOTAL_TOKENS=3 000 000` (run 9 : 4 M sans justification → ramené à l'enveloppe mesurée « 1 exécution + 1 correction » du run 9 : 1,25 M + 1,58 M) ; cycles 6, replans 1, stagnation 2, durée 60 min, writer 14 min/900 s, `--max-budget-usd 5`, QC 3 tentatives |

## 2. Chaîne mesurée (UTC, base `icos_fable_lab_run10`, tous les identifiants corrélés)

| Heure       | Étape                                                                                                                                                                                          | Identifiant                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 13:36:25    | labo démarré (app :3330 + worker queue `icos-fable-lab`)                                                                                                                                       | `run10.started`                                                                                                                                        |
| 13:37:35    | **détection → `goal.created`, `goal.converted`** (planner `gpt-5.5-low`, 1 appel, 1 068 tokens)                                                                                                | `sd-goal-ab7f1b7a377a2605` → `sd-mission-ab7f1b7a377a2605`                                                                                             |
| 13:37:39    | `task.created`                                                                                                                                                                                 | `task-15c36f73-3338-4630-b13e-97d0eadd5313`                                                                                                            |
| 13:37:40    | worktree alloué (**`node_modules` installé hors ligne avant le lancement**, 933 Mo à 13:38:00)                                                                                                 | `remove_unused_signature_07d0e996` / `ws/remove_unused_signature_07d0e996`                                                                             |
| 13:37:42    | **dispatch 1** → worker `abf9737b…` (`cc/claude-sonnet-5`) → `task.transitioned running`                                                                                                       | `icos-task-task-15c36f73-…` (Temporal `icos-fable-lab`)                                                                                                |
| 13:39:58    | **exécution 1 réussie** (15 appels, 355 912 tokens, 2 min 16 s)                                                                                                                                | `texec-ddb77dd9…`                                                                                                                                      |
| 13:40:13    | **revue indépendante 1 : RETRY** (`codex/gpt-5.6-sol`, 2 467 tokens) → QC `RETRY` → attempt 2                                                                                                  | `review-1791812412851-q3g2ofrhl`                                                                                                                       |
| 13:40:21    | dispatch 2, nouveau worktree `…_a2`                                                                                                                                                            | `…-attempt-2`                                                                                                                                          |
| 13:42:17    | exécution 2 réussie (9 appels, 209 258 tokens, 1 min 57 s)                                                                                                                                     | `texec-aeb9c99b…`                                                                                                                                      |
| 13:42:31    | revue 2 : RETRY → QC `RETRY` → attempt 3 (dernière avant escalade)                                                                                                                             | `review-1791812550592-kgyh2s62w`                                                                                                                       |
| 13:42:36    | dispatch 3, worktree `…_a3`                                                                                                                                                                    | `…-attempt-3`, run `01a13059…`                                                                                                                         |
| 13:43:24    | **intervention 1** : worker labo tué (`kill -9`) après correctif, relancé 13:43:26 (§4)                                                                                                        | `run10.worker-restart`                                                                                                                                 |
| 13:45:50    | **intervention 2** : reset Temporal du workflow attempt-3 à l'événement 10 (§4)                                                                                                                | nouveau run `66400584-97a1-4a42-acb0-a3208f26c514`                                                                                                     |
| 13:51:17    | **exécution 3 réussie** (32 appels, 984 058 tokens, 5 min 16 s) ; commit `32e06e9` sur `ws/…_a3`                                                                                               | `texec-993ef77d…`                                                                                                                                      |
| 13:51:33    | **revue 3 : APPROVE** (`codex/gpt-5.6-sol`) → QC `ACCEPT` → workspace `integrating`                                                                                                            | `review-1791813093492-71bir82dd`                                                                                                                       |
| 13:52–14:06 | **IntegrationGate** (sandbox, réseau coupé) : install SKIP (présent), typecheck PASS, lint PASS, secrets PASS, périmètre PASS, `pnpm test` **FAIL** (4 tests), build SKIPPED, postgres SKIPPED | `workspace.gate.reported` 14:06:27, `workspaceId 7f8eb649…`, base `96daa94`, commit `32e06e9`, DB de test `icos_test_remove_unused_signat_07d0e996_a3` |
| 14:06:34    | **settlement** : `task.transitioned failed` (`INTEGRATION_SETTLED`, qcAction `ACCEPT`, integration `REJECTED`) → **`mission.transitioned failed`** (`TASK_FAILED`)                             | terminal ; `integration/fable-n1` resté à `96daa94` (rien d'intégré)                                                                                   |
| 14:07:31    | labo arrêté (aucun run 11)                                                                                                                                                                     | `run10.ended`                                                                                                                                          |

**Idempotence / pas de double exécution** : 3 dispatch attempts, 3 résultats d'exécution (1 par
workflow id), 3 décisions de revue (1 par attempt), 3 workspaces (1 par attempt, les deux premiers
`abandoned`, le troisième `rejected`) ; après le `kill -9`, le dernier appel de l'exécuteur orphelin
est à 13:43:20 (aucun appel entre 13:43:20 et le relancement 13:46:01) : l'exécution 3 a produit
**un seul** résultat, celui du run reset.

## 3. Tokens, cache, coût (séparés, rien d'inventé)

| Poste                                | Appels | Tokens ledger (prompt + sortie, **cache inclus**) | Sortie |
| ------------------------------------ | ------ | ------------------------------------------------- | ------ |
| writer attempt 1 (`claude-sonnet-5`) | 15     | 355 912 (contexte max 28,7 k)                     | 4 455  |
| writer attempt 2                     | 9      | 209 258 (26,7 k)                                  | 3 350  |
| writer attempt 3, run orphelin tué   | 7      | 157 723 (27,2 k)                                  | 1 596  |
| writer attempt 3, re-run             | 32     | 984 058 (44,9 k)                                  | 15 264 |
| reviewer `gpt-5.6-sol`               | 3      | 7 060                                             | 960    |
| planner `gpt-5.5-low`                | 1      | 1 068                                             | 310    |
| **Total attribué au goal**           | **67** | **1 715 079 / 3 000 000**                         |        |

- **Mesuré vs cache** : le ledger additionne `input + cache_creation + cache_read` (règle W10,
  « le cache est facturé en entrée »). La ventilation par appel (`SPEND_USAGE_SPLIT`, commit
  `892118b`) est bien émise par le proxy compté — `logs/app.log` en contient 319 lignes — mais
  **toutes pour les sondes de flotte non attribuées** (54 par modèle, `cacheRead: null` : les sondes
  ne passent pas par le format Anthropic avec cache). Aucune ligne pour les 67 appels attribués au
  goal : les appels du writer passent par le proxy d'egress **dans le worker Temporal**, dont la
  sortie console des activités n'atteint pas `logs/worker.log` (164 lignes, SDK seulement), et les
  appels planner/reviewer de l'app n'en ont pas produit non plus. Le résultat de l'exécuteur
  persisté est le texte du rapport, pas le JSON du CLI (`usage.cache_read_input_tokens`).
  **Conclusion honnête : la part cache du run 10 n'est pas mesurée** ; le total l'est. Résiduel :
  persister la ventilation (colonnes `cache_read`/`cache_creation` du ledger) plutôt que la journaliser.
- **Coût** : `ICOS_PRICE_REGISTRY` vide → `UNPRICED` (« modèle absent de la table de prix ») sur
  les 67 lignes. Aucun prix n'est inventé. 69 réservations enregistrées (6 041 308 tokens
  réservés, libérées à la mesure).
- **Réduction vs run 9** (même canari, même writer) : exécution 1 **355 k vs 1 255 k tokens
  (−72 %)**, 15 appels vs 34 ; contexte initial 18,7 k → 28,7 k au 15ᵉ appel (run 9 : 49 k au 34ᵉ).
  Les dépendances présentes et la consigne exacte ont supprimé l'exploration et les devinettes.
  Le re-run de l'attempt 3 (32 appels, 984 k) a été plus long : le writer a lu la configuration
  ESLint effective jusque dans `node_modules` pour prouver que `_signature` n'aurait pas suffi.

## 4. Interventions (BR-07, taguées à la source)

1. **13:43:24 — `kill -9` du worker labo puis relancement (13:43:26).** Cause : l'attempt 1 a révélé
   un troisième défaut W10 (§5a) ; correctif `090f80d` appliqué dans la minute ; `lab.sh stop-worker`
   (SIGTERM) a laissé le worker **drainer** l'activité en cours, l'attempt 3 (lancé 13:42:36) tournait
   donc encore sur l'ancien code ; `kill -9` a tué worker + exécuteur (`--die-with-parent`).
2. **13:45:50 — reset Temporal** du workflow `…-attempt-3` (`workflowTaskFinishEventId=10`, juste
   après le callback `started`, avant l'activité `runGovernedWorker`). Cause : activité sans
   heartbeat, `startToCloseTimeout` 16 min, `maximumAttempts: 1` → Temporal n'aurait vu la mort du
   worker qu'à 13:58:35, puis `reportFailure` → QC 3ᵉ action → escalade. Le reset a relancé la même
   tentative, une fois, sur le worker corrigé. Le run d'origine (`01a13059…`) a été terminé par le
   reset ; aucun exécuteur vivant ne lui restait (dernier appel 13:43:20).

Ces deux gestes sont exactement ce qu'ICOS doit savoir faire seul (W6 « RESTART MID-MISSION ») :
**la reprise automatique n'est pas prouvée par ce run** (le reset est manuel). Résiduel : heartbeat
sur `runGovernedWorker` (ou `heartbeatTimeout`) pour que la mort d'un worker soit vue en secondes,
et une action de reprise « relancer la même tentative » dans le sweeper (aujourd'hui : `not_found` →
redispatch, `closed` → exécution perdue enregistrée, `running` → attente).

## 5. Blocages exacts (reproduits)

### 5a. Writer : `pnpm` du writer sans les réglages de l'installation (attempts 1–3)

Les dépendances étaient présentes, le writer a exécuté **exactement** les deux formes permises, et
pnpm a échoué **avant** eslint/vitest :
`[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY] Aborted removal of modules directory due to no TTY …
Command failed with exit code 1: pnpm install` (rapport du writer, attempts 1 et 3). Cause : le
shell du writer ne voyait pas `pnpm_config_verify_deps_before_run=false`, `store_dir`,
`trust_lockfile`, `frozen_store` ; pnpm 11 juge alors `node_modules` « installé avec d'autres
réglages », tente une réinstallation interactive, abandonne sans TTY. Deux correctifs :
`090f80d` (l'activité construit ces variables pour le writer) et `e83b8f0` (l'adaptateur
`bin/icos-claude-worker.mjs` ne transmettait au CLI que `PATH/HOME/TMPDIR/LANG` : il transmet
désormais `pnpm_config_*`/`npm_config_*` **et rien d'autre**, test `PACKAGE_MANAGER_SETTINGS_PASS`).
Le second correctif est arrivé **après** l'attempt 3 (l'adaptateur est relu à chaque lancement ;
aucun lancement n'a suivi). Preuve de l'issue attendue : dans le même sandbox, avec ces variables,
`pnpm exec eslint src/core/autonomy/learning-harvester.ts` → 1 warning attendu (avant correction),
`pnpm vitest run src/core/autonomy/learning-harvester.test.ts` → 25/25.

Le reviewer a néanmoins **approuvé** l'attempt 3 sur preuve statique (lecture de la config ESLint
effective, `void signature;` indépendant de `argsIgnorePattern`) — jugement défendable, mais une
revue qui approuve sans lint exécuté est un résiduel de politique (voir §7).

### 5b. IntegrationGate : `pnpm test` FAIL (4 tests) dans le sandbox

Rapport de porte : `unitTests: FAIL`, extrait `createContainer src/server/container.ts:1203` depuis
`src/server/usecases/e2e-failure.test.ts:66` (`[4/4]`). Le changement intégré est de 3 lignes dans
`learning-harvester.ts` (commentaire + `void signature;`) : il ne peut pas casser `createContainer`.
Reproduction sur le commit rejeté `32e06e9` (worktree de sonde, même sandbox, mêmes variables) :
`e2e-failure.test.ts` seul → **PASS en 8,9 s** (limite vitest 10 s). La suite complète dans le
sandbox (326 fichiers, ≈ 11 min, mesurée 671 s sur la base) est en cours de re-exécution pour nommer
les 4 tests ; hypothèse à confirmer : **timeouts sous charge** dans le sandbox (tests d'intégration
en mémoire proches de 10 s), non liés au changement — **confirmé en §8 : 0 échec sur 4 476 tests
en reproduction**.

## 6. Ce que le run 10 certifie (preuves durables)

- **AUTONOMY_N1 / HEADLESS_EXECUTION** : détection → mission → plan → dispatch → worker Claude Code
  confiné (bwrap, réseau coupé, proxy compté) → 3 exécutions réussies → revue → gate → settlement,
  sans TTY, sur le VPS seul ; un commit gouverné (`32e06e9`) sur la branche de workspace.
- **INDEPENDENT_REVIEW** : 3 verdicts structurés d'un modèle hors famille (`RETRY`, `RETRY`,
  `APPROVE`, motifs durables), QC borné (3ᵉ tentative = dernière).
- **W10** : installation hors ligne confinée avant le lancement, prouvée (933 Mo, 61 s) ; le
  dernier défaut (variables non transmises par l'adaptateur) est corrigé et testé, **pas encore
  prouvé en run**.
- **W7** : la consigne a porté : le writer a exécuté exactement les formes permises, aucune
  devinette (`npx`), zéro refus d'outil inutile ; les refus de sécurité sont intacts (un 3ᵉ essai
  `pnpm exec eslint --version` a été refusé comme hors motif).
- **BUDGET_ENFORCEMENT** : 1,715 M / 3 M ; réservation avant chaque appel ; `UNPRICED` déclaré,
  rien masqué. **NO_DOUBLE_DISPATCH** : 1 résultat par attempt, y compris après kill + reset.
- **IntegrationGate réel** : typecheck / lint / secrets / périmètre PASS sur le vrai commit, DB de
  test dédiée créée, décision `REJECT` tracée et settlement correct (`INTEGRATION_SETTLED`).
- **Non certifié** : `mission.succeeded` ; **RECOVERY** automatique (2 interventions manuelles) ;
  **cache mesuré** ; **VPS_UNATTENDED** (labo lancé à la main, pas de systemd).

## 7. Résiduels avant un run 11 (à autoriser, pas automatique)

1. Porte : nommer les 4 tests (§8) ; si timeouts sous charge → `ICOS_GATE_COMMANDS.unit` avec un
   timeout vitest plus large ou `--pool` ajusté dans le sandbox — **jamais** exclure des tests.
2. Heartbeat / reprise automatique de `runGovernedWorker` (§4).
3. Journal du proxy compté dans le worker (lignes `SPEND_USAGE_SPLIT` absentes) ; persister le JSON
   du CLI (`usage`, `num_turns`) dans le résultat.
4. Politique de revue : un `APPROVE` sans lint/test exécutés devrait être `REQUEST_CHANGES` quand
   l'environnement les permet (ici le writer disait qu'il ne le permettait pas — vrai, §5a).
5. Plafond : 3 M suffisait (1,715 M) ; avec 5a corrigé, viser 2 M.

## 8. Reproduction de la suite complète dans le sandbox (commit `32e06e9`)

Worktree de sonde créé sur le commit rejeté, dépendances installées hors ligne dans le sandbox
(`Done in 16.1s`, store `ro`), puis `pnpm test` dans le **même** sandbox (bwrap `--unshare-all`,
HOME éphémère court, `CI=1`, mêmes `pnpm_config_*`), 14:09–14:20 UTC :

```
Test Files  325 passed | 1 skipped (326)
     Tests  4476 passed | 42 skipped (4518)
UNIT_EXIT=0 seconds=626
```

**Zéro échec.** Les 4 échecs de la porte (14:06) ne sont pas reproductibles sur le même commit dans
les mêmes conditions : ils sont **non déterministes** — timeouts sous charge (`e2e-failure.test.ts`
seul : 8,9 s pour une limite vitest de 10 s ; charge VPS 4–7 pendant la porte, 64 workflows du labo
W6/W8 en cours sur le même hôte). Le changement intégré (3 lignes dans `learning-harvester.ts`)
n'est pas en cause. Conséquence : le REJECT de la porte est un **faux négatif de l'environnement**,
pas un défaut du travail du writer — mais une porte qui dit REJECT a raison de ne pas intégrer, et
ICOS a réglé la mission correctement (`INTEGRATION_SETTLED` → `failed`). Correctif à proposer
(lane W7/W8, jamais « exclure des tests ») : timeout vitest de la porte à 30 s et/ou `--pool=forks
--poolOptions.forks.maxForks=2` dans `ICOS_GATE_COMMANDS.unit`, et une **relance unique** de l'étape
`unit` sur échec non déterministe (même commit, même sandbox) avant REJECT.

## 9. Verdict final, fondé sur ces preuves

**N1_CERTIFIED : FAIL** — `mission.succeeded` non atteint (gate REJECT sur 4 tests non
reproductibles) ; deux interventions manuelles pendant le run. Ce que le run 10 prouve pour la
première fois : la chaîne complète jusqu'au settlement de l'IntegrationGate, l'installation confinée
des dépendances, la consigne alignée sur l'allowlist, le QC borné à 3 tentatives, le budget réel sous
plafond (1,715 M / 3 M), aucune double exécution. Ce qu'il reste avant un run 11 (sur autorisation) :
`e83b8f0` prouvé en run (writer qui exécute eslint/vitest), heartbeat + reprise automatique de
l'activité, tolérance de la porte aux timeouts sous charge, ventilation cache persistée.
