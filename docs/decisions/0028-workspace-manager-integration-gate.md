# ADR-0028 — Workspace Manager et Integration Gate

- Statut : accepté (v1, outillage local)
- Date : 2026-09-19
- Portée : parallélisme multi-workers ; aucune donnée tenant, aucun changement du runtime ICOS

## Contexte

Plusieurs workers (7A, 7B, 7C…) travaillent en parallèle dans des worktrees git. Les collisions déjà
observées : `drizzle/0031_*` créé indépendamment par 7B (`0031_operational_memory`) et 7C
(`0031_recovery_units`), bases de test partagées, fichiers `shared` (`_journal.json`, `production-services.ts`)
modifiés par plusieurs branches. Il faut un cycle formel et vérifiable :
Mission/Task → workspace isolé → branche → DB de test → scope fichiers → validation → gate → accept/reject.

## Décision

Module `src/server/workspace-manager/` (dev tooling, indépendant de Next.js/Drizzle) + CLI
`pnpm workspace:manager` :

| Brique                            | Rôle                                                                                                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types` / `WORKSPACE_TRANSITIONS` | modèle `Workspace` et machine à états à 11 états, transitions fermées                                                                                                                                    |
| `guards`                          | slug, chemin (strictement sous `/Users/coco/icos-worktrees/`, jamais le dépôt maître), branche (jamais main/integration/release), cible `integration/*`, nom de DB `icos_test_<slug>` sans `probe        | live | prod` |
| `registry`                        | port + registre fichier hors dépôt (`<racine>/.registry`), transactions à exclusion mutuelle : les invariants d'unicité y sont vérifiés                                                                  |
| `manager`                         | `request` → `create` (`git worktree add <path> -b <branch> <base>` + DB dédiée) → transitions, leases, `cleanup`                                                                                         |
| `scope`                           | `owns` / `shared` / `forbidden` (forbidden > shared > owns > hors périmètre) ; recouvrement de `owns` refusé entre workspaces actifs                                                                     |
| `migrations` / `checks`           | réservation de numéros drizzle par workspace ; rejet de l'édition d'une migration existante ou non réservée ; numéro déjà pris par la cible → NEEDS_REBASE ; migration non additive → validation humaine |
| `integration-gate`                | 12 gates dans l'ordre, arrêt à la première décision bloquante ; décisions ACCEPT / REJECT / NEEDS_REBASE / NEEDS_HUMAN_APPROVAL                                                                          |
| `report`                          | format `KEY=VALUE` par workspace                                                                                                                                                                         |

### Choix structurants

- **Registre fichier, pas de migration PostgreSQL en v1.** L'état est de l'outillage de développement, pas
  une donnée tenant. Ajouter `0031/0032` ici recréerait exactement la collision de numéros que l'outil
  doit prévenir (7B et 7C occupent déjà 0031). `WorkspaceRegistry` est un port : une implémentation
  PostgreSQL pourra être ajoutée sans toucher au reste, avec sa propre réservation de migration.
- **Git sans shell, allowlist de sous-commandes** (`worktree`, `branch`, `rev-parse`, `diff`, `merge-tree`…),
  options `--force`, `-f`, `-D`, `--hard` refusées. Pas de `reset`, `push`, `merge`, `rebase`, `checkout`, `clean`.
- **Détection de conflit sans toucher l'arbre** : `git merge-tree --write-tree` (aucune ref, aucun fichier
  modifié). Les conflits sont **listés, jamais résolus** ; la résolution appartient à l'Integration Agent/humain.
- **Le gate ne merge rien.** ACCEPT = « intégrable ». La branche `integration/phase-7` doit exister (création
  explicite `git branch integration/phase-7 <commit>`) ; le merge vers la branche de référence reste humain.
- **Base obsolète = NEEDS_REBASE** dès que la cible n'est pas ancêtre du commit (les tests doivent porter sur
  le résultat intégrable).
- **Env des commandes** : toute `*DATABASE_URL`/`PGDATABASE` héritée est supprimée ; `ICOS_TEST_DATABASE_URL`
  pointe sur la DB dédiée du workspace, recréée à vide avant les tests PostgreSQL (migrations prouvées depuis zéro).
- **Cleanup sûr** : refus si changement non commité ; `git worktree remove` sans `--force` ; `git branch -d`
  (branche non fusionnée conservée) ; DB dédiée supprimée ; archive JSON hors dépôt.

## Conséquences / limites v1

- Pas d'auto-merge, pas d'orchestration de dizaines de workers, pas d'UI (hors périmètre).
- Manifest de scope en JSON (pas de dépendance YAML ajoutée).
- La revue (gate 12) est fournie en entrée ; un reviewer identique au worker est traité comme absence de revue.
- Les schémas de `.icos/decisions` numérotés DEC-* ne sont pas modifiés ; l'ADR suffit pour cette v1.
- Le registre fichier est local à la machine (verrou par fichier, verrou périmé après 60 s).
