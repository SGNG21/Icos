# Dossier de certification des 9 rôles cerveaux — 2026-10-23

**Statut : préparé, non exécuté. Ce document ne certifie rien.** Il rassemble, pour chacun
des 9 `BRAIN_ROLES` (ADR 0068), les éléments qu'un humain muni de `agents.manage` doit
examiner avant de décider de certifier ce rôle via la future route
`POST /api/admin/workforce/role-certifications/[id]/confirm` (Phase 2 du plan). Aucune preuve
n'est affirmée ici qui ne soit vérifiable par lecture directe du dépôt à la date ci-dessus.

## Constat central — à lire avant tout le reste

`requiredRoleTests(role, skills)` (`src/core/workforce/role-composer.ts`) ne renvoie pas des
noms de fichiers de test réels : il renvoie les chaînes du champ `tests` de
`bootstrap/skills.json`, qui sont des **identifiants fixture non implémentés**
(`skill.<nom>.fixture`). Recherche exhaustive dans tout le dépôt (`grep -r`) : **aucune** de
ces 9 chaînes n'apparaît ailleurs que dans `skills.json` lui-même — aucun fichier
`*.test.ts`/`*.spec.ts`, aucune config CI, aucun mapping ne leur correspond.

Pire : le seul appelant existant de `certifyRole`, `bootstrapWorkforce()`
(`src/server/workforce/bootstrap-workforce.ts:83-88`), calcule `requiredRoleTests(...)` et le
**renvoie tel quel** comme `testsPassed` — c'est-à-dire qu'il fournit mécaniquement la liste
exacte que le garde-fou `MISSING_TESTS` exige, sans qu'aucune exécution réelle n'ait eu lieu
entre les deux. Le run du 2026-10-04 (`role.certified ×9` dans
`docs/reports/2026-10-05-twelve-brain-load-bearing-audit.md`) a donc satisfait la gouvernance
au sens strict du code, **mais ne constitue pas une preuve technique que quoi que ce soit a
été testé** — c'est une tautologie, pas une évidence.

Le document `docs/acceptance/2026-10-02-live-activation-plan.md` (étape *b*, « Full
re-certification ») prescrit la vraie preuve à obtenir **avant** de lancer le seeding :
`pnpm typecheck && pnpm lint && pnpm build`, `pnpm test` (attendu : 3597 tests passés),
`pnpm test:integration` (Docker requis, sinon 13 fichiers sont *silencieusement* ignorés), et
`pnpm certify:gateway` (attendu : 2× PROVEN). **Recommandation de ce dossier : traiter le
passage réel de cette étape *b*, documenté par toi avec son horodatage et ses chiffres, comme
la preuve de `testsPassed` — pas les chaînes fixture elles-mêmes**, qui ne prouvent rien par
construction.

Même document, note confirmée par lecture du code (`role-composer.ts:154`,
`certifier.id === role.provenance.createdBy.id`) : les rôles livrés sont créés par
`{system, workforce-bootstrap}`, donc **le propriétaire peut légitimement être son propre
certificateur** sans déclencher `SELF_CERTIFICATION` — un deuxième humain n'est pas requis par
le code, seulement recommandé par ce plan pour une revue indépendante plus forte.

## Les 9 rôles

| Rôle | Version | Statut (bootstrap) | Niveau de risque | Compétence(s) | Tests requis (identifiants fixture — voir constat ci-dessus) | Fichier de test correspondant trouvé | Certification historique (lab, 2026-10-04) |
|---|---|---|---|---|---|---|---|
| `ICOS_CENTRAL` | 1.0.0 | draft | **LOW** | `CENTRAL_ORCHESTRATION` | `skill.central_orchestration.fixture` | Non trouvé | Oui (`role.certified` ×9 inclut ce rôle) |
| `OPERATIONS_MANAGER` | 1.0.0 | draft | **MEDIUM** | `OPERATIONS_MANAGEMENT` | `skill.operations_management.fixture` | Non trouvé | Oui |
| `SOFTWARE_ARCHITECT` | 1.0.0 | draft | **MEDIUM** | `SOFTWARE_ARCHITECTURE` | `skill.software_architecture.fixture` | Non trouvé | Oui |
| `FULLSTACK_ENGINEER` | 1.0.0 | draft | **MEDIUM** | `SOFTWARE_ENGINEERING` | `skill.software_engineering.fixture` | Non trouvé | Oui |
| `INDEPENDENT_REVIEWER` | 1.0.0 | draft | **MEDIUM** | `INDEPENDENT_REVIEW` | `skill.independent_review.fixture` | Non trouvé | Oui |
| `RESEARCHER` | 1.0.0 | draft | **LOW** | `RESEARCH`, `MARKET_RESEARCH` | `skill.research.fixture`, `skill.market_research.fixture` | Non trouvé (aucun des deux) | Oui |
| `SALES_DIRECTOR` | 1.0.0 | draft | **MEDIUM** | `SALES_LEADERSHIP`, `INDEPENDENT_REVIEW` | `skill.sales_leadership.fixture`, `skill.independent_review.fixture` | Non trouvé (aucun des deux) | Oui |
| `DEVOPS_ENGINEER` | 1.0.0 | draft | **HIGH** | `DEVOPS_OPERATIONS` | `skill.devops_operations.fixture` | Non trouvé | Oui |
| `SEO_SPECIALIST` | 1.0.0 | draft | **LOW** | `SEO_OPTIMIZATION` | `skill.seo_optimization.fixture` | Non trouvé | Oui |

**`DEVOPS_ENGINEER` (rôle de Delivery) est le seul des 9 à risque HIGH** : `certifyRole`
refuse un certificateur non humain pour ce rôle (`HUMAN_CERTIFICATION_REQUIRED`) — déjà
garanti par la conception Phase 2 (toute certification passe par une session humaine réelle).
Rappel : Delivery reste de toute façon exclu de `DELEGATION_SHAPES` (voir l'audit
documentaire) — certifier son rôle ne le rend pas délégable.

## Recommandation, par rôle

Identique pour les 9, car le constat central s'applique uniformément : **« preuve manquante :
aucun des identifiants `tests` déclarés par la compétence ne correspond à un test exécutable
du dépôt ; prêt pour certification uniquement si l'opérateur a fait passer, et documenté avec
horodatage, l'étape *b* (`pnpm test`, `pnpm test:integration`, `pnpm certify:gateway`) du plan
du 2026-10-02 — pas la seule présence des chaînes fixture dans `testsPassed`. »**

## Ce que ce dossier ne fait pas

- Il ne certifie aucun rôle, ne soumet aucun `testsPassed`, n'exécute aucun test, aucune
  commande `pnpm`, aucune requête contre une base (lab ou production).
- Il ne modifie ni `skills.json` ni `roles.json` ni aucun code.
- Il ne résout pas l'absence de tests réels derrière les identifiants fixture — cela reste une
  décision séparée (créer ces tests, ou changer le critère de certification), hors du
  périmètre de cette mission.
