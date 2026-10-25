# Dossier décisionnel — Worker B / activation gouvernée des 12 cerveaux

**Candidat exact : `integration/brain-activation-20261025`, HEAD `9ef9ff2`.** Dernier commit de
code : `b12fc81` ; tout le reste (`138e49a`→`9ef9ff2`) est documentaire.
**Décision déjà actée par le propriétaire (2026-10-25)** : candidat accepté comme
techniquement prêt à être soumis au processus d'intégration — **ni INTEGRATED, ni autorisé en
production.**

## 1. Preuves (vérifiées, pas supposées)

| Contrôle | Résultat |
|---|---|
| Revue indépendante n°1 (`08ce1a3`+`bfc02a2`) | 9/10 PASS, 1 FAIL corrigé (`c9aefe5`) |
| Revue indépendante n°2 (`f11ebd8..2620496`) | 6/6 PASS, 1 finding corrigé (`b12fc81`) |
| Revue indépendante n°3 (`b12fc81`) | 4/4 PASS |
| Couverture de revue sur le code de Worker B | 13/13 commits, zéro trou |
| `pnpm typecheck` / `pnpm lint` | propre / 0 erreur |
| Suite unitaire | 351 fichiers / 5093 tests PASS |
| PostgreSQL (`src/server/workforce/`) | 16/16 PASS |
| Routes HTTP (`workforce-activation.test.ts`) | 32/32 PASS |
| Dépendances (577 commits de base) | Temporal SDK officiel + libs connues, aucune source git/tarball |
| Secrets (577 commits, historique complet) | aucun secret réel trouvé |
| Couplage CORE3/Temporal/cockpit-live | fichiers octet-identiques depuis le hub ; aucune route Worker B n'importe Temporal/télémétrie/OmniRoute — découplage confirmé |

Détail complet : `2026-10-25-integration-candidate-report.md`,
`2026-10-25-worker-b-finalization-and-gate-readiness.md`,
`2026-10-25-integrationgate-certification-package.md`.

## 2. Les deux réserves — maintenues selon les conditions du propriétaire

- **Opérateur unique** : acceptable **uniquement** avec reviewer indépendant et traçabilité des
  validations sensibles. Ces deux conditions sont déjà remplies ici (3 revues indépendantes
  distinctes de l'auteur ; `workforce_events`, append-only, trace chaque certification/
  activation avec son principal réel) — **mais la réserve reste ouverte en tant que décision de
  gouvernance**, ces mesures sont compensatoires, pas une levée de la réserve.
- **`testsPassed`/`evidenceRef`** : **non levée**. Aucun identifiant de `requiredRoleTests()`
  pour les 9 `BRAIN_ROLES` ne correspond à un test vérifié automatiquement au moment de la
  certification. Toute activation réelle doit disposer d'une preuve vérifiable (CI, run signé)
  et d'une validation indépendante avant d'être traitée comme suffisante — non garanti par le
  code actuel, seulement par la procédure humaine documentée dans le RUNBOOK.

## 3. Mécanisme canonique d'intégration — identifié, pas de second orchestrateur

Recherché dans `.icos/policies/` et `CONTRIBUTING.md` (étapes 1-5 obligatoires avant travail
significatif). **Le mécanisme existe déjà, pas de lacune de gouvernance à combler** :

1. **`CONTRIBUTING.md`** : flux PR — branche ciblée, tests adaptés, `pnpm check`/`pnpm build`,
   PR décrivant le besoin, les risques, les contrôles exécutés et les migrations éventuelles.
   C'est le mécanisme d'intégration **manuelle/assistée** applicable ici (par opposition à
   l'ADR 0044, qui gouverne uniquement le gate automatique interne de CORE3 sur des workspaces
   dispatchés par le superviseur — jamais une branche humaine/Claude, confirmé en lisant son
   texte).
2. **`.icos/policies/decision-authority.yaml` (GOV-AUTH-001)** : une fusion vers une branche
   partagée menant vers la production est **irréversible/affecte un état partagé** → relève du
   palier **APPROVAL**, c'est-à-dire d'un acte propriétaire explicite, pas d'une action AUTO ou
   REPORT. C'est la base formelle de l'« acte propriétaire » déjà identifié par précédent
   (cockpit-live) — ici confirmé par une politique écrite, pas seulement un usage.
3. **`.icos/policies/release-policy.yaml` (REL-001)** : gouverne l'étape séparée et ultérieure
   du déploiement en production (tests, gate sécurité, plan de rollback, observabilité, revue de
   migration, dossier de preuves) — non déclenchée par ce dossier, pertinente seulement après
   une éventuelle fusion.

**Rien à proposer en plus** : ce candidat suit déjà ce flux (branche dédiée, tests, revues
indépendantes au-delà du minimum requis par `CONTRIBUTING.md`, documentation des risques). Ce
qui manque pour le finaliser n'est pas un nouveau mécanisme, c'est l'acte palier APPROVAL
lui-même (point 5 ci-dessous) — jamais fabriqué ici.

## 4. Coordination — dernière tentative effectuée

- **North Star (`repo-ad`)** : message final envoyé à l'instant (statut du candidat, question
  ouverte sur le mécanisme applicable et sur D-8 cockpit-live, indication explicite qu'aucune
  autre relance ne suivra). Pas de session dupliquée créée. **Aucune réponse aux 4 messages
  envoyés au total (dont celui-ci) à ce jour.**
- **FABLE 5.1** : **aucune session `fable` trouvée** dans la liste des pairs actifs
  (`repo-ad`, `repo-21`/cockpit-visual-audit, `cockpit-live-claude-34`) — confirmé injoignable,
  pas de nouvelle session créée.
- Consigné dans le handoff durable (`brain-activation-governance-handoff.md`).

## 5. Opérations nécessitant encore l'accord explicite du propriétaire

1. **Acte palier APPROVAL (GOV-AUTH-001)** pour fusionner ce candidat dans une branche cible —
   aucun push, aucune PR ouverte sur GitHub à ce jour (dépôt public).
2. Publication des 577 commits de base sur GitHub public — distincte de (1).
3. Tranchage définitif des deux réserves (§2) — actuellement ouvertes avec mesures
   compensatoires, pas résolues par du code.
4. Point D-8 hérité de cockpit-live (revues d'agents vs. reviewer officiel) — sans incidence sur
   ce candidat (découplage confirmé), mais toujours ouvert pour sa propre lane.
5. Toute activation réelle des 12 cerveaux, toute migration, tout déploiement en production
   (`release-policy.yaml`, étape distincte et postérieure).

**Aucune de ces opérations n'a eu lieu. Aucun audit redondant n'a été relancé dans ce
document — il consolide les résultats déjà établis dans les handoffs existants.**
