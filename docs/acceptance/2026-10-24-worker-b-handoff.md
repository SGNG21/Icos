# Worker B — handoff, 2026-10-24 (mise à jour n°3 : corrections Codex, dépôt public, pas de push)

Statut factuel au moment de ce handoff. Ne remplace ni ne modifie le dossier Phase 1
(`2026-10-23-brain-role-certification-dossier.md`) ni le runbook
(`docs/icos/BRAIN_ACTIVATION_RUNBOOK.md`) : ce document pointe vers eux et fixe l'état pour
qu'une session future (ou le propriétaire) reprenne sans refaire ce qui est déjà fait.

## Position

- Branche `worktree-brain-activation-governance`, **HEAD `2620496`**.
- Descendant fast-forward trivial de `c350399` (tip actuel de `feat/omniroute-backend-20261021`
  — vérifié `git merge-base`, zéro commit divergent, zéro réécriture d'historique).
- 19 fichiers touchés depuis `c350399`, 0 suppression. Zéro modification de
  `mission-binding.ts`/`chief-delegation.ts`/tout fichier CORE3 (ADR 0070 intact).
- **Rien n'a été poussé sur `origin`.** Décision explicite du propriétaire (2026-10-24) : pas
  de push tant que la base `feat/omniroute-backend-20261021` (596 commits jamais audités par
  moi avant aujourd'hui, jamais poussés non plus) n'est pas elle-même auditée et autorisée
  séparément. Voir §Dépôt public ci-dessous.

## Trois corrections appliquées (feedback relayé sous le nom « Codex »)

Aucun artefact Codex trouvé dans le dépôt (le terme désigne par ailleurs l'exécuteur
`icos-codex-worker.mjs` présent dans de nombreux worktrees — pas un rapport dédié à cette
branche). J'ai donc identifié moi-même, par relecture ciblée, l'instance concrète de chacun
des trois problèmes nommés, et corrigé chacune avec son propre test de régression (commit
`2620496`) :

1. **Certification sans preuve d'exécution** → `evidenceRef` passait `.min(1)` (une lettre
   suffisait). Relevé à `.min(16)`. Ne prétend toujours pas vérifier qu'un test a tourné
   (impossible par construction, voir dossier Phase 1) — ferme seulement le cas trivial.
2. **Exposition d'erreurs brutes** → `roles/[roleId]/certify` et `.../activate` renvoyaient
   `error.message` tel quel pour `WorkforceNotFoundError`. Remplacé par un message + des
   `details:{roleId,version}` construits explicitement par la route.
3. **Conflit mal traité** → `bootstrap-data/seed` était la seule des 4 routes d'écriture sans
   catch `WorkforceConflictError` (tombait sur un 500 générique au lieu d'un 503 +
   `Retry-After`). Ajouté, pour la cohérence — chemin actuellement inatteignable en pratique
   (`seedBootstrap` ne fait que des insertions conditionnelles, verrou advisory par tenant côté
   Postgres) mais fragile sans ce traitement si l'implémentation change un jour.

## Preuves (reproduites contre ce HEAD exact)

| Contrôle                                                                                                   | Résultat                                                       |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `pnpm lint`                                                                                                | 0 erreur, 0 avertissement sur les fichiers de cette mission    |
| `pnpm typecheck`                                                                                           | propre                                                         |
| `pnpm vitest run` (suite unitaire)                                                                         | 351 fichiers / **5091** tests PASS, 1/4 skip                   |
| `pnpm vitest run --config vitest.integration.config.ts src/server/workforce/` (PostgreSQL, Testcontainers) | **3 fichiers / 16 tests PASS**                                 |
| `pnpm vitest run src/app/api/admin/workforce/workforce-activation.test.ts`                                 | **30/30 PASS** (dont les 4 nouveaux tests de régression Codex) |

**Piège noté pour la suite** : `pnpm test:integration -- <chemin>` ne filtre PAS — il relance
les 110 fichiers d'intégration au complet. Utiliser `pnpm vitest run --config
vitest.integration.config.ts <chemin>` directement pour un sous-ensemble.

## Dix échecs préexistants, sans rapport avec cette branche

En relançant la suite complète (110 fichiers, par le piège ci-dessus), 10 tests échouent dans
`postgres-control-store.integration.test.ts` (8) et
`disposable-gate-database.integration.test.ts` (2) — aucun des deux fichiers n'est touché par
cette branche. Les deux échouaient déjà, à l'identique, avant l'existence du code de cette
mission, sous forte charge concurrente du VPS. **À investiguer séparément, non bloquant.**

## Revue de sécurité indépendante n°1 — verdict récupéré (couvre `08ce1a3`+`bfc02a2`)

Agent `abb3b34bc4851d687` (sans nom, invisible dans `ListAgents`). Rapport livré à
**11:54:44** local ; arrivé en conversation mais relayé en retard — corrigé une fois son
statut vérifié explicitement (transcript immobile, pas une supposition sur le silence).

**Verdict : « sûr pour soumission à IntegrationGate »**, 9/10 PASS, 1 FAIL (Q10, couverture
HTTP — corrigé commit `c9aefe5`, avant les 3 fixes Codex ci-dessus). Findings résiduels non
bloquants : 2× MEDIUM = décisions propriétaire déjà documentées (opérateur unique légitime ;
`testsPassed` déclaratif non vérifiable) ; 1× LOW = architecture préexistante non exploitée ;
1× INFO = aucune fuite de secret.

## Revue de sécurité indépendante n°2 — en cours (couvre les 3 fixes Codex, `2620496`)

Lancée après les 3 corrections ci-dessus, bornée à leur diff exact
(`administration-schemas.ts`, `certify/route.ts`, `activate/route.ts`,
`bootstrap-data/seed/route.ts`, `workforce-activation.test.ts`) plutôt qu'une relecture
complète (rien d'autre n'a changé depuis la revue n°1). **Verdict non disponible à l'heure de
cette mise à jour — ne pas relancer en double, attendre sa notification.**

## Dépôt public — audit effectué, PAS de push

Le propriétaire a confirmé que `SGNG21/Icos` est **PUBLIC**. Avant tout push éventuel, j'ai :

- Confirmé via `git fetch --prune` + `git branch -vv` qu'aucune des deux branches
  (`worktree-brain-activation-governance`, `feat/omniroute-backend-20261021`) n'est sur
  `origin` ; `main` l'est.
- Chiffré l'écart exact : pousser les deux branches publierait **603 commits** (596 de la base
  que je n'ai pas écrits + 7 miens à l'époque, maintenant 9).
- Scanné l'intégralité de l'historique des 596 commits de base (`git log -p`, ~420k lignes,
  pas seulement le diff net) contre des motifs de secrets (clés AWS, blocs clé privée, URLs
  Postgres/Mongo avec identifiants, Bearer/JWT, tokens Slack/GitHub/Stripe,
  `DATABASE_URL`/`BETTER_AUTH_SECRET` avec valeur) et vérifié qu'aucun fichier
  `.env`/`.pem`/`.key`/`id_rsa` n'a jamais été ajouté. **Chaque correspondance trouvée s'est
  révélée être une fixture de test de la fonctionnalité de rédaction de secrets d'ICOS
  elle-même** (`MemorySecretRejectedError`, `memory-core.test.ts`) ou une chaîne de connexion
  locale sans mot de passe réel. Scan par motifs, pas un outil dédié (`gitleaks`/`trufflehog`
  absents de cet environnement) — solide mais pas une garantie absolue.
- Confirmé la divergence propre depuis `origin/main` (pas de réécriture d'historique en jeu).
- Le propriétaire avait initialement autorisé le push des deux branches, **puis s'est
  rétracté explicitement** : aucun push tant que la base de 596 commits n'est pas auditée et
  autorisée séparément de ce qui précède. **Rien n'a été poussé.**

## Coordination demandée (FABLE 5.1, responsable IntegrationGate)

FABLE 5.1 (tmux `icos-fable`) était un pair actif plus tôt dans cette session mais a disparu
de `ListAgents` — session terminée, injoignable au moment de cette mise à jour. Aucune session
n'est identifiable comme « responsable IntegrationGate » par son nom. J'ai envoyé la question
(quelle branche cible d'intégration est correcte) à `repo-ad` (North Star, le pair le plus
proche thématiquement de CORE3/IntegrationGate) — **réponse non reçue à l'heure de cette mise à
jour**. Si une session future reprend ce travail : la question reste ouverte, ne pas supposer
que `feat/omniroute-backend-20261021` est la cible définitive sans confirmation.

## Prochaine Gate

1. Revue indépendante n°2 (sur les 3 fixes Codex) — **en attente**.
2. Réponse de coordination sur la branche d'intégration correcte — **en attente**.
3. Audit/autorisation séparée de la base `feat/omniroute-backend-20261021` elle-même (596
   commits) avant tout push — **en attente d'une décision propriétaire distincte**.
4. Aucun push, aucune PR ouverte, aucune fusion, aucune migration, aucune action de
   production tant que (1)-(3) ne sont pas résolus.
