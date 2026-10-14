# Intégration contrôlée W10 / W9 / P0 sur `feat/fable-5-1-convergence` — proposition (rien d'exécuté)

Préparé par FABLE 5.1 le 2026-10-14. Chaque commande ci-dessous est une FUSION locale (aucun push) et
requiert l'autorisation explicite du propriétaire (règle : aucun merge sans autorisation). Le worktree
cible est `/srv/icos/worktrees/fable-5-1-convergence` (HEAD `8e25920`, typecheck exit 0, propre).

## 1. Ce qui est validé (preuves)

| Lane | Commits                                             | Validation                                                                                                                                                                  | Revue indépendante                                                                                   |
| ---- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| W10  | `fd09189`                                           | 357/357 budget + routing, typecheck, eslint, prettier (session W10, 2026-10-13)                                                                                            | contrat W10/W9 ; relu par W9 en consommateur                                                          |
| W9   | `6daef30`, `c6b6ae3`, `e6e4970`, `8e4f844`, `4c09f42` | 369/369 unitaires ; 62/62 intégration PostgreSQL sur DEUX bases vierges jetables ; 0065 : première installation, 2 rejeux no-op, rollback d'en-tête puis réapplication, journal vérifié | passe 1 REQUEST_CHANGES → passe 2 **APPROVE** (Claude, lecture seule) — `w9-cache-review-2-8e4f844-2026-10-14.md` |
| P0   | `77746ec` (test seul)                               | 14/14 sandboxed-command-runner                                                                                                                                               | **APPROVE** (session W10, GPT, lecture seule) — `p0-nodeenv-test-review-77746ec-2026-10-14.md` : port sélectif = import + bloc `it.each(parents)` uniquement |

Non fusionnable : P0 `5b13cfe` (backport de `96daa94`, `892118b`, `fd09189` déjà en convergence).

## 2. Commandes proposées (dans l'ordre), conséquences, risque

```bash
cd /srv/icos/worktrees/fable-5-1-convergence
# (1) W10 + W9 : fusion à blanc déjà propre (git merge-tree). Merge commit, aucun rebase des lanes.
git merge --no-ff --no-edit feat/fable-n1-w9-cache-ledger
#     Conséquence : +6 commits (fd09189, 6daef30, c6b6ae3, e6e4970, 8e4f844, 4c09f42) ; ajoute drizzle/0065 au journal
#     (idx 61). Aucune base n'est migrée par cette fusion. Risque : faible (merge-tree propre) ; réversible par
#     `git reset --hard 8e25920` tant que rien n'est poussé (à faire par le propriétaire, jamais par un agent).
# (2) P0 : port du SEUL test de régression (le hunk de porte est déjà 8e25920).
git cherry-pick -n 77746ec
git checkout --ours -- src/server/workspace-manager/integration-gate.ts
#     puis résoudre src/server/workspace-manager/sandboxed-command-runner.test.ts : garder la version convergence
#     du bloc « expect(Object.keys(call.env).sort()) » (qui contient déjà "NODE_ENV") et ajouter le bloc
#     `it.each(parents)` de 77746ec (recette précise dans le rapport de revue W10, /tmp/w10-review-p0-77746ec.md).
pnpm exec vitest run src/server/workspace-manager/sandboxed-command-runner.test.ts   # attendu : 14 + 3 PASS
git commit -m "test(gate): NODE_ENV=test is proven through the whole child-environment chain (port of 77746ec)"
# (3) Validation post-fusion (locale)
pnpm typecheck && pnpm exec vitest run src/core/budget src/server/budget src/server/mission src/server/workspace-manager src/server/execution
```

Le cherry-pick (2) a été refusé par le classificateur de permissions de cette session (« ressource partagée ») :
il doit être lancé par le propriétaire ou autorisé explicitement.

## 3. Après fusion : cible du labo pour le run 12

```bash
git -C /srv/icos/worktrees/fable-n1-target fetch . 2>/dev/null; git -C /srv/icos/worktrees/fable-n1-target reset --hard <sha convergence fusionnée>
#     Conséquence : lab/fable-base avance de 96daa94 à la convergence fusionnée ; les branches ws/* des runs 9–11 restent.
#     Risque : nul pour la prod ; le labo est propre (dirty=0).
```

## 4. Migration 0065 en production : hors périmètre ici

Jamais appliquée par ces commandes. Elle entrera en prod par la politique de release (preflight sur clone de la base
live, `pnpm db:verify-ledger`, rollback d'en-tête testé) — étape F1 bis à préparer séparément.
