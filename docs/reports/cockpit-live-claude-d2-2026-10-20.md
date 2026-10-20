# COCKPIT-LIVE-CLAUDE — Rapport D2 (écrans du Control Center alimentés par les sources réelles)

- **Date :** 2026-10-20 (labo navigateur 00:03 → 00:05 UTC)
- **Branche :** `feat/cockpit-live-d1-20261020` (base hub `b4d0968`)
- **Commits D2 :** `aef657c` (intégration écrans) · commit suivant (ce rapport + captures)
- **Statut :** D0 `REVIEW_READY` · D1 `REVIEW_READY` · **D2 `REVIEW_READY`** (reviewer indépendant et IntegrationGate non exécutés) · D3 `IN_PROGRESS`

Aucun merge, déploiement, écriture en prod, appel de modèle ni `.env` affiché. Hermes (R1-03c : `quality-control`, `integration-gate` ; CHAT-P0 : conversation/executive chat/voix), FABLE et les 40 fichiers indexés de `cockpit-agentic-os` (`cockpit.css`, `cockpit-nav.tsx`, `nav-items.ts`, `node-tone.ts`, `render.test.ts`, graphe) ne sont pas touchés : aucun fichier modifié ici n'en fait partie (statuts git des worktrees inchangés : 43 / 5 / 16).

---

## 1. Écrans raccordés

| Écran | Ajout (sans redesign) | Source réelle |
| --- | --- | --- |
| `/cockpit` (overview) | panneau **Live sources** : cinq sources avec état, source, horodatage, seuil ; activité observée ; incidents confirmés | `loadLiveOverview()` → `readLiveOverview` (D1), faits de `loadSources()` réutilisés dans la même requête |
| `/cockpit/system` | **Host resources** (santé hôte, CPU, charge, RAM, disque, VRAM, échantillon), **Confirmed incidents**, **Probed services** (PostgreSQL, OmniRoute, Temporal, Nemotron en trois couches) | `/proc`, `/sys`, `statfs` ; `SELECT 1` ; `GET /api/monitoring/health` ; Temporal `not instrumented` |
| `/cockpit/providers` | **OmniRoute gateway** : état passerelle, Nemotron, appels/tokens 24 h, statut de prix, coût (NOT AVAILABLE tant qu'un appel est `UNPRICED`), dernier appel mesuré | monitoring natif + `spend_ledger` |
| `/cockpit/workers` | **Fleet evidence** : enregistrés, actifs, routables prouvés, en exécution, sondes échouées / périmées / jamais | `workers.last_probe_at`, `dispatch_attempts` |

Actualisation : `LiveRefresh` existant (battement 15 s sur `/api/cockpit`, `router.refresh()`, backoff ≤ 120 s, `STALE` > 45 s, pause onglet caché). Aucun nouveau poller ; les caches serveur fixent la cadence par source (sondes 15 s, hôte 10 s, agrégats SQL par requête). Aucun SSE, aucun port.

Sémantique visuelle : vert = mesuré et frais (`LIVE`) ; orange = `STALE`/`DEGRADED` ; gris = `UNAVAILABLE`/`FORBIDDEN`/non instrumenté/`UNKNOWN` ; rouge = incident confirmé par une mesure (`WORKER_PROBE_FAILED`, `OMNIROUTE_DOWN`, `POSTGRES_DOWN`, `HOST_SATURATED`, `SCHEDULER_DEAD_JOBS`) ; violet = tons `autonomy` existants (recommandations). Codes affichés tels quels : `UNPRICED n/m`, `NO_TELEMETRY`, `NOT_CONNECTED`, `NO_SOURCE_TIMESTAMP`, `FORBIDDEN_SCOPE`. Seule animation : l'icône d'activité pulse uniquement si un dispatch non terminal ou une lease de scheduler est détenu (`data-observed`), respect de `prefers-reduced-motion` par la règle globale existante.

## 2. Fichiers modifiés (commit `aef657c`, 14 fichiers)

- Nouveaux : `src/components/cockpit/live-sources.tsx` (panneaux serveur), `src/components/cockpit/live-sources.render.test.ts`, `src/app/cockpit/live.css`.
- Modifiés : `src/app/cockpit/{page,system/page,providers/page,workers/page}.tsx` (ajout d'un chargement et d'un panneau chacun), `src/app/cockpit/layout.tsx` (import `live.css`), `src/features/cockpit/load.ts` (+`loadLiveOverview`), `src/features/cockpit/live-sources.ts` (option `preloaded`), `src/features/cockpit/live-overview.ts` (+`services`), `src/features/cockpit/observed.ts` (ton `forbidden` gris, libellés), tests associés, `scripts/cockpit-live-verify.ts` (typage).
- Non touchés : `cockpit.css`, `cockpit-nav.tsx`, `nav-items.ts`, `node-tone.ts`, `render.test.ts`, scheduler, registre, budget, migrations.

## 3. Validation

| Gate | Résultat |
| --- | --- |
| `pnpm typecheck` | PASS |
| `pnpm exec eslint <fichiers modifiés>` | PASS (le `.css` n'est pas linté) |
| Tests ciblés : `live-sources.render.test.ts`, `live-overview.test.ts`, `observed.test.ts`, `src/app/api/cockpit`, `render.test.ts` | **6 fichiers, 55 tests PASS** |
| Rendu sur données réelles | les panneaux rendus en `renderToStaticMarkup` depuis la preuve D1 (`evidence/cockpit-live-d1-verify-2026-10-20.json`) : 5 × `LIVE`, `UNPRICED 25,602/25,602`, `11 routable`, `VRAM NO_TELEMETRY`, `WORKER_PROBE_FAILED` rouge, passerelle `DEGRADED` orange, coût `NOT AVAILABLE BR-05`, aucun motif sensible |
| Valeurs nulles / refus | `forbidden` et `unavailable` → badge gris, code, aucun chiffre ; `stale` → orange avec valeur et horodatage ; `degraded` → `NO_SOURCE_TIMESTAMP` |

**Labo navigateur** (base jetable `cockpit-live-pg-lab`, port 55472, 64 migrations, owner `owner@lab.invalid`, `next dev` :3412, `OMNIROUTE_BASE_URL` loopback en GET seulement, aucun worker enregistré donc aucune sonde dépensière, `ICOS_COMPUTE_BOOTSTRAP` absent) — Chromium 1208 via `mcr.microsoft.com/playwright:v1.58.2-noble`, captures dans `docs/reports/evidence/cockpit-live-d2-screens/` :

| Contrôle | Desktop 1440×1000 | Mobile 390×844 |
| --- | --- | --- |
| Anonyme `/cockpit/system` | 307 → `/login?next=%2Fcockpit%2Fsystem` | idem |
| Anonyme `/api/cockpit/live`, `/api/cockpit/telemetry` | 401 | — |
| Owner : `/cockpit`, `/system`, `/providers`, `/workers` | 200, marqueurs présents, `LIVE` | 200, marqueurs présents, **aucun débordement horizontal** |
| Reconnexion : `/api/cockpit` bloqué 16 s | indicateur `ERROR · reconnecting · data 16s old`, `data-cx-stale` posé | idem |
| Motifs sensibles dans le HTML | aucun (la seule occurrence de « password » est le texte existant « fresh password proof » du mode sûr) | idem |

Ce que le labo montre réellement (base vide) : `core3`, `workers`, `memory` en `DEGRADED · NO_SOURCE_TIMESTAMP` (0 ligne, aucune preuve datée : pas de vert inventé), `omniroute` `LIVE` (passerelle réelle `degraded`, 2 disjoncteurs dégradés, ledger 0 appel → `UNKNOWN`), `vps` `LIVE` (hôte réel : 8 vCPU, CPU 25 %, charge 3,29, RAM 48 %), Temporal `not instrumented`. Les données de production ne sont jamais pointées par le labo.

## 4. Sécurité et isolation

- Toute page passe par `getCockpitContext` (`cockpit.read`) ; `/api/cockpit/live` par `protectRoute` ; `/api/cockpit/telemetry` exige `operator` + limite 60/min.
- Portée opérationnelle réelle : hors owner/admin, scheduler, registre, ledger, mémoire, sondes et hôte répondent `FORBIDDEN` (test viewer), jamais une valeur vide.
- Tenant : `CURRENT_SINGLE_TENANT_ID` seulement ; aucun paramètre, en-tête ou cookie client ne le modifie (test). **Mono-tenant sans RLS : aucune isolation multi-tenant n'est affichée ni revendiquée.**
- Aucun secret, URL de connexion, clé ou `lastFailure` fournisseur n'atteint le HTML ou le JSON (tests + scan des pages labo).

## 5. Incidents et limites

1. Rouge réel observé en prod (preuve D1) : 3 workers avec sonde en échec datée (`AUTH_FAILURE`, `UNAVAILABLE`, `UNKNOWN`).
2. Un magasin vide (mémoire, registre, scheduler sans ligne) s'affiche `DEGRADED · NO_SOURCE_TIMESTAMP` : honnête (aucune preuve datée) mais orange ; à arbitrer si un libellé `EMPTY` distinct est préféré.
3. Latence par appel de modèle non mesurée (NOT AVAILABLE) ; Temporal non instrumenté (0 poller en prod).
4. Sur mobile, le tableau des cinq sources défile horizontalement dans son conteneur (`cx-scroll`), comme les autres tableaux du Control Center ; pas de version empilée.
5. Chaque rafraîchissement `LiveRefresh` (15 s/onglet) ajoute les agrégats bornés (scheduler, ledger, mémoire) et relit les sondes sous cache : ~0,6 s mesurés en D1 sur la base réelle ; à surveiller avec plusieurs onglets.
6. Tests d'intégration PostgreSQL, `pnpm build` et suite complète non exécutés.

## 6. Dépendances empêchant le déploiement

- Base = hub `b4d0968`, 58 commits devant la release `5719213` ; déployer D1/D2 implique de déployer le hub (décision propriétaire, hors mandat).
- Revue indépendante puis IntegrationGate (ADR 0044) non exécutées ; aucune auto-certification.
- Migration 0065 (W9 cache ledger) présente sur le hub et absente en prod (61 appliquées) : à rejouer avec le hub, hors de ce périmètre.

## 7. Proposition D3

1. Revue indépendante du diff `b4d0968..HEAD` (reviewer ≠ auteur, autre famille de modèle si possible), puis IntegrationGate sur une base jetable.
2. Fraîcheur en conditions réelles : rejouer `scripts/cockpit-live-verify.ts` sur 3 relevés espacés pour prouver `STALE` lors d'une pause réelle du scheduler (sans l'arrêter : attendre une fenêtre d'inactivité naturelle) et `LIVE` au retour.
3. Tests d'intégration PostgreSQL ciblés sur les agrégats `readLiveOverview` (base jetable `icos_test`).
4. QA mobile manuelle sur appareil (PWA) et vérification `prefers-reduced-motion`.
5. Option : libellé `EMPTY` pour un magasin lu mais vide, et stacking mobile du tableau des sources.

Labo : conteneur `cockpit-live-pg-lab` arrêté après captures (`docker start cockpit-live-pg-lab` pour le reviewer ; variables dans le scratchpad de session, jamais dans le dépôt).


## Référence d'autorisation

Étape D2 autorisée par le propriétaire dans la session Claude Code du 2026-10-20 (message « ICOS — COCKPIT LIVE — D2 AUTORISÉ »). Revues indépendantes et réponse : `docs/reports/reviews/`, `cockpit-live-claude-d3-review-response-2026-10-20.md`.
