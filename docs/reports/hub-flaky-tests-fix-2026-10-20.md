# Correctif des deux tests intermittents du hub (2026-10-20)

- **Mission :** « Priorité : débloquer la certification COCKPIT-LIVE » (propriétaire, 2026-10-20). Lane dédiée `fix/hub-flaky-tests-20261020`, worktree `/home/icos/icos-worktrees/hub-flaky-tests-fix`, base hub `b4d0968`. Aucun worktree Hermes, FABLE, Cockpit Live ni autre touché ; aucun merge partagé, push ni déploiement.
- **Commit du correctif :** `8b461264460c5434e13cce3f5e60324a04c19ec6` — deux fichiers de **tests** seulement (+97/−83), aucun code de production modifié.
- **Preuves :** `docs/reports/evidence/hub-flaky-tests-fix-repro-2026-10-20.txt` ; revue indépendante : `docs/reports/reviews/hub-flaky-tests-fix-review-2026-10-20.md`.

## 1. Propriété des fichiers

| Fichier                                                                                      | Historique                                                                                           | Lane active                                                         | Conclusion                                                                       |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/core/autonomy/improvement-backlog.test.ts`                                              | `7bb2c38` → `f39c652` → `5bb5a2b` (2026-09-22/27, propriétaire + Claude Opus 5), lignée `main` → hub | aucune branche ne l'a touché depuis le 2026-10-01 (`git log --all`) | hub (CORE3 / autonomie) ; correctif autorisé par la mission dans une lane dédiée |
| `src/server/repositories/postgres/autonomous-mission-runtime-repository.integration.test.ts` | `8c41a37` → `973f1fa` (2026-09-19, propriétaire + Claude Sonnet 5)                                   | idem                                                                | idem                                                                             |

Le code testé (`improvement-backlog.ts`, `autonomous-mission-runtime-repository.ts`) n'est **pas** modifié : le défaut est dans les tests, pas dans les garanties.

## 2. Correctif 1 — `improvement-backlog.test.ts` › « should return defensive copy »

- **Cause racine :** `createImprovementCandidate` horodate `createdAt`, `updatedAt` **et `proposedAt`** avec `new Date()` à chaque appel (l. 348). Un correctif antérieur masquait seulement les deux premiers ; deux appels de part et d'autre d'une milliseconde font échouer `toEqual` sur `proposedAt`.
- **Correctif :** horloge contrôlée `vi.useFakeTimers({ now: "2026-09-27T12:00:00.000Z" })` autour des deux créations, `vi.useRealTimers()` en `finally`. Les trois horodatages sont **assertés explicitement**, puis l'égalité **complète** des deux candidats (plus aucun masquage), l'identité dérivée du contenu, la distinction des objets et l'indépendance de mutation.
- **Assertions métier :** toutes conservées et renforcées (l'égalité porte désormais aussi sur les horodatages).

## 3. Correctif 2 — test de renouvellement de bail

- **Cause racine :** scénario unique avec `leaseMs = 100`, attente 50 ms puis `get` + `renewClaim` ; `renewClaim` ne renouvelle que si `leaseUntil > now` (horloge du processus). Sous charge, le bail est expiré : le refus est **correct**, l'assertion « renouvelle avant expiration » était trop serrée.
- **Correctif :** trois scénarios séparés avec marges explicites — bail **vivant** de 5 000 ms (ne peut pas expirer pendant le test) et bail **expirant** de 1 ms suivi d'une attente de 30 ms (certainement expiré) :
  1. renouvellement avant expiration par le détenteur, `leaseUntil` repoussé (0 < extension < bail), refus d'un jeton étranger, détenteur inchangé ;
  2. refus après expiration, **un seul** nouveau détenteur (C refusé tant que B est vivant), fencing de l'ancien détenteur après reprise, renouvellement par le détenteur vivant ;
  3. reprise après expiration du nouveau détenteur, `saveOwned` périmé de l'ancien détenteur rejeté (`AUTONOMOUS_RUNTIME_OWNERSHIP_LOST`).
- **Garanties conservées :** bail, fencing, expiration, détenteur unique (pas de double exécution), rejet d'une écriture périmée. Aucune assertion de l'ancien scénario supprimée ; une assertion ajoutée (C refusé pendant le bail vivant de B).

## 4. Vérifications

| Vérification                                                                              | Résultat                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Reproduction avant correctif (fichiers non modifiés, 6 instances vitest concurrentes × 5) | unitaire **3 échecs / 30** ; intégration 0/4 (jamais reproduit en isolation ; 1/837 dans la suite complète à charge ≈ 6) |
| Après correctif, même protocole                                                           | unitaire **0 / 30** ; intégration **0 / 4**                                                                              |
| Exécutions simples après correctif                                                        | unitaire 63/63 ×3 ; intégration 9/9 ×3 (7 → 9 tests)                                                                     |
| `pnpm run typecheck`                                                                      | PASS                                                                                                                     |
| `eslint` sur les deux fichiers                                                            | 0 erreur ; 5 avertissements **préexistants** hors du diff                                                                |
| prettier                                                                                  | fichiers non conformes avant comme après (le lint de la gate n'exécute pas prettier) ; conventions du fichier respectées |
| Suites complètes                                                                          | **non relancées ici** : elles le seront par la gate du nouveau candidat Cockpit Live rebâti sur ce hub corrigé           |

Limite : l'instabilité d'intégration n'a pas été reproduite hors de la suite complète ; le correctif agrandit la marge temporelle d'un facteur 50 (bail 5 s contre 100 ms) et rend l'expiration certaine (1 ms + 30 ms) — la preuve définitive sera le rejeu complet de la gate.

## 5. Revue indépendante

Sous-agent `qa-breaker` (Sonnet, contexte vierge, **lancé par l'auteur** : pas d'indépendance organisationnelle, sans autorité ADR 0044) : **APPROVE**, aucun P0/P1/P2 ; table de correspondance des assertions ancien → nouveau complète, trois assertions ajoutées, aucune perdue ; deux P3 (preuve d'intégration fondée sur l'analyse, attentes réelles de 30 ms). Détail : `docs/reports/reviews/hub-flaky-tests-fix-review-2026-10-20.md`. Une validation réellement indépendante reste à donner par le propriétaire ou un reviewer hors de ma chaîne.

## 6. Suite

Le hub corrigé est `fix/hub-flaky-tests-20261020` @ `8b46126` (= `b4d0968` + ce commit), **non fusionné** dans `feat/fable-5-1-convergence` (branche partagée : fusion sur autorisation et gate). Prochaine étape, sur demande du propriétaire : rebâtir le candidat Cockpit Live sur ce hub (`integration/cockpit-live-20261020` rebasée sur `8b46126`, nouveau SHA, empreinte du code cockpit-live inchangée) et rejouer la certification complète en conservant les échecs initiaux du 2026-10-20 08:39 UTC.
