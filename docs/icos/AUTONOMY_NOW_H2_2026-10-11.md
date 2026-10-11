# AUTONOMY NOW — État H2 (FABLE 5.1, 2026-10-11 20:20 CEST)

Lecture seule : aucun service, aucune base, aucun worktree d'un autre worker modifié. Le labo N1
run3 (app pid 1011643, worker pid 1011661, démarrés 20:18, sans TTY, session propre) n'a pas été touché.

## Sources de vérité

| Document | État sur le VPS |
| --- | --- |
| `ICOS_ULTIMATE_NORTH_STAR.md` | **absent** (aucune occurrence dans le repo, les branches ni le disque). Seule référence : `docs/ICOS_MASTER_PLAN.md` §North Star et `docs/architecture/future/11-first-autonomous-icos.md` |
| Dossier « ICOS FABLE 5 / BOOST PACK » | **absent** du VPS |
| ADR 0072 (texte) | absent (signalé par le worker adr0072 ; seul le code de phase 1 existe) |
| Contrats canoniques, ADR 0059–0076, certification N1 (`test/n1-*.test.ts`, `vitest.n1-real-integration.config.ts`) | présents sur `feat/p0-autonomy-unblock` |

## Verdicts (preuves)

```
AUTONOMY_N1        = FAIL   (en cours : labo run3 démarré 20:18 ; icos_lab : goals=0 missions=0 proposals=0 ; prod : 0 mission depuis toujours)
HEADLESS_EXECUTION = PASS   (labo) claude 2.1.292 sous bwrap, réseau coupé vérifié, proxy compté → OmniRoute (codex/gpt-5.5-low), 2 appels / 9 937 tokens au ledger PG, hello.txt=OK, exit 0, 0,032 USD — scratchpad p0-autonomy-unblock/evidence-claude-headless.log
INDEPENDENT_REVIEW = FAIL   prod : ICOS_REVIEWER_COMMAND=/usr/bin/printf (R7) ; labo : ICOS_REVIEWER_MODEL configuré, verdict attendu de run3
DURABLE_MEMORY     = FAIL   implémenté (memory_*, mission_memory_entries, trace W9 `pnpm mission:trace`) — jamais exercé sur un cycle réel
RECOVERY           = FAIL   implémenté : W6 « restart after dispatch/before review resumes once » (harness Temporal), unité worker kill -9 → relance ~10 s (labo souveraineté) — pas sur cycle réel
NO_DOUBLE_DISPATCH = FAIL   implémenté : leases/claim_token, W6 replay byte-identique + re-run sweeps (harness) — pas sur cycle réel
BUDGET_ENFORCEMENT = FAIL   partiel : W10 DENY avant tout appel (testé), caps tokens OK ; ledger « unpricedCalls=2, amount=0 » → le plafond en devise est inopérant tant qu'OmniRoute ne price pas
MAC_INDEPENDENCE   = FAIL   services 100 % VPS, mais ICOS_REPO_PATH / ICOS_WORKER_WORKSPACE_ROOT / ICOS_WORKSPACE_ROOT absents de /srv/icos/etc/icos.env → repli code sur /Users/coco (M1–M3)
VPS_UNATTENDED     = FAIL   icos-web + icos-omniroute : systemd enabled, Restart=on-failure, system.slice ; aucun worker Temporal en prod ; le labo tourne via setsid, pas systemd
AUTONOMY_NOW       = FAIL
```

## Topologie réelle du code (écart live / N1 / VPS / convergence)

- **Base commune** de toutes les lanes actives : `5448b9b` (fix security same-origin). `main` local = `ca138e2` (16 août) : **80 commits derrière / ~425 devant** cette lignée ; fusionner le hub dans `main` = 35 fichiers en conflit. `main` n'est pas la cible d'intégration utilisable aujourd'hui.
- **Live (prod)** : `icos-web` sert `/srv/icos/worktrees/vps-deploy` @ `049a7d9` = `5448b9b` + 5 commits voix. Aucun code P0 autonomie en prod.
- **Hub N1** : `feat/p0-autonomy-unblock` @ `d3edd8a` = `lab/n1-runtime` (même commit) = W1–W11 + ADR 0073 + W8. Le labo (`p0au-n1-lab`) tourne ce commit, cible d'intégration `lab/base` → `integration/n1-lab` dans `p0au-n1-target`.
- **VPS kit** : `feat/p0-vps-sovereignty` @ `449fda6` (49 commits sur base, inclut une partie du hub) — fusion à blanc avec le hub : **0 conflit**.
- **Mon worktree** `feat/fable-5-1-convergence` @ `ca138e2` = vieux `main` : inutilisable tel quel, à rebaser sur `d3edd8a`.

Fusions à blanc (`git merge-tree`) contre le hub `d3edd8a` :

| Branche | Conflits | Non commité dans le worktree |
| --- | --- | --- |
| feat/p0-vps-sovereignty 449fda6 | 0 | 0 |
| fix/voice-e2e-auth cb10490 | 0 | 1 (scripts/voice-e2e.ts) |
| fix/voice-hangup-proof 6239646 | 0 | 0 |
| deploy/vps-runtime 049a7d9 | 0 | 0 |
| fix/cognition-explicit-stream, fix/tts-router-runtime-reconcile | 0 | 0 |
| cert/adr0073-materialization 7b3bcc2 | 0 (déjà dans le hub) | **7 fichiers modifiés non commités** |
| feat/p0-natural-voice 12b470c | 1 (src/server/cognitive/index.ts) | 0 |
| feat/adr0072-phase1-snapshot 2200d79 | 3 (_journal.json, postgres-workspace-registry.ts, types.ts) | 0 |
| integration/vps-autonomy-rehearsal 5448b9b | — | **38 fichiers non commités** (auth, completed route) |

## Matrice de capacités

| CAPABILITY | WORKER | BRANCH | COMMIT | TESTS | ÉTAT | BLOQUEUR | PROCHAINE ACTION |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 Détection anomalie / objectif | W11 | p0-autonomy-unblock | aece80b | self-development-e2e (Temporal réel) | implémenté, non certifié | run3 | lire verdict run3 |
| 2 Priorité + politiques (risk policy 8 classes) | W2 | idem | f67bb69/4e4d8f7 | unit + intégration PG | implémenté, non certifié | — | idem |
| 3 Plan borné | planner | idem | c59a838 (stream:false) | n1-integration | implémenté | OmniRoute SSE par défaut | idem |
| 4 Mission durable | CORE3 | idem | e1d7ce5 (W9) | intégration PG | implémenté | — | idem |
| 5 Worker en worktree isolé | W7/ADR0073 | idem | eabdbfd, 7b3bcc2 | gate-isolation, bwrap réel | implémenté | chemins Mac en prod (env) | appliquer env |
| 6 Exécuteur Claude Code via OmniRoute | W10 | idem | 02b6706 | adapter, proxy, bwrap, live | **certifié labo** | aucun vrai modèle Claude derrière OmniRoute (`auto/claude-sonnet` = gemini-3.1-flash-lite) | choisir le modèle d'exécution |
| 7 Artefact réel | W10 | idem | 02b6706 | live (hello.txt) | certifié labo | — | — |
| 8 Tests adaptés (gate sandbox, PG jetable) | W7 | idem | eabdbfd | gate-report-audit | implémenté | — | run3 |
| 9 Reviewer indépendant | W6 | idem | f15f255 | p0-autonomy-e2e (REQUEST_CHANGES→APPROVE) | implémenté (harness) | prod = printf | configurer ICOS_REVIEWER_MODEL en prod |
| 10 Correction sous budget | W6/W8 | idem | 561aadf | QC retry exhaustion (chaos) | implémenté | pricing OmniRoute absent | — |
| 11 IntegrationGate | W7/hub | idem | 8828857 | intégration | implémenté | cible `integration/<name>` seulement | définir la cible prod |
| 12 Décisions + enseignements | W9 | idem | cf5678f | intégration PG | implémenté | — | — |
| 13 Clôture + compte rendu | W9 | idem | cf5678f | `pnpm mission:trace` | implémenté | — | — |
| Supervision systemd worker | p0-vps-sovereignty | 449fda6 | 449fda6 | kill -9 labo | implémenté, non activé | autorisation prod | README étapes 1–3 |
| Sauvegardes PG/Temporal/OmniRoute | idem | 449fda6 | 449fda6 | restauration labo 1000/1000 | implémenté, non activé | copie hors-hôte à décider | idem |
| Env sans Mac | idem | 449fda6 | 449fda6 | — | prêt | autorisation prod | idem |
| Temporal prod dédié / namespace | idem | — | — | — | **manquant** | décision propriétaire (R3) | créer `icos-prod` |
| OmniRoute « Require API key » | — | — | — | — | **manquant** (R1) | action propriétaire (SQLite) | dashboard |
| Fiabilité OmniRoute | worker OmniRoute | — | — | — | **bloqué** : `/v1/models` timeout 10 s à 20:19, labo `COMPUTE_BOOTSTRAP PROVIDER_UNAVAILABLE` 20:10, load 13.9 | charge hôte (10 conteneurs PG labo, builds) | laisser au worker ; ne pas lancer de build pendant run3 |
| « Failed to load providers » | worker OmniRoute | — | — | 0 occurrence journald/icos-web.log 48 h | non reproduit | — | hors chemin critique |
| Continuité vocale après session | voice-e2e-auth | cb10490 | cb10490 | continuityWithoutSession | implémenté (harness t5/t6 en cause) | — | P2, laisser au worker |
| Hangup / expiry | p0-voice-hangup | 6239646 | 6239646 | unit | implémenté | — | P2 |
| ADR 0072 snapshot | integration-vps | 2200d79 | 2200d79 | 38+72+32 | hors MVP (3 conflits) | — | après MVP |

## Ce qui manque réellement pour AUTONOMY_NOW

1. Le verdict du **run3** du labo (premier cycle réel ; W6 est un harness, pas un PASS de production).
2. Une **branche de convergence** sur la lignée `5448b9b` : hub `d3edd8a` + kit VPS `449fda6` + voix (`cb10490`, `6239646`) — toutes sans conflit. `main` est à écarter comme cible.
3. **Activation prod** (toutes les pièces existent, rien n'est appliqué) : env sans Mac, unité `icos-temporal-worker`, `icos-backup.timer`, `ICOS_WORKER_EXEC_COMMANDS` = exécuteur W10, reviewer réel, namespace Temporal `icos-prod`, déploiement depuis un répertoire de release (R4), OmniRoute avec clé requise (R1).
4. Un modèle d'exécution réellement routable et **pricé** par OmniRoute (sinon le plafond en devise reste inopérant).

## Commits prêts

`d3edd8a` (hub N1, typecheck OK, migrations 0062→0064 vérifiées), `449fda6` (kit VPS), `cb10490`, `6239646`, `049a7d9` (live). Non prêts : `cert/adr0073-materialization` et `integration/vps-autonomy-rehearsal` (travail non commité), `feat/adr0072-phase1-snapshot` et `feat/p0-natural-voice` (conflits, hors MVP).

## Blocages

OmniRoute instable sous charge (timeout `/v1/models`, bootstrap compute en échec) ; aucun vrai modèle Claude derrière OmniRoute ; appels non pricés ; `main` divergente ; Temporal prod partagé avec les tests ; `/v1` sans clé ; reviewer prod factice.

## Autorisations humaines strictement nécessaires

A. Cible d'intégration = branche de convergence issue de `d3edd8a` (pas `main`) ; je rebase mon worktree dessus et y fusionne `449fda6` + voix, sans push.
B. Appliquer `deploy/vps/README.md` étapes 1–3 en prod (env, worker, sauvegardes) → modifie `/srv/icos/etc/icos.env` et redémarre `icos-web`.
C. Activer « Require API key » dans le dashboard OmniRoute (SQLite, propriétaire seul).
D. Créer le namespace Temporal `icos-prod`.
E. Valider le scénario de première mission ci-dessous et sa cible `integration/autonomy-now-001`.
F. Déployer la convergence (restart `icos-web`) — après B–E.

## Première mission autonome (bornée, réversible, vérifiable)

Même chemin que le labo, sur la prod : détection ESLint confinée (W11, 1 proposition/jour) → politique → plan → worktree sous `/srv/icos/workers` → Claude Code via OmniRoute (W10, réseau coupé, cap USD/tokens par run) → gate sandbox (typecheck + lint + tests ciblés, PG jetable) → revue `ICOS_REVIEWER_MODEL` indépendante → intégration vers `integration/autonomy-now-001` (jamais `main`, pas de push) → trace. Réversible : suppression branche + worktree. Vérification : `pnpm mission:trace <id>`, lignes gate_report / audit / ledger en PG, `icos-sovereignty-check.sh` → `ICOS_WORKERS_VPS=PASS`.

## Prochaine étape exécutable (sur autorisation A)

Dans mon worktree uniquement : `git rebase` sur `d3edd8a`, fusion de `449fda6` puis `cb10490`/`6239646`, `pnpm typecheck` + suites n1/gate/claude-executor, diff analysé — pendant que run3 se termine (aucun build lancé tant qu'il tourne).

## Mise à jour H3 (20:40) — run3, convergence, labo D/E

**Verdict labo run3** (base `icos_lab_run4`, worker p0-autonomy-unblock, aucun opérateur) :
`goal.created` 18:27:45 (détection W11 : « Remove unused symbols from in-memory Git workspace
manager ») → `goal.converted` → mission `sd-mission-47fcfb9ba6de346e` → 3 tâches (1 `queued→running`
via Temporal, 2 `draft`) → `task.execution.completed outcome=failure WORKER_FAILED` 18:28:36 →
QC `ESCALATE` → `task.failed` → `mission.failed` 18:28:37. Cause : `icos-claude-worker: claude failed
(error_max_budget_usd: )` — le CLI Claude a atteint son propre plafond `--max-budget-usd 1.50` sans
produire de sortie. Dépense : 48 appels / ~110 k tokens, tous `UNPRICED` (« modèle absent de la table
de prix » : `ICOS_PRICE_REGISTRY` est vide par conception). Conclusion : **la boucle se ferme seule et
proprement sur l'échec (bornée, auditée, 1 seul dispatch), mais aucun artefact** → `AUTONOMY_N1=FAIL`
maintenu ; la correction appartient à la lane W10 (run4 relancé 20:27, non perturbé).

**Convergence (A)** : `feat/fable-5-1-convergence` recréée sur le hub `d3edd8a`, fusions `--no-ff`
de `449fda6`, `cb10490`, `6239646` : 0 conflit, 48 fichiers (+5184/−184), lockfile identique au hub,
`tsc --noEmit` exit 0, **801 tests unitaires PASS / 4 skipped (54 fichiers)** sur voice, workers,
workspace-manager, scripts. Kit VPS : `bash -n` OK, `systemd-analyze verify` OK (hors script non
installé). Non poussée.

**Labo D** : namespace Temporal `icos-fable-lab` créé sur le serveur de labo `p0au-temporal`
(additif, `workflow list` vide) — la commande d'isolation est validée pour `icos-prod`.

**E (préparé)** : contrat `.icos/contracts/AUTONOMY-NOW-001.yaml` (schéma `task-contract`), modèle
d'env `deploy/vps/env/icos.env.autonomy.example`, runbook `docs/icos/AUTONOMY_NOW_ACTIVATION_RUNBOOK.md`
(B/C/F : préalables, preuves, rollbacks — rien d'appliqué).

## Estimation réaliste

- H2–H8 : verdict run3 + branche de convergence testée (sans push).
- H8–H24 : activation prod (B–E) et première mission réelle sur `integration/autonomy-now-001` — **conditionnée aux autorisations B–E données avant H8** et à un OmniRoute stable.
- H24–H48 : recovery (kill worker en mission, reboot autorisé), sauvegarde/restauration, sécurité (R1, R3) → `AUTONOMY_NOW` décidable.
Si run3 échoue ou si OmniRoute reste instable : +12 à 24 h.
