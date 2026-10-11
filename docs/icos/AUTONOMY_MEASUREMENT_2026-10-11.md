# Première mesure vérifiable du niveau d'autonomie d'ICOS — 2026-10-11

Branche : `feat/br06-autonomy-center` (sur la convergence `7fb06be`). Décision : ADR 0077.
Commande reproductible : `pnpm autonomy:assess [--json] [--direct]` (lecture seule ; `--direct`
n'utilise que les quatre dépôts lus par l'évaluation, sans composer le runtime).

## Résultats

| Runtime | Base | Commande | Niveau | Certification | Dimensions prouvées |
| --- | --- | --- | --- | --- | --- |
| Labo N1 (p0-autonomy-unblock, run4) | `icos_lab_run4` @ 127.0.0.1:55445 | `ICOS_RUNTIME_TIER=lab pnpm autonomy:assess` (19:29:43 UTC) | **L2** | **LAB_CERTIFIED** | Planning (1), Routing (1), Review (2) |
| Live (`icos-web` @049a7d9) | `icos_app` @ 127.0.0.1:5433 | `ICOS_RUNTIME_TIER=live pnpm autonomy:assess --direct` (19:33:32 UTC) | **L0** | CODE_READY | aucune (toutes les sources lisibles, 0 preuve) |

### Labo — preuves (lignes durables, identifiants exacts)

```
Planning          PROVEN    LAB_CERTIFIED   proofs=1 last=2026-10-11T19:08:01.200Z
    audit_entries:ffb4fbfe-e70a-4f10-890f-b30221c69b52  goal sd-goal-47fcfb9ba6de346e → mission sd-mission-47fcfb9ba6de346e, 3 task(s) planned by system
Routing           PROVEN    LAB_CERTIFIED   proofs=1 last=2026-10-11T19:09:25.621Z
    audit_entries:audit-a8540752-a0f6-4822-a223-d6aca8fc6f81  execution success, task task-d25aba8b-5fc5-446b-b5e1-184e71a13b0c (workflow icos-task-task-d25aba8b-5fc5-446b-b5e1-184e71a13b0c)
Recovery          UNPROVEN  CODE_READY      proofs=0
Review            PROVEN    LAB_CERTIFIED   proofs=2 last=2026-10-11T19:12:50.684Z
    review_decisions:review-1791745787946-wvddhfkfh  review REQUEST_CHANGES by llm (cx/gpt-5.6-sol) on mission sd-mission-47fcfb9ba6de346e
    review_decisions:p7kyaxqwmli881534wvcx  review BLOCK by deterministic on mission sd-mission-47fcfb9ba6de346e
Integration       UNPROVEN  CODE_READY      proofs=0
Self-development  UNPROVEN  CODE_READY      proofs=0   (1 self-development goal proposed; a proof needs one that succeeded)
Deployment        UNKNOWN   NONE            proofs=0   (no source)
L2: L3 needs Recovery proven.
```

Lecture : depuis run3 (mission `failed` à 18:28 UTC), le labo a progressé — une exécution Claude
Code a réussi (19:09) et deux revues indépendantes ont été rendues (19:12 : `REQUEST_CHANGES`
par le LLM, `BLOCK` par le relecteur déterministe). Ni correction intégrée, ni mission
`succeeded` : L4 reste hors d'atteinte tant que la boucle correction → porte → intégration ne
se ferme pas.

### Live — lecture

Toutes les sources sont lisibles (`goal.converted`, `task.execution.completed`,
`workspace.gate.reported`, `review_decisions`, `goals`) et vides : le runtime live n'a jamais
converti un objectif ni exécuté une tâche. **L0** est la mesure honnête, pas une panne de mesure.
Le cockpit live (@049a7d9) ne contient pas encore ce code : il continuera d'afficher UNKNOWN /
NOT AVAILABLE jusqu'au déploiement de la convergence (autorisation F1).

## Matrice LIVE / LAB / CODE_READY / MISSING

| Dimension | LIVE | LAB | CODE_READY | MISSING |
| --- | --- | --- | --- | --- |
| Planning | UNPROVEN (0) | PROVEN (1) | W4/CORE3 `goal.converted` | — |
| Routing | UNPROVEN (0) | PROVEN (1) | W10 + callback `task.execution.completed` | — |
| Recovery | UNPROVEN (0) | UNPROVEN (0) | W6 harness ; preuve = succès après échec sur la même tâche | une tâche reprise avec succès |
| Review | UNPROVEN (0) | PROVEN (2) | `review_decisions` (llm + déterministe) | — |
| Integration | UNPROVEN (0) | UNPROVEN (0) | W7 `workspace.gate.reported` (0063) | un rapport de porte `ACCEPT` |
| Self-development | UNPROVEN (0) | UNPROVEN (1 proposé) | W11 + `goals.metadata.source` | une mission self-dev `succeeded` |
| Deployment | UNKNOWN | UNKNOWN | — | une source (registre de releases) |
| Interventions humaines (BR-07) | 0 taguées (aucun site de tag déployé) | 0 taguées | tag à la source : approbations, commandes de contrôle | transitions manuelles, holds/re-drives, RETRY_TASK |

## Limites déclarées (affichées dans le cockpit)

- L5 et L6 ne sont pas mesurables : aucune source n'enregistre une priorisation par valeur.
- Les compteurs mémoire de `SelfDevelopmentMetrics` ne sont pas des preuves (remis à zéro au boot).
- Sans `ICOS_RUNTIME_TIER`, une preuve est créditée CODE_READY, jamais certifiée.
- Deployment reste un acte humain tant qu'aucun registre de releases n'existe.
- La mesure live par le code du hub exige `--direct` tant que la base live précède la migration 0062.

## Tests reproductibles

- `src/core/autonomy/assessment.test.ts` — 8 cas : L0 vide, UNKNOWN si source illisible, L1→L2→L3, L4 exige la mission self-dev réussie, tier → certification, plafond d'affichage des preuves.
- `src/core/autonomy/intervention.test.ts` — tag, humain seulement, registre par raison/mission, proxies à part, `auth.*` jamais.
- `src/server/autonomy/autonomy-evidence.test.ts` — 7 cas dont la forme exacte du run3 du labo (→ L1), proof de recovery sur la même tâche, gate ACCEPT seulement, reviewer ICOS seulement, source cassée → UNKNOWN sans fuite du message interne.
- `src/features/cockpit/snapshot.test.ts` — interventions taguées vs proxy, niveau depuis l'évaluation, UNKNOWN et absence restent des manques.
- Résultat : typecheck exit 0 ; suites `core/autonomy`, `server/autonomy`, `features/cockpit`, `server/control`, `server/usecases` : 631/632 PASS — le seul échec (`e2e-success.test.ts`, hook 10 s) est préexistant et marginal : 9,9 s sur le commit précédent, 9,2–9,9 s sur cette branche, selon la charge de l'hôte.
