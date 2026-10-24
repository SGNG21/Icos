# Activation gouvernée des 12 cerveaux — Runbook propriétaire

Préparé par Claude Sonnet 5, 2026-10-24, worktree `brain-activation-governance`
(branche `worktree-brain-activation-governance`, HEAD `ccc1431`, parent direct `c350399` =
tip actuel de `feat/omniroute-backend-20261021`). **Rien n'a été exécuté contre `icos_app` ou
le VPS.** Chaque étape ci-dessous modifie un état durable (certification, activation,
création d'identité) et exige l'autorisation explicite du propriétaire. Référence : ADR 0068
(« ICOS cannot create its own brains »), ADR 0070 (liaison CORE3), ADR 0044 (pas de revue
pré-approuvée).

## 0. État de départ (mesuré, pas supposé)

- Les 5 routes (`/status`, `/bootstrap-data/seed`, `/roles/[roleId]/certify`,
  `/roles/[roleId]/activate`, `/brains/activate`) existent uniquement sur cette branche, pas
  encore mergées dans `feat/omniroute-backend-20261021` ni dans `main`.
- Sur `icos_app` (VPS, relevé du 2026-10-23) : `workforce_agents`=0, `workforce_roles`=0 — rien
  n'a jamais été semé en production. Le code déployé (`de3bebd`) ne contient pas ces routes.
- `scripts/workforce-bootstrap.ts` existe dans le dépôt et **fabrique une fausse session**
  depuis `ICOS_OWNER_EMAIL` — c'est l'anti-pattern qu'ADR 0068 interdit. **Ne jamais l'utiliser
  pour cette activation.** Les routes ci-dessous sont l'alternative conforme : elles exigent
  une session Better Auth réelle (`container.auth.readSession`), jamais un principal fabriqué.

## 1. Préalable — convergence du code (aucun effet sur `icos_app`)

| #   | Action                                                                                                                                                                          | Preuve attendue                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| P1  | Merger/rebaser cette branche sur `feat/omniroute-backend-20261021` (actuellement un fast-forward trivial : merge-base = tip exact de cette branche, zéro commit divergent)      | `git merge-base --is-ancestor c350399 HEAD` → vrai                                                                       |
| P2  | `pnpm lint && pnpm typecheck && pnpm vitest run` sur la branche convergée                                                                                                       | lint 0 erreur ; typecheck exit 0 ; `351 passed \| 1 skipped`, `5069 tests passed \| 4 skipped` (reproduit 2026-10-24)    |
| P3  | `pnpm test:integration -- src/server/workforce/` (Docker requis — sinon ces suites sont **silencieusement** ignorées, piège déjà documenté ailleurs dans le dépôt)              | 3 fichiers / 16 tests PASS (PostgresWorkforceStore Testcontainers, dispatch-bridge décision 0070, brain-seed FK réelles) |
| P4  | Revue indépendante du diff (10 fichiers, 0 modification de `mission-binding.ts`/`chief-delegation.ts`/CORE3) par un reviewer qui n'a pas écrit ce code, conformément à ADR 0044 | rapport de revue, verdict PASS/FAIL par point                                                                            |
| P5  | Pull request vers `feat/omniroute-backend-20261021` décrivant besoin/risques/contrôles (CONTRIBUTING.md)                                                                        | PR ouverte, approuvée                                                                                                    |

Seulement après P1–P5 : déployer/merger cette branche là où `icos_app` lira son code (le
chemin exact — nouvelle release VPS, ou autre lignée — est une décision propriétaire distincte,
hors du périmètre de cette activation).

## 2. Dossier de préparation à relire avant de certifier

`docs/acceptance/2026-10-23-brain-role-certification-dossier.md` : les 9 `BRAIN_ROLES`, leur
niveau de risque, et le constat central — **les identifiants `tests` déclarés par chaque
compétence (`skill.*.fixture`) ne correspondent à aucun test exécutable du dépôt.** Certifier
en recopiant ces chaînes dans `testsPassed` sans avoir réellement exécuté quoi que ce soit
produit une certification qui passe la gouvernance (le code ne peut pas distinguer une chaîne
« vraie » d'une chaîne recopiée) mais qui est une attestation fictive — **pas un bug du code,
une responsabilité humaine que ce runbook rend explicite.**

**Avant de certifier un rôle, exécute réellement et note l'horodatage + les chiffres de :**
`pnpm typecheck && pnpm lint && pnpm build`, `pnpm test` (attendu 5069 tests), `pnpm
test:integration` (Docker, attendu les suites `postgres-workforce-store`/`dispatch-bridge`/
`brain-seed` PASS), `pnpm certify:gateway` (attendu 2× PROVEN). **C'est cette preuve — pas les
chaînes fixture — qui doit remplir `evidenceRef` dans l'étape 4.**

## 3. Authentification (préalable aux 4 requêtes qui suivent)

Toutes les routes exigent une session Better Auth réelle (cookie `icos.session_token`) portée
par un compte humain avec le rôle `admin` ou `owner` (permission `agents.manage`), **et**
l'en-tête `Origin` same-site (CSRF, `sameOrigin: true` sur chaque route d'écriture). Aucune
route n'accepte de `tenantId` dans le corps — le principal issu de la session porte toujours
`CURRENT_SINGLE_TENANT_ID`, jamais une valeur contrôlée par l'appelant.

Connecte-toi normalement à l'interface ICOS avec ton compte propriétaire ; chaque commande
ci-dessous réutilise ce cookie de session (`curl -b <cookie-jar>` ou l'inspecteur réseau du
navigateur pour copier le cookie et l'en-tête `Origin`).

## 4. Séquence d'activation (chaque étape = un acte humain tracé)

| Étape                | Requête                                                                                                                                                                                | Précondition                                                                                                                            | Preuve de succès                                                                                                                       | Refus possible                                                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A                    | `POST /api/admin/workforce/bootstrap-data/seed`                                                                                                                                        | aucune                                                                                                                                  | `{rolesBefore:0, rolesAfter:24, inserted:24}` (idempotent : relançable sans effet)                                                     | —                                                                                                                                                                                                              |
| B ×9                 | `POST /api/admin/workforce/roles/{roleId}/certify` body `{version:"1.0.0", testsPassed:[...], evidenceRef:"<horodatage + chiffres de l'étape 2>"}`, un par un pour les 9 `BRAIN_ROLES` | rôle `draft` (étape A faite)                                                                                                            | `{dryRun:false, role:{status:"certified"}, certifiedBy, evidenceRef}` ; ligne `ROLE_CERTIFICATION_EVIDENCE` dans `journalctl` (stderr) | 404 si rôle non bootstrapé ; 422 `MISSING_TESTS`/`SELF_CERTIFICATION` (ce dernier ne peut pas se déclencher ici, le créateur du rôle est le système `workforce-bootstrap`, jamais toi — voir dossier §constat) |
| C ×9                 | `POST /api/admin/workforce/roles/{roleId}/activate` body `{version:"1.0.0"}`                                                                                                           | rôle `certified` (étape B faite)                                                                                                        | `{dryRun:false, role:{status:"active"}, activatedBy}`                                                                                  | 422 `NOT_CERTIFIED` si B a été sautée                                                                                                                                                                          |
| D (prévisualisation) | `POST /api/admin/workforce/brains/activate?dryRun=true`                                                                                                                                | —                                                                                                                                       | `{rolesAllActive:true, brains:[...12, alreadyPresent:false...]}`                                                                       | `rolesAllActive:false` → retourner à B/C                                                                                                                                                                       |
| E                    | `POST /api/admin/workforce/brains/activate`                                                                                                                                            | les 9 rôles `active` (sinon 422 `governance_denied` avec la liste exacte des rôles manquants — la route refuse de certifier à ta place) | `{report:{complete:true, brains:{results: 12×"created"}, grants:{results: aucun "refused", ≥1 "granted" avec outils}}}`                | 503 `transient_conflict` (relancer, idempotent)                                                                                                                                                                |
| F                    | `GET /api/admin/workforce/status`                                                                                                                                                      | —                                                                                                                                       | `brains.registered=12`, `brainRoles.roles` tous `active`, chaque `agents[i].status="active"`                                           | —                                                                                                                                                                                                              |

Relancer A/E après coup est sans danger (idempotent, prouvé par les tests `brain-seed.integration.test.ts`
et `workforce-activation.test.ts` « est idempotent »).

## 5. Première preuve de délégation (hors périmètre de cette branche — vérification seulement)

Cette branche ne câble aucune nouvelle mission. Pour la première preuve de bout en bout une
fois les 12 cerveaux actifs (ADR 0070, déjà composé en production dans
`production-services.ts`) :

1. Convertir l'un des `goals` `pending` existants en mission réelle (`workClass: USER`, le
   chemin Planner→Builder le plus simple).
2. Relire, en lecture seule : `workforce_assignments` (≥1 ligne), `dispatch_attempts.
routing_decision.workforce` (non nul), `spend_ledger.brain_id` (non nul sur au moins une
   ligne). Ce sont les trois preuves établies par l'audit runtime du 2026-10-23 comme la
   définition de « réellement branché », pas seulement « enregistré ».
3. **Ne lance rien de cela toi-même sans vouloir déclencher une vraie mission** — c'est un acte
   de production distinct de l'activation des identités.

## 6. Garde-fous de ce runbook

- Aucune étape ci-dessus n'autocertifie : `certifyRole` refuse si le certificateur est le
  créateur du rôle, mais comme les 9 rôles sont créés par le système `workforce-bootstrap`
  (jamais par un humain), **un seul opérateur humain peut légitimement jouer les deux rôles**
  (demandeur et certificateur) sans déclencher `SELF_CERTIFICATION` — ce n'est pas une
  dérogation technique, c'est ce que le code autorise déjà. Si une revue indépendante réelle
  est voulue, utilise une seconde session humaine pour les étapes B/C.
- `testsPassed` n'est jamais vérifié automatiquement : voir §2. Le dossier de certification et
  ce runbook sont la seule garde procédurale contre une attestation fictive — pas le code.
- Aucune route n'accepte de `tenantId` depuis la requête ; aucune ne fabrique de `Principal` —
  chaque principal vient de `container.workforce.sessions.fromSession(session réelle)`.
- `scripts/workforce-bootstrap.ts` reste non conforme (fabrique une session depuis une variable
  d'environnement) — il n'a été ni modifié ni supprimé dans cette mission ; ne l'utilise pas
  pour cette activation.
