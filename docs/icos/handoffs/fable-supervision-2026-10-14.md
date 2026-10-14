# FABLE — prise de commande de la supervision (2026-10-14, 00:00–00:30 UTC+2)

Superviseur : FABLE 5.1, session tmux `icos-fable`, worktree `feat/fable-5-1-convergence` (HEAD `8e25920`).
Règle appliquée : un seul writer par worktree ; les sessions existantes sont réutilisées, jamais doublées ;
aucun push, merge, déploiement ni migration sur base existante.

## 1. Ce qui existe et fonctionne (mesuré, pas déclaré)

| Composant                                   | État                                                                                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chaîne native CORE3 → Temporal → worker bwrap → reviewer → IntegrationGate → settlement | **fonctionne en labo** (N1 run 11 : chaîne complète sans intervention, 533 k tokens, rejet dû à la porte, corrigé par `8e25920`) ; **arrêtée** depuis le run 11, 0 workflow en cours sur `default`, `icos-prod`, `icos-fable-lab` |
| Entrée d'un objectif propriétaire           | existe : `POST /api/goals` (preview) puis `POST /api/missions/autonomous` (enqueue durable, 202) ; exige une session `tasks.write` et le scheduler durable (labo ou prod B2/B3) |
| Production (`icos-web` release 5719213)     | **sans autonomie** (étapes B2/B3 du runbook non appliquées) ; OmniRoute et voix inchangés                                                                              |
| Sessions workers                            | tmux `icos-w9`, `icos-w10` (codex TUI, GPT-6.1-Sol), `icos-p0` (claude TUI) : vivantes, pilotables par fichier de dispatch + `tmux send-keys` ; **chaque commande hors sandbox codex demande une approbation** (docker, TCP, git) — c'est l'intervention manuelle récurrente |
| Outils headless                             | `claude -p` (2.1.292), `codex exec` (0.162.1, `~/.local/share/icos-codex`), `bwrap` ; `bin/icos-claude-worker.mjs` = exécuteur natif                                   |
| Ressources VPS                              | 8 cœurs, charge 4–5, 16 Go disponibles, 235 Go disque ; 20 conteneurs docker dont 10 PG de labo inactifs                                                             |

## 2. Workers, missions, résultats de la session

| Lane | Session   | Worktree / branche                               | Mission dispatchée                                                        | Résultat                                                                                                                      |
| ---- | --------- | ------------------------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| W10  | icos-w10  | `fable-n1-w10-cache` / `fd09189`                 | terminée avant la session (validation technique 357/357)                   | **terminé**, propre, à intégrer                                                                                               |
| W9   | icos-w9   | `fable-n1-w9-cache-ledger` / `e6e4970`           | étape 3 : certification PostgreSQL sur base jetable `w9-pg-cert` (55500)   | **CERTIFIÉ** : 62/62 intégration, anciennes lignes null, 4 rejets 23514, rollback + réapplication 0065 prouvés ; `c6b6ae3` (test de bail déterministe), `e6e4970` (rapport) ; étape 4 en cours (demandes du reviewer) |
| W9 revue | sous-agent Claude (indépendant de l'auteur GPT) | lecture seule sur `6daef30`                    | revue → `docs/icos/handoffs/w9-cache-review-6daef30-2026-10-14.md`          | **REQUEST_CHANGES** : logique conforme ; manque preuve (fournie étape 3), en-tête DATA SAFETY/ROLLBACK + idempotence de 0065, 2 commentaires, autorisation propriétaire de la migration |
| P0   | icos-p0   | `p0-autonomy-unblock` / `77746ec`                | étape 3 : committer le test de régression NODE_ENV                         | **terminé** : `77746ec`, 14/14 ; `5b13cfe` = backport de `96daa94`/`892118b`/`fd09189` déjà en convergence → **ne pas fusionner** |
| OmniRoute | FABLE | —                                              | inventaire + sonde gratuite + certification reviewer                      | `docs/icos/OMNIROUTE_MODEL_STRATEGY_2026-10-14.md` : Nemotron-3-ultra (gratuit) **certifié reviewer 6/6** ; `auto/best-free` sert Opus 5 (à exclure) |

## 3. Intégration préparée (fusion à blanc, rien de fusionné)

Ordre : `fd09189` (W10) → `6daef30`, `c6b6ae3`, `e6e4970` + étape 4 (W9) → port du seul test de `77746ec` (P0).
`git merge-tree` convergence ← W9 : **propre**. Cherry-pick `77746ec` : conflit attendu sur les deux
fichiers (hunk de porte déjà présent via `8e25920`) → garder la convergence pour la porte, prendre le
test `it.each(parents)`. Convergence : `tsc --noEmit` exit 0 (20 s).
Après fusion : `pnpm test`, suites ciblées budget/workspace-manager, puis run N1 (§5).

## 4. Dépendances restantes

1. W9 étape 4 (en cours) → nouvelle lecture du reviewer (courte) → fusion sur autorisation.
2. Décision propriétaire : la création de la migration 0065 était-elle autorisée (le contrat W10/W9
   exigeait une autorisation distincte) ? Si oui, confirmer ; sinon, dire comment procéder.
3. Run N1 n°12 : labo seulement, budget à approuver (proposition §5).
4. Autonomie de développement (priorité 5) : voir §6.

## 5. Prochaine action exécutable (sur autorisation)

Run N1 n°12 dans le labo `~/.icos-fable-lab` : base neuve `icos_fable_lab_run12`, cible
`lab/fable-base` rebasée sur la convergence fusionnée (porte `NODE_ENV=test` incluse), writer
`cc/claude-sonnet-5`, reviewer **`nvidia/nvidia/nemotron-3-ultra-550b-a55b`** (gratuit, certifié), planner
`nvidia/nvidia/nemotron-3-super-120b-a12b` (gratuit) ; plafonds identiques au run 11
(2 M tokens / goal, `--max-budget-usd 5`, 60 min). Objectif : `mission.succeeded` sans intervention.

## 6. Autonomie de développement — plus petit correctif identifié

Le blocage n'est pas l'orchestration (elle existe et a tourné en run 11) mais **l'entrée** : aujourd'hui
seule la détection ESLint (W11) crée des goals ; un objectif formulé par le propriétaire passe par
`/api/goals` + `/api/missions/autonomous`, qui exigent une session humaine `tasks.write`. Plus petit
correctif : un script opérateur `scripts/goal-submit.ts` (même famille que `scheduler:enqueue`) qui
soumet un objectif signé par le propriétaire au scheduler durable du labo, en réutilisant
`goalNormalizer`/`goalPlanner`/`start_mission`. À préparer dans un worktree isolé, sur autorisation ;
aucun orchestrateur parallèle. En attendant, les étapes bornées sont dispatchées aux sessions
existantes (fichiers `~/.icos-fable-lab/dispatch/`), avec approbation des commandes par le superviseur.

## 7. Mise à jour 00:45 — toutes les lanes à l'arrêt, worktrees propres

| Lane | HEAD final | Preuves                                                                                                   | Revue indépendante                                   |
| ---- | ---------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| W9   | `4c09f42`  | 62/62 intégration sur 2 bases vierges jetables ; 0065 : première installation, 2 rejeux no-op, rollback d'en-tête + réapplication, `db:verify-ledger` OK ; 369/369 unitaires | passe 2 **APPROVE** (Claude)                          |
| P0   | `77746ec`  | 14/14 ; port sélectif documenté                                                                            | **APPROVE** (GPT, session W10)                        |
| W10  | `fd09189`  | 357/357 (2026-10-13)                                                                                       | contrat W10/W9                                        |

Nettoyage : conteneur `w9-pg-cert` supprimé ; journaux archivés dans `~/.icos-fable-lab/logs/w9-cert/`.
État durable : `~/.icos-fable-lab/dispatch/ledger.jsonl` (13 entrées : étapes, tentatives, verdicts, preuves).

Correction du §6 : **aucun raccord à développer** — `pnpm scheduler:enqueue '{"kind":"start_mission","payload":{"title":…,"objective":…}}'`
(scripts/schedule-job.ts) soumet déjà un objectif propriétaire au scheduler durable (même validation et idempotence que
`POST /api/missions/autonomous`, sans session HTTP). Limite connue : cette entrée brute contourne les gouverneurs
d'admission (priorité/portefeuille, décision 0065) que la route applique via `goalId` ; pour un run de labo c'est acceptable,
pour la prod il faudra passer par la route ou renseigner `goalId`.

Refus de permission à consigner : `git cherry-pick -n 77746ec` dans la convergence a été bloqué par le classificateur
(« ressource partagée »). Le port du test P0 attend donc l'autorisation ou la main du propriétaire (recette exacte dans
`integration-plan-w10-w9-p0-2026-10-14.md`).
