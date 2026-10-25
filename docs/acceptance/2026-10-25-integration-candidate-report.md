# Candidat d'intégration — `integration/brain-activation-20261025`

**Préparé le 2026-10-25, sur autorisation explicite du propriétaire** (désignation de
`feat/omniroute-backend-20261021` comme base CANDIDATE, pas encore hub canonique déclaré).
Travail strictement local : aucun push GitHub, aucune fusion centrale, aucun déploiement.

## 1. Lignée Git — chaque segment caractérisé, aucun non identifié

```
origin/main (ca138e2)
  │  577 commits — ANTÉRIEURS au hub documenté, jamais écrits ni audités par cette mission
  ▼
feat/fable-5-1-convergence (b4d0968, hub documenté le 2026-10-20 dans
  docs/reports/cockpit-live-claude-d4-gate-preparation-2026-10-20.md)
  │  19 commits — lane cockpit-live D0→D4 (déjà passée par SON PROPRE IntegrationGate :
  │  D3 = 3 revues indépendantes APPROVE, D4 = verdict READY_FOR_GATE documenté) + 4 commits
  │  omniroute-cockpit-facade additifs, aucun fichier CORE3/tenant/Temporal touché
  ▼
feat/omniroute-backend-20261021 (c350399) — BASE CANDIDATE DE CETTE PROPOSITION
  │  13 commits — Worker B (cette branche), couverts par 2 revues indépendantes complètes
  │  + 1 revue bornée sur le dernier commit (voir §4)
  ▼
integration/brain-activation-20261025 (fe3a789) — CE CANDIDAT
```

577 + 19 = 596 — reconcilié exactement avec le chiffre déjà cité dans le handoff Worker B.
**Aucune divergence, aucune réécriture d'historique à aucun niveau** : chaque flèche
ci-dessus est un ancêtre direct du niveau suivant (`git merge-base --is-ancestor`, vérifié un
par un). La fusion de Worker B dans ce candidat a été un **fast-forward pur**
(`c350399..fe3a789`, 0 conflit, confirmé par l'exécution réelle de `git merge --ff-only`).

## 2. Préservation de CORE3, Temporal, ADR, isolation tenant, IntegrationGate

Vérifié sur la base candidate (`feat/omniroute-backend-20261021`) avant fusion :

| Mécanisme                  | Fichier vérifié                                                   | Résultat             |
| -------------------------- | ----------------------------------------------------------------- | -------------------- |
| Liaison CORE3 (ADR 0070)   | `src/server/workforce/mission-binding.ts`                         | présent, intact      |
| Délégation Chief           | `src/core/chief/delegation.ts`                                    | présent, intact      |
| Isolation tenant           | `src/core/identity/tenant.ts` (`CURRENT_SINGLE_TENANT_ID`)        | présent, intact      |
| IntegrationGate (ADR 0044) | `src/server/workspace-manager/workspace-execution-coordinator.ts` | présent, intact      |
| Exécution Temporal         | `src/server/execution/temporal/activities.ts`                     | présent, intact      |
| ADR (décisions)            | `docs/decisions/`                                                 | 62 fichiers présents |

Après fusion de Worker B : `git diff feat/omniroute-backend-20261021..HEAD --name-only` ne
touche **aucun** de ces fichiers, ni aucun fichier sous `docs/decisions/`. 13 fichiers
ajoutés, 0 supprimé, 0 modifié hors du périmètre des 5 routes HTTP d'activation.

## 3. Tests — rejoués intégralement sur CE checkout, pas seulement rapportés

Nouveau worktree, dépendances installées à neuf (`pnpm install --frozen-lockfile`) :

| Contrôle                                                                                   | Résultat                                                                                  |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                                           | propre                                                                                    |
| `pnpm lint`                                                                                | 0 erreur, 293 avertissements (fond de dépôt préexistant, identique au worktree d'origine) |
| `pnpm vitest run` (suite unitaire complète)                                                | 351 fichiers / **5093** tests PASS, 1/4 skip                                              |
| `pnpm vitest run --config vitest.integration.config.ts src/server/workforce/` (PostgreSQL) | **3 fichiers / 16 tests PASS**                                                            |

Résultats identiques à ceux obtenus dans le worktree d'origine — confirme que la fusion
elle-même n'a rien changé.

## 4. Revues indépendantes — couverture complète du candidat

| Revue | Portée                                                                                                      | Verdict                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| n°1   | `08ce1a3`+`bfc02a2`                                                                                         | « sûr pour IntegrationGate », 9/10 PASS                                    |
| n°2   | diff `f11ebd8..2620496` (3 corrections)                                                                     | « sûr pour proposition d'intégration », 6/6 PASS, 1 finding informationnel |
| n°3   | commit `b12fc81` (le seul resté non revu — correction du finding de la revue n°2, écrite après son verdict) | **en cours**, bornée à ce seul commit                                      |

À l'issue de la revue n°3, l'intégralité des 13 commits de Worker B aura été couverte par au
moins une revue indépendante, sans trou.

## 5. Risques de publication (596 commits de la base, reconciliés avec §1)

- **577 commits** (`origin/main..feat/fable-5-1-convergence`) : antérieurs au hub documenté,
  jamais écrits ni audités par cette mission. **Décision propriétaire séparée toujours
  requise** avant toute publication — inchangé depuis le handoff Worker B du 2026-10-24, qui
  contient le scan de secrets complet (aucun trouvé, motifs uniquement, pas un outil dédié).
- **19 commits** (hub → base candidate) : déjà passés par un IntegrationGate documenté et
  réussi (D3 : 3 revues indépendantes APPROVE ; D4 : verdict READY_FOR_GATE). Risque résiduel
  faible, déjà gouverné par ce processus antérieur, pas par cette mission.
- **13 commits** (Worker B) : couverts par 2-3 revues indépendantes ci-dessus, risque
  documenté et réserves MEDIUM explicitement non résolues par du code (attestation humaine,
  opérateur unique) — décisions de gouvernance pour le propriétaire, pas des failles.

**Aucun conflit** à aucun niveau de cette lignée — la fusion a été un fast-forward pur à
chaque étape vérifiée.

## 6. Ce que ce candidat n'est PAS

- Pas une publication : rien n'a été poussé sur `origin`.
- Pas une fusion centrale : `integration/brain-activation-20261025` est une branche locale
  isolée, créée dans son propre worktree.
- Pas une déclaration que `feat/omniroute-backend-20261021` est le hub canonique — seulement
  que, TEL QUE DÉSIGNÉ CANDIDAT par le propriétaire, il est compatible, cohérent et
  vérifiable.
- Pas une action de production.

## 7. Prochaine action

Attendre le verdict de la revue n°3 (bornée, en cours). Puis : décision propriétaire sur (a)
la publication des 577 commits antérieurs et (b) la déclaration formelle de
`feat/omniroute-backend-20261021` (ou d'une autre branche) comme hub canonique — ou directive
d'utiliser ce candidat tel quel sans cette déclaration formelle.
