# Feuille de route initiale

## Phase 0 — Socle (actuelle)

- cockpit local et responsive ;
- types d'agents, d'actions et d'approbations ;
- outillage qualité et documentation ;
- intégrations explicitement désactivées.

## Phase 1 — Confiance et persistance

- modèle PostgreSQL et migrations ;
- identité, sessions et rôles ;
- journal d'audit immuable ;
- moteur de politiques testé.

## Phase 2 — Conversation contrôlée

- API interne de conversation ;
- mémoire segmentée et règles de rétention ;
- premier fournisseur IA derrière une interface ;
- budgets, limites et observabilité.

## Phase 3 — Orchestration

- cycle de vie des tâches et approbations ;
- agents spécialisés sans privilège implicite ;
- intégrations GitHub et n8n en lecture seule d'abord ;
- mécanismes d'annulation et rapports d'exécution.

Chaque phase exige une revue de sécurité et des critères d'acceptation mesurables avant activation.
