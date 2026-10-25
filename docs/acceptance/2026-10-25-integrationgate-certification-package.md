# Dossier de certification — IntegrationGate, candidat `integration/brain-activation-20261025`

**SHA exact certifié : `35bd820`.** Dernier commit affectant le code : `b12fc81` (tout le reste,
`138e49a`→`35bd820`, est documentaire). Ce dossier ne décide rien ; il rassemble, dans le format
que l'ADR 0044 exige réellement, ce qu'il faut pour que le propriétaire décide.

## 1. Pourquoi l'ADR 0044 ne s'applique pas littéralement ici — et ce qui s'applique à la place

Lu directement dans `docs/decisions/0044-integration-gate-runs-only-after-an-independent-review.md` :
le mécanisme qu'il décrit est `WorkspaceExecutionCoordinator.executeInWorkspace` →
`resolveReview` (revue déjà persistée) → `gatePendingReview()`. C'est un gate **mécanique**,
déclenché par CORE3 sur un **workspace de tâche dispatchée par le superviseur**, jamais sur une
branche écrite par un humain ou par Claude. Il n'y a ici ni tâche CORE3, ni workspace, ni
`resolveReview` à interroger — ce dossier ne peut donc pas obtenir de décision `INTEGRATED` de
ce mécanisme, quel que soit le nombre de revues produites.

**Précédent déjà établi dans ce dépôt pour ce cas exact** (lane cockpit-live, D0→D4,
`docs/reports/cockpit-live-claude-d4-gate-preparation-2026-10-20.md`) : branche
`integration/<lane>-<date>` dédiée + revues indépendantes tracées et committées avec leur SHA +
**un acte propriétaire explicite** pour finaliser, en l'absence du reviewer canonique
`OmniRouteReviewer`. C'est le même schéma que celui suivi ici. **Cette équivalence pratique a
elle-même un point resté ouvert dans son propre précédent (D-8, voir §4)** — ce dossier ne
l'invente pas, il l'hérite et le signale.

## 2. Preuves — contrôles réellement exécutés (aucun n'est supposé)

| Contrôle | Résultat | Où |
|---|---|---|
| `pnpm install` à neuf (nouveau worktree) | propre | checkout `integration-brain-activation-20261025` |
| `pnpm typecheck` | exit 0 | — |
| `pnpm lint` | 0 erreur (293 avertissements = fond de dépôt préexistant) | — |
| `pnpm vitest run` (suite unitaire) | 351 fichiers / 5093 tests PASS | — |
| `pnpm vitest run --config vitest.integration.config.ts src/server/workforce/` (PostgreSQL, Testcontainers) | 3 fichiers / 16 tests PASS | — |
| `workforce-activation.test.ts` (routes HTTP) | 32/32 PASS | — |
| Revue indépendante n°1 (`08ce1a3`+`bfc02a2`) | 9/10 PASS, 1 FAIL corrigé (`c9aefe5`) | agent `abb3b34bc4851d687` |
| Revue indépendante n°2 (`f11ebd8..2620496`) | 6/6 PASS, 1 finding corrigé (`b12fc81`) | agent `a672b5c670fbc1c3b` |
| Revue indépendante n°3 (`b12fc81`) | 4/4 PASS | agent `a74cf289cb27bc3c7` |
| Couverture de revue sur les commits de code de Worker B | **13/13, zéro trou** | — |
| Scan de secrets (577 commits de base, `git log -p` intégral) | aucun secret réel trouvé | handoff 2026-10-24 |
| ADR ajoutées/supprimées sur les 577 commits | 54 ajoutées, 0 supprimée/renommée | `git diff --diff-filter=A/DR` |
| Dépendances ajoutées sur les 577 commits | Temporal SDK officiel + libs connues, aucune source git/tarball | `package.json`/`pnpm-lock.yaml` |

## 3. Vérification des dépendances réelles avec CORE3, Temporal et cockpit-live

Pas seulement une préservation de fichiers — un contrôle direct du **couplage** :

- **Aucun fichier de ce dossier** (`src/app/api/admin/workforce/*`,
  `src/server/workforce/brain-role-view.ts`) **n'importe ni n'appelle** Temporal, la télémétrie
  cockpit-live, ou la façade OmniRoute (`grep` ciblé sur le diff complet `candidate-base..HEAD`,
  aucune correspondance). **Les routes d'activation sont totalement découplées de la lane
  cockpit-live et de sa question D-8 ouverte** — un blocage sur cockpit-live ne bloquerait pas
  ce candidat, et réciproquement.
- `src/server/workforce/mission-binding.ts`, `src/core/chief/delegation.ts`,
  `src/core/identity/tenant.ts`, `src/server/execution/temporal/activities.ts`,
  `src/server/workspace-manager/workspace-execution-coordinator.ts` : **octet-identiques** entre
  le hub (`feat/fable-5-1-convergence`) et `HEAD`, à travers les 19 commits de la lane
  cockpit-live ET les 13 commits de Worker B (`git diff --stat` vide sur les cinq). ADR 0070 et
  le mécanisme IntegrationGate lui-même restent exactement ceux du hub.

## 4. Les deux réserves MEDIUM — maintenues, non converties en PASS

1. **Opérateur unique (certifieur = administrateur)** : légitime par construction
   (`SELF_CERTIFICATION` ne compare qu'au créateur système original `workforce-bootstrap`,
   jamais à un second humain) — pas un défaut de code. Mesure compensatoire : traçabilité
   complète et immuable dans `workforce_events`. **Décision requise** : accepter tel quel, ou
   exiger un second principal humain avant toute activation réelle.
2. **`testsPassed`/`evidenceRef` : attestation humaine, non vérifiable par construction** — aucun
   identifiant de `requiredRoleTests()` pour les 9 `BRAIN_ROLES` ne correspond à un test exécuté
   automatiquement et vérifié au moment de la certification. Mesure compensatoire : procédure
   documentée dans le RUNBOOK, rien de plus. **Décision requise** : accepter l'attestation
   humaine comme suffisante, ou exiger une preuve vérifiable (CI, run signé) avant certification
   réelle.

## 5. Dérogations / exceptions — aucune

**Aucune dérogation (« waiver ») n'a été demandée ni approuvée par le propriétaire** pour quoi
que ce soit dans ce dossier. Si une exception doit couvrir un des points du §4 ou le point D-8
hérité de cockpit-live (§1), c'est au propriétaire de la formuler et de la signer — ce document
ne peut que lister ce qui en aurait besoin, pas en fabriquer une.

## 6. Décisions encore dues au propriétaire, dans l'ordre

1. Acte propriétaire de finalisation (équivalent cockpit-live) sur ce candidat précis, OU
   demande de changement avant de le considérer prêt.
2. Autorisation (ou non) de publication des 577 commits de base — distincte de (1).
3. Tranchage des deux réserves MEDIUM (§4).
4. Tranchage du point D-8 hérité de cockpit-live (§1) — sans incidence sur ce candidat grâce au
   découplage confirmé en §3, mais toujours ouvert pour sa propre lane.
5. Décision sur la coordination North Star/FABLE, restée sans réponse.

**Tant que (1) n'a pas eu lieu : aucun push GitHub public, aucune fusion centrale, aucune
migration, aucun déploiement en production.**
