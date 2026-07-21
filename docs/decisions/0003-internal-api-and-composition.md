# ADR-0003 — API interne simulée, composition et unité de travail en mémoire

- Statut : accepté
- Date : 2026-07-21

## Contexte

Le Lot 1B expose le noyau domaine du Lot 1A derrière une API interne Next.js et
un panneau d'approbation, sans aucune intégration externe ni persistance réelle.
Plusieurs invariants de sécurité doivent être garantis avant toute exposition.

## Décision

- **Composition centralisée** : un container (`src/server/container.ts`) assemble
  les services en mémoire au-dessus d'un unique journal d'audit et d'un store
  partagé actions/approbations. Il est mémoïsé sur `globalThis` et **réservé au
  runtime Node.js**. L'intégrité référentielle des seeds est validée à la
  composition ; une incohérence fait échouer explicitement le démarrage.
- **Couche use cases** (`src/server/usecases`) : l'orchestration (résolution des
  références, moteur d'autorisation, mutations liées) vit dans les use cases, pas
  dans les Route Handlers. Les services portent leurs invariants locaux.
- **Résolution sécurisée de l'agent** : une décision d'exécution n'accepte jamais
  un `Agent` ou un niveau fourni par l'appelant. L'agent est résolu depuis
  `action.initiatedByAgentId` via `AgentService`, avant toute mutation.
- **Unité de travail transactionnelle en mémoire**
  (`ActionDecisionUnitOfWork`) : l'approbation, la mise à jour de l'action et
  l'écriture de toutes les entrées d'audit forment une opération logique unique.
  L'audit est écrit de façon atomique (`appendMany` valide toutes les entrées
  avant d'en écrire une), puis l'application est une écriture synchrone qui ne
  peut plus échouer. Aucune transaction n'est simulée par deux appels de services
  mutables successifs.
- **Motif de rejet obligatoire**, **titre normalisé (`trim`)**, **nombres d'audit
  finis** (`z.number().finite()`), **format d'erreur typé** `{ error: { code,
message, details? } }` avec codes en union stable et détails Zod sans valeur
  d'entrée.
- **Rendu dynamique** : la page cockpit lit un état mutable en mémoire ; elle est
  `force-dynamic` et les routes de lecture interdisent le cache.

## Conséquences

- L'état est volatil : perdu au redémarrage, au déploiement, au démarrage à froid
  serverless, et propre à chaque instance. Le cockpit le présente comme simulé.
- `decidedBy` (alimenté par `decidedByLabel`) est une étiquette déclarative non
  authentifiée : aucune identité vérifiée tant que l'authentification n'existe pas.
- PostgreSQL remplacera le store et l'unité de travail par une persistance et une
  transaction réelles (roadmap phase 1).
