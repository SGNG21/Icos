# ICOS Workspace Manager & Integration Gate

Task Contract (résumé) — **scope** : `src/server/workspace-manager/**`, `scripts/workspace-manager.ts`,
`docs/**`, une ligne `package.json`. **Interdit** : dépôt maître, autres worktrees, live DB, `main`, secrets,
migrations. **Preuves** : typecheck, lint, tests unitaires (Git réel jetable), test PostgreSQL sur DB dédiée, build.

## Cycle

```
request → create → working → validating → ready_for_integration → integrating → accepted | rejected
              (git worktree + DB dédiée)                     (Integration Gate)
                                                    accepted/rejected/abandoned → cleanup
```

États : `requested creating ready working validating ready_for_integration integrating accepted rejected
blocked abandoned` (transitions : `WORKSPACE_TRANSITIONS`).

## Utilisation

Depuis n'importe quel worktree du dépôt ICOS (jamais depuis le maître pour écrire) :

```bash
# scope.json
# { "owns": ["src/server/memory/**","test/memory/**"],
#   "shared": ["src/server/system/production-services.ts","drizzle/meta/_journal.json"],
#   "forbidden": [".env.local","secrets/**"] }
pnpm workspace:manager request --slug 7d --worker w-7d --mission m1 --task t1 --scope-file scope.json --migrations 1
pnpm workspace:manager create <workspace_id>
pnpm workspace:manager transition <id> working --actor w-7d      # … validating, ready_for_integration
pnpm workspace:manager gate <id> --reviewer reviewer-1            # exit 0/10/11/12 = ACCEPT/REJECT/NEEDS_REBASE/NEEDS_HUMAN_APPROVAL
pnpm workspace:manager gate <id> --reviewer r --approved-by owner # après NEEDS_HUMAN_APPROVAL, approbation explicite
pnpm workspace:manager cleanup <id>
```

Prérequis : la cible d'intégration (`integration/phase-7` par défaut) doit exister :
`git branch integration/phase-7 <commit>` (création volontaire, non automatisée).

Conventions dérivées du `slug` : branche `ws/<slug>`, worktree `/Users/coco/icos-worktrees/<slug>`,
DB `icos_test_<slug>` (`-` → `_`), migrations `NNNN_ws_<slug>_<nom>.sql`. Registre : `<racine>/.registry/workspaces.json`,
archives : `<racine>/.archive/` (hors dépôt).

## Invariants (et où ils sont imposés)

| Invariant                                                          | Mécanisme                                                                                                   |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Un workspace actif = une branche ; une branche = un worktree actif | unicité vérifiée dans la transaction du registre **et** contre `git worktree list` / `show-ref` / disque    |
| Une DB de test = un workspace                                      | `icos_test_<slug>` unique parmi les workspaces non libérés ; `probe                                         | live | prod` refusés (`assertWorkerDatabaseName`) ; `DATABASE_URL` héritée supprimée pour les commandes du gate |
| Aucune écriture dans le dépôt maître / hors racine                 | `assertWorktreePath` (normalisé, strictement sous la racine, symlinks vérifiés à la création)               |
| Aucun merge dans main                                              | aucune commande `merge/push/reset/checkout/clean` dans l'allowlist git ; cible = `integration/*` uniquement |
| Traçabilité                                                        | `workspaceId` ↔ `workerId`/`missionId`/`taskId`/`baseCommit`/`sourceCommit`/`commitSha` du rapport          |
| Ownership exclusif                                                 | `owns` recouvrants refusés entre workspaces actifs                                                          |
| Migrations                                                         | numéros réservés par workspace ; jamais d'édition d'une migration existante                                 |
| Pas de perte de travail                                            | `cleanup` refuse tout changement non commité ; jamais `--force` ni `-D`                                     |

## Integration Gate (ordre, arrêt à la première décision bloquante)

1 scope · 2 secrets · 3 migrations · 4 typecheck · 5 lint · 6 tests unitaires · 7 tests PostgreSQL (DB dédiée recréée
à vide, migrations depuis zéro) · 8 build · 9 diff (`diff --check`, non vide, base ancêtre) · 10 security ·
11 conflits avec la cible · 12 revue.

| Décision               | Déclencheurs                                                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REJECT`               | fichier forbidden/hors périmètre, secret, migration existante modifiée ou non réservée, échec typecheck/lint/tests/build, diff invalide, revue « changes requested »                                     |
| `NEEDS_REBASE`         | la cible a avancé (`BEHIND`), conflits avec la cible (`CONFLICT`, fichiers listés), numéro de migration déjà pris par la cible                                                                           |
| `NEEDS_HUMAN_APPROVAL` | fichier modifié par plusieurs workers, gouvernance touchée (CLAUDE.md, `.claude/`, `.icos/`, configs lint/test, guards), tests/lint/types affaiblis, migration non additive, revue absente ou auto-revue |
| `ACCEPT`               | toutes les gates passent (fichiers `shared` d'un seul worker sont **signalés** dans le rapport)                                                                                                          |

Le gate exige un worktree propre sur un commit (jamais d'évaluation de changements non commités). Les valeurs
secrètes ne sont jamais écrites dans le rapport (fichier + règle uniquement).

## Rapport

`WORKSPACE_ID WORKER_ID BRANCH WORKTREE BASE_COMMIT TARGET_COMMIT TEST_DATABASE FILE_SCOPE_STATUS
SHARED_FILES_CHANGED MIGRATIONS TYPECHECK LINT UNIT_TESTS POSTGRES_TESTS BUILD SECRET_CHECK CONFLICT_STATUS
INTEGRATION_DECISION COMMIT_SHA` (+ `REASONS`), une clé par ligne — voir `formatReport`.

## Flux d'intégration

`branches worker → Integration Gate → (intégration contrôlée) integration/phase-7 → tests globaux → validation humaine
→ merge humain vers la branche de référence`. Le gate ne fait que décider ; il n'écrit sur aucune branche.

## Tests

`pnpm test` (Git réel dans des dépôts jetables, faux exécuteur de commandes) et
`pnpm test:integration` (`test-database.integration.test.ts` : PostgreSQL réel, base `icos_test_wm_<aléa>` jetable).
