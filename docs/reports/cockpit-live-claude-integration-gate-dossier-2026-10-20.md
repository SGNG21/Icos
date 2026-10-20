# COCKPIT-LIVE-CLAUDE — Dossier IntegrationGate (préparé en isolation, sans fusion)

- **Date :** 2026-10-20 (rejeu 03:13 → 03:45 UTC)
- **Branche / SHA candidat :** `feat/cockpit-live-d1-20261020` @ **`1255bf0`** (base hub `b4d0968`), 15 commits, aucun merge, aucun push, aucun déploiement.
- **Statut :** dossier **prêt pour la gate officielle** ; la gate elle-même (workspace manager, ADR 0044) et la fusion restent des actes du propriétaire. Aucune auto-certification.

## 1. Revue indépendante (ADR 0044) — trois dimensions, verdict final APPROVE

| Dimension | `a252d9d` | `0f9730d` (après `964114f`) | `1255bf0` (delta final) |
| --- | --- | --- | --- |
| Sécurité | REQUEST_CHANGES (3 P2) | APPROVE (2 P3) | **APPROVE** (Sonnet, 3 P3 de durcissement) |
| QA « breaker » | REQUEST_CHANGES (2 P1) | REQUEST_CHANGES restreint (2 P2) | **APPROVE** (Sonnet) |
| Architecture / gouvernance | REQUEST_CHANGES (2 P1 + 1 P1 coord.) | APPROVE (préconditions propriétaire) | **APPROVE** maintenu (Sonnet) |

Reviewers : agents séparés à contexte vierge, jamais l'auteur ; famille de modèle différente de l'auteur (Fable 5.1) mais même éditeur — Opus pour les deux premières passes, Sonnet pour la confirmation finale (les agents Opus ont été interrompus par une limite de dépense). Reviewer officiel `OmniRouteReviewer` indisponible (`ICOS_REVIEWER_MODEL` absent en prod). Rapports : `docs/reports/reviews/`, réponse de l'auteur : `cockpit-live-claude-d3-review-response-2026-10-20.md`.

## 2. Rejeu de la séquence de la gate (`src/server/workspace-manager/integration-gate.ts`, `DEFAULT_COMMANDS`)

Conditions : worktree isolé, `NODE_ENV=test`, base jetable `icos_cockpit_test` (conteneur `cockpit-live-pg-lab`, jamais la prod ni le labo FABLE), `pnpm install --frozen-lockfile --offline`. Écart avec la gate réelle : pas de sandbox réseau (`network: false`) ni de base jetable créée par le gatekeeper ; même séquence de commandes. Journal : `evidence/cockpit-live-gate-replay-2026-10-20.log`.

| Étape | Commande | Résultat | Durée |
| --- | --- | --- | --- |
| install | `pnpm install --frozen-lockfile --offline` | PASS | 1 s |
| typecheck | `pnpm run typecheck` | PASS | 19 s |
| lint | `pnpm run lint` | PASS | 74 s |
| tests unitaires | `pnpm test` | **PASS — 348 fichiers, 5 050 tests, 4 ignorés** | 447 s |
| base de test | `pnpm run test:db:setup` | PASS | 2 s |
| intégration PostgreSQL | `pnpm run test:integration` | **PASS — 107 fichiers, 837 tests, 3 fichiers / 4 tests ignorés** | 1 292 s |
| build | `pnpm build` | PASS (19 pages) | 124 s |

## 3. Preuves de données réelles (lecture seule)

- `evidence/cockpit-live-d1-verify-2026-10-20.json` (D1), `evidence/cockpit-live-d3-verify-2026-10-20.json` (après corrections, chemin transaction lecture seule + `statement_timeout`) : cinq sources `LIVE`, ledger `UNPRICED` sous `icos-holding`, 12/15 workers routables, incident `WORKER_PROBE_FAILED` mesuré.
- `evidence/cockpit-live-d2-screens/` : captures desktop/mobile, anonyme → login, API → 401, reconnexion → `STALE`.

## 4. Intégrité et périmètre

- Hermes (R1-03c, CHAT-P0), FABLE et l'index non commité de `cockpit-agentic-os` : intacts (statuts git inchangés tout au long de D0→D3).
- Aucun fichier de la base supprimé ; cinq fichiers propres à la branche retirés (déclarés, à acter).
- Aucun scheduler, registre, store ni cockpit parallèle ; CORE3 en lecture seule ; aucune migration, aucun `.env`, aucun secret.

## 5. Préconditions propriétaire avant la gate officielle et la fusion

1. Séquencer `src/features/cockpit/load.ts` avec l'index de `cockpit-agentic-os` et retenir un module unique d'observation OmniRoute.
2. Arbitrer la lane `cockpit-vps-monitor` (troisième implémentation VPS non commitée).
3. Réconcilier les deux vocabulaires de tenant (`icos-holding` ledger / `default` mémoire) — ADR ou décision.
4. Déployer uniquement avec le hub (`b4d0968`, migrations 0065/0066 absentes en prod).
5. Acter les suppressions déclarées (AGENTS.md).

P3 restants (durcissement, non bloquants) : échec d'écriture d'audit avalé sur le 403 de portée ; `statement_timeout` par instruction ; agrégat scheduler sans filtre tenant (gardé par la portée) ; pas de test unitaire direct de la propagation du marqueur depuis `load.ts`.
