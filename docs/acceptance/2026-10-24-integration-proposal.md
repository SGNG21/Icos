# Proposition d'intégration — activation gouvernée des 12 cerveaux (ADR 0068)

**Ceci est une proposition, pas une action.** Rien n'a été poussé sur `origin`, aucune PR
n'est ouverte, aucune fusion n'a eu lieu, aucune migration n'a tourné, aucune donnée de
production n'a été touchée. Ce document rassemble ce qu'une proposition d'intégration
contiendrait une fois les trois points ouverts (§Conditions) résolus — pour que la décision du
propriétaire porte sur le fond, pas sur la reconstruction du contexte.

## Ce qui est proposé

Fusionner `worktree-brain-activation-governance` (**HEAD `f233627`**) dans
`feat/omniroute-backend-20261021` (tip `c350399`) — descendant fast-forward trivial, zéro
commit divergent, zéro réécriture d'historique.

19 fichiers, 0 suppression. Cinq routes HTTP (`GET /status`, `POST
/bootstrap-data/seed`, `POST /roles/[roleId]/certify`, `POST /roles/[roleId]/activate`, `POST
/brains/activate`) qui activent les 12 cerveaux sous gouvernance ADR 0068, plus leur
documentation (dossier Phase 1, runbook propriétaire) et leurs tests. **Zéro ligne modifiée**
dans `mission-binding.ts`, `chief-delegation.ts`, ou tout autre fichier CORE3 — ADR 0070 intact.

## Preuves

| Contrôle                                                                                  | Résultat                                |
| ----------------------------------------------------------------------------------------- | --------------------------------------- |
| `pnpm lint`                                                                               | 0 erreur                                |
| `pnpm typecheck`                                                                          | propre                                  |
| Suite unitaire complète                                                                   | 351 fichiers / 5091 tests PASS          |
| PostgreSQL (`src/server/workforce/`, Testcontainers)                                      | 3 fichiers / 16 tests PASS              |
| Routes HTTP (`workforce-activation.test.ts`)                                              | 30/30 PASS                              |
| Revue indépendante n°1 (`08ce1a3`+`bfc02a2`)                                              | « sûr pour IntegrationGate », 9/10 PASS |
| Trois corrections signalées (certification sans preuve, erreur brute, conflit non traité) | corrigées, 4 tests de régression dédiés |
| Revue indépendante n°2 (sur ces 3 corrections)                                            | **en cours**                            |

## Aucune autocertification

Chaque étape de gouvernance (certification, activation, octroi d'outils) exige une session
Better Auth réelle d'un humain muni de `agents.manage` — aucune route, aucun script de cette
mission ne fabrique de principal. `SELF_CERTIFICATION` reste vérifié par le code, pas
contourné. Le dossier Phase 1 et le runbook documentent explicitement la limite restante
(`testsPassed`/`evidenceRef` sont une attestation humaine, pas une preuve calculable) comme
une décision de gouvernance à trancher par le propriétaire, pas un défaut de code.

## Aucune modification de production

Cette proposition ne contient aucune commande exécutée contre `icos_app` ou le VPS. Le
runbook (`docs/icos/BRAIN_ACTIVATION_RUNBOOK.md`) documente la procédure que le propriétaire
devra suivre lui-même, séparément, après intégration — cette proposition ne la déclenche pas.

## Conditions avant de transformer cette proposition en action (push + PR)

1. **Verdict de la revue indépendante n°2** (bornée aux 3 corrections) — en attente.
2. **Confirmation de la branche d'intégration correcte** — question envoyée à un pair
   (North Star, faute de pouvoir atteindre FABLE 5.1, dont la session s'est terminée) ; sans
   réponse à ce jour. Ne pas supposer `feat/omniroute-backend-20261021` acquis sans elle.
3. **Décision propriétaire séparée sur la base de 596 commits** (`feat/omniroute-backend-20261021`
   elle-même, jamais poussée, jamais auditée avant aujourd'hui) : j'ai scanné l'intégralité de
   son historique par motifs de secrets (aucun trouvé — voir
   `docs/acceptance/2026-10-24-worker-b-handoff.md` §Dépôt public pour le détail) mais cela ne
   remplace pas une autorisation explicite de publication, distincte de la décision portant sur
   mes propres 9 commits.

**Tant que ces trois points ne sont pas résolus, aucun push, aucune PR, aucune fusion.**
