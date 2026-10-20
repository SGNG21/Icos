# Revue du correctif des tests intermittents du hub — `8b46126` (2026-10-20)

- **Reviewer :** sous-agent `qa-breaker` (contexte vierge, Claude Sonnet), **lancé par l'auteur du correctif** : revue contextuelle sans indépendance organisationnelle ; seul le propriétaire ou un reviewer hors de la chaîne de l'auteur donne une validation réellement indépendante (ADR 0044).
- **Périmètre :** diff `b4d0968..8b46126` (deux fichiers de tests), exécution des deux fichiers seulement (lab PostgreSQL), eslint sur les deux fichiers. Aucune modification, aucun changement d'état Git.
- **Verdict : APPROVE** — aucun P0/P1/P2.

## Vérifié

- Unitaire : déterministe (`vi.useFakeTimers` couvre le `new Date()` unique de `createImprovementCandidate`), horloge restaurée en `finally`, aucune assertion perdue, deux ajoutées ; `toEqual` désormais plus strict (plus de masquage). 63/63.
- Intégration : `claim`/`renewClaim`/`saveOwned` comparent `leaseUntil` à l'horloge du processus (pas celle de la base, malgré l'ancien titre) ; bail de 5 s inexpirable dans le test (marge ≈ 100×) ; bail de 1 ms + 30 ms certainement expiré ; « C refusé tant que B est vivant » correspond au prédicat de `claim` (owner null, bail null, bail expiré ou même jeton). Table de correspondance : les neuf assertions de l'ancien scénario sont toutes présentes dans les trois nouveaux, plus trois ajoutées (détenteur unique, renouvellement du détenteur vivant, fencing après reprise). 9/9.
- Isolation : `beforeEach` tronque et réinsère ; handles A/B/C fermés en `afterAll` ; le `createRuntime` du nouveau bloc est dans un `describe` distinct de l'assistant homonyme de la l. 665 (typecheck PASS).
- Style : conventions locales respectées ; 0 erreur eslint, 5 avertissements préexistants hors du diff.

## P3 (non bloquants)

- La preuve de l'instabilité d'intégration repose sur l'analyse (jamais reproduite en isolation, 0/4 avant et après) ; une exécution d'intégration sous charge injectée fermerait le point. La preuve définitive sera le rejeu complet de la gate sur le nouveau candidat.
- Le troisième scénario dépend de deux attentes réelles de 30 ms (déterministes, non instantanées) ; une horloge injectée exigerait une modification du dépôt, hors périmètre.
