# Worker B — finalisation, revue n°3, audit des 577 commits, état de Gate

Complète `2026-10-25-integration-candidate-report.md` (ne le remplace pas) : ce document ferme
les points laissés « en cours » par celui-ci et répond point par point à la mission de
finalisation du propriétaire. Rien n'a été poussé, fusionné, migré ni déployé pendant sa
rédaction.

## 1. Revue indépendante n°3 — reçue, verdict complet

Agent `a74cf289cb27bc3c7`, bornée au seul commit `b12fc81` (le dernier non encore revu). Rapport
livré le 2026-10-25 09:10:06 UTC, retrouvé en lisant directement l'événement `SubagentHandback`
dans son transcript (et non deviné) après qu'un hand-back automatique n'a pas été relayé à temps —
même type d'erreur que pour la revue n°1, cette fois rattrapée avant toute affirmation erronée au
propriétaire.

**Verdict : 4/4 PASS.**

- **Q1 (changement `{roleId, version}` sur le chemin dryRun, correct et sans effet de bord) —
  PASS.** `roleId` est typé `string` non optionnel par la signature de route ; `version` ne peut
  être vide une fois `parsed.success` vrai (zod `.min(1)`) ; la signature positionnelle
  `apiError(code, message, details?, headers?)` est confirmée dans `respond.ts` ; les valeurs
  placées dans `details` sont strictement celles déjà dans le texte du message (aucune fuite
  nouvelle) ; branche atteinte uniquement si le rôle est introuvable, aucun autre effet.
- **Q2 (les 2 nouveaux tests testent réellement le changement, pas de faux positif) — PASS.**
  Vérifié explicitement que `details` serait **absent** (pas juste `undefined`) de la réponse
  sans le correctif, donc que `toEqual` échouerait bien sans lui — pas un test qui passerait de
  toute façon.
- **Q3 (reproduction) — PASS.** `pnpm vitest run .../workforce-activation.test.ts` → 32/32 ;
  `pnpm typecheck` → exit 0.
- **Q4 (pas de régression sur le périmètre déjà revu) — PASS, avec une précision.** Le commit
  `b12fc81` lui-même ne touche que 3 fichiers (49/-2). Un diff plus large (`2620496..b12fc81`)
  montre 5 fichiers parce que la chaîne contient aussi `f233627` et `7d64d6f`, tous deux
  **strictement documentaires** (un seul `.md` chacun, vérifié par `git show --stat`) — aucun
  changement de code caché entre les deux bornes déjà revues.

**Conséquence** : les 13 commits de Worker B sont désormais **intégralement couverts** par au
moins une revue indépendante (n°1 : `08ce1a3`+`bfc02a2` ; n°2 : `f11ebd8..2620496` ; n°3 :
`b12fc81`). Aucun trou de couverture restant.

## 2. SHA final du candidat — code vs documentation distingués

- **Dernier commit affectant le code : `b12fc81`** (2026-10-24 15:52:53 +0200) — le fix de
  cohérence dryRun, dernier changement fonctionnel de toute la branche.
- **Commits documentaires seuls, après `b12fc81`, sans effet sur le code exécuté** :
  `138e49a` (verdict revue n°2), `fe3a789` (brief de déblocage North Star), `de7d3b2` (rapport
  candidat du 2026-10-25). Confirmé : `git log --oneline b12fc81..HEAD` ne liste que ces 3
  commits, tous `docs(...)`.
- **HEAD actuel de `integration/brain-activation-20261025` : `de7d3b2`.** Ce document ajoute un
  4ᵉ commit documentaire après lui — toujours aucun changement de code.
- **Lignée reconfirmée** (`git rev-list --count`) : `origin/main..feat/fable-5-1-convergence` =
  **577** ; `feat/fable-5-1-convergence..feat/omniroute-backend-20261021` = **19** ;
  `feat/omniroute-backend-20261021..HEAD` = **14** (13 commits Worker B + le rapport candidat
  `de7d3b2`). 577+19+14 = 610, cohérent avec chaque segment déjà caractérisé séparément.

## 3. Audit fondé sur les risques des 577 commits historiques (pas une re-revue intégrale)

Conformément à l'autorisation du propriétaire (« sans refaire inutilement l'intégralité des
revues historiques »), ce qui suit cible exactement les 6 points demandés, par preuve directe —
pas par supposition.

**(i) Provenance Git et hub de référence.** `git merge-base origin/main
feat/fable-5-1-convergence` = `0a91604...` ; 577 commits, ancêtre direct confirmé, aucune
réécriture d'historique (`git rev-list --count` cohérent avec la figure déjà citée dans le
handoff du 2026-10-24). Hub documenté le 2026-10-20 dans
`docs/reports/cockpit-live-claude-d4-gate-preparation-2026-10-20.md`.

**(ii) Fichiers sensibles (sécurité, secrets, permissions, tenant, migrations, CORE3, Temporal,
OmniRoute, IntegrationGate).** `git diff --stat origin/main..feat/fable-5-1-convergence` filtré
sur ces chemins : **179 fichiers, 37941 insertions, 1978 suppressions**, concentrés presque
entièrement dans `src/server/workspace-manager/*` (le mécanisme même d'IntegrationGate, ADR
0044) — attendu et non anormal : `main` ne contient aucun de ces sous-systèmes, toute cette
surface est par définition nouvelle depuis `main`. Ce n'est pas une anomalie détectée, c'est la
fonctionnalité elle-même. Point de confiance indépendant et non-documentaire : ce code (version
post-ADR-0070 incluse) est **déjà déployé et actif en production depuis 5 jours** sur
`icos-node-01` (`de3bebd`, vérifié ligne à ligne sur disque lors de la mission runtime
précédente) — preuve d'exécution réelle, pas seulement de revue de code.

**(iii) Dépendances peu fiables.** Diff de `package.json`/`pnpm-lock.yaml` sur les 577 commits :
ajouts = `@temporalio/{activity,client,common,worker,workflow}` (SDK officiel Temporal, versions
figées), `lucide-react`, `ws`, `uuid`, `@types/{uuid,ws}`. Toutes des dépendances connues, du
registre npm public standard, versions précises. **Aucune source `git+`, tarball, ou registre non
standard trouvée** dans le diff. Aucun signal de supply-chain.

**(iv) Secrets / données confidentielles dans l'historique.** Déjà fait lors de la mission du
2026-10-24 (scan par motifs sur l'intégralité de `git log -p`, ~420k lignes, pas seulement le
diff net) : **aucun secret réel trouvé** — chaque correspondance retracée à une fixture de test
de la fonction de rédaction de secrets d'ICOS elle-même, ou à une valeur locale sans mot de
passe réel. Aucun fichier `.env`/`.pem`/`.key`/`id_rsa` jamais ajouté. Non refait ici (pas de
changement d'historique depuis) — restaté, pas re-exécuté inutilement.

**(v) Décisions ADR et preuves de certification réutilisables.** `git diff --diff-filter=A
origin/main..feat/fable-5-1-convergence -- docs/decisions/` = **54 nouvelles ADR**, **0
supprimée ou renommée** (`--diff-filter=DR` vide). Discipline de gouvernance cohérente : aucune
décision archivée en silence. Ces 54 ADR incluent celles citées dans ce chantier (0044, 0066,
0068, 0070, 0074, 0083…) — toutes présentes et vérifiées intactes au niveau de la base candidate
dans le rapport du 2026-10-25.

**(vi) Statut EXACT de la lane cockpit-live.** Vérifié directement dans
`docs/reports/cockpit-live-claude-d4-gate-preparation-2026-10-20.md` : le verdict écrit, textuel,
est **« READY_FOR_GATE »** — **jamais** « ACCEPTÉ » ou « ACCEPT ». Aucun document du dépôt,
daté après le 2026-10-20, ne contient de marqueur d'acceptation formelle de Gate pour cette lane
précise (recherche ciblée effectuée, seuls des mentions génériques d'ADR sans rapport trouvées).
Point explicitement laissé **« À décider »** dans ce même rapport (ligne D-8) : le reviewer
officiel `OmniRouteReviewer` était indisponible (`ICOS_REVIEWER_MODEL` absent) ; trois revues
d'agents (Opus puis Sonnet) ont rendu APPROVE à la place, committées avec SHA — mais la question
« ces revues d'agents comptent-elles comme la revue indépendante exigée par l'ADR 0044, ou faut-
il rejouer la revue officielle ? » n'a, à ce jour, **aucune réponse écrite trouvée dans le
dépôt**. **Ce point n'est pas résolu par ce document — il est signalé tel quel, sans l'escamoter
en ACCEPT.**

### Conclusion de l'audit historique

Aucune anomalie de sécurité, de secret, de dépendance ou de gouvernance détectée dans les 577
commits. Le risque résiduel n'est pas technique : c'est une **autorisation de publication
toujours manquante** (propriétaire, séparée, déjà signalée) et, pour les 19 commits de la lane
cockpit-live, une **case de gouvernance ADR 0044 restée ouverte depuis le 2026-10-20** (D-8),
distincte de tout défaut de code.

## 4. Les deux réserves MEDIUM — maintenues explicitement, PAS converties en PASS

- **Opérateur unique (certifieur = administrateur).** Le code autorise légitimement qu'une même
  personne certifie puis active un rôle : `SELF_CERTIFICATION` ne compare l'identité du
  certifieur qu'au créateur ORIGINAL du rôle (`workforce-bootstrap`, une identité système), jamais
  à l'identité d'un second humain. Ce n'est pas un bug — c'est documenté comme tel depuis le
  dossier Phase 1 et confirmé par les deux premières revues. **Reste une décision de gouvernance
  pour le propriétaire** : accepter cette absence de double contrôle humain, ou exiger un second
  principal avant toute activation réelle. Mesure compensatoire déjà en place : traçabilité
  complète dans `workforce_events` (append-only), chaque certification/activation signée par un
  principal réel, jamais fabriqué.
- **`testsPassed` / `evidenceRef` : attestation humaine non vérifiable par construction.** Le
  dossier Phase 1 établit qu'aucun des identifiants de test exigés par `requiredRoleTests()` pour
  les 9 `BRAIN_ROLES` ne correspond à un test exécutable automatiquement vérifié par le code au
  moment de la certification — `evidenceRef` (relevé à `.min(16)` dans ce chantier) ferme
  seulement le cas trivial d'une preuve vide ou d'un caractère, il ne prouve jamais qu'un test a
  réellement tourné. **Reste une décision de gouvernance pour le propriétaire** : accepter
  l'attestation humaine comme suffisante (procédure documentée dans le RUNBOOK), ou exiger un
  lien vers une preuve d'exécution vérifiable automatiquement (CI, run signé) avant de considérer
  ce point clos.

Ces deux points restent **MEDIUM, non résolus par du code**, exactement comme instruit.

## 5. Dossier de certification « IntegrationGate officiel » — préparation, pas une décision

Ce qui existe, prêt à être soumis :
- Candidat gelé : `de7d3b2` (ce document ajoute un commit documentaire supplémentaire, aucun
  changement de code après `b12fc81`).
- 3 revues indépendantes complètes couvrant 100 % des commits de code de Worker B (§1 ci-dessus
  + les deux revues précédentes déjà documentées).
- Preuves de test rejouées sur un checkout neuf (`pnpm install` à neuf) : typecheck propre, lint
  0 erreur, 5093+ tests unitaires, 16/16 PostgreSQL, 32/32 routes HTTP.
- Audit historique des 577 commits de base (§3) : aucune anomalie trouvée, deux points de
  gouvernance ouverts signalés sans être cachés (D-8 cockpit-live ; autorisation propriétaire des
  577 commits pour publication).
- Les deux réserves MEDIUM (§4), maintenues, avec mesures compensatoires documentées.

Ce qui N'existe PAS et n'est pas inventé ici :
- **Aucune exception ni dérogation (« waiver ») n'a été approuvée par le propriétaire** à ce
  jour, pour aucun des points ouverts ci-dessus. S'il faut en formaliser une (p. ex. accepter
  l'opérateur unique comme suffisant), c'est au propriétaire de la rédiger et de la signer — ce
  document ne peut que lister les points qui en auraient besoin.
- **Aucune soumission formelle à un mécanisme d'IntegrationGate automatisé** n'a eu lieu : ADR
  0044 gouverne du code dispatché par CORE3 via `WorkspaceExecutionCoordinator`, pas une branche
  humaine/Claude comme celle-ci. L'équivalent pratique déjà établi pour ce type de travail (lane
  cockpit-live, §3-vi) est : branche `integration/<lane>-<date>` dédiée (fait, c'est cette
  branche) + revues indépendantes tracées (fait, 3/3) + « acte propriétaire » explicite pour
  finaliser — **cet acte n'a pas eu lieu**.

## 6. Ce qui reste — décisions propriétaire, dans l'ordre

1. Autoriser (ou non) la publication des 577 commits de base — distincte de l'autorisation déjà
   donnée pour la préparation locale de ce candidat.
2. Trancher le point D-8 resté ouvert depuis le 2026-10-20 sur la lane cockpit-live (revues
   d'agents acceptées comme revue indépendante ADR 0044, ou rejeu de la revue officielle).
3. Trancher les deux réserves MEDIUM (§4) — accepter tel quel avec mesures compensatoires, ou
   exiger un changement de processus avant toute activation réelle.
4. Décision de coordination : réponse de North Star toujours non reçue ; `repo-ad` sans réponse
   depuis les 3 messages envoyés — à relancer ou à contourner explicitement, au choix du
   propriétaire.
5. Seulement après (1)-(4) : push, PR, fusion — aucun n'a eu lieu, aucun n'est planifié sans
   nouvelle autorisation explicite et spécifique.

Aucune action de production, aucune migration, aucun déploiement dans cette mission ni dans
aucune de ses prédécesseures sur cette branche.
