# Architecture initiale

## Objectif

ICOS adopte un monolithe modulaire Next.js. Ce choix permet de livrer l'interface, les futures API
internes et les règles métier dans un seul déploiement, tout en gardant des frontières explicites.

## Couches

1. `app` compose les routes et les layouts, sans porter de règle métier.
2. `components` contient l'interface réutilisable et les assemblages visuels.
3. `core` porte le domaine pur : contrats Zod (`core/contracts`, source unique de
   vérité), politique d'autorisation (`core/authorization`) et cycle de vie des
   tâches (`core/tasks`). Aucune dépendance à l'infrastructure.
4. `features` fournit des données de démonstration typées par les contrats.
5. `server` héberge les **ports de repositories** (`server/repositories/ports.ts`,
   asynchrones) et leurs implémentations en mémoire, le journal d'audit, le port
   et l'implémentation de l'unité de travail transactionnelle (`server/uow`), les
   use cases d'orchestration (`server/usecases`), la couche HTTP (`server/http`),
   la sélection de backend (`server/persistence.ts`) et le container de
   composition (`server/container.ts`). Il accueillera les repositories
   PostgreSQL.
6. `app/api` expose les Route Handlers internes (runtime Node.js, rendu
   dynamique) ; ils délèguent toute orchestration aux use cases.
7. `config` valide la configuration à la demande (`loadEnv`) ; les intégrations
   restent optionnelles et inactives.

Les accès aux entités sont **asynchrones** (`Promise`), ce qui prépare un
backend PostgreSQL derrière les mêmes ports. Une ressource absente est
représentée par `null`. Les fonctions purement métier restent synchrones.

### Persistance PostgreSQL (fondation, Lot 2A-2a)

`src/server/database` porte le schéma Drizzle, le client (postgres.js), les
migrations (`drizzle/`) et les mappings ligne↔contrat (revalidés par Zod).
`src/server/repositories/postgres` fournit les repositories PostgreSQL satisfaisant
les ports asynchrones. Source unique de la relation tâche↔actions : `actions.task_id`
(`Task.actionIds` dérivé en lecture). Tests d'intégration réels via Testcontainers
(`pnpm test:integration`, Docker requis, ignorés sinon) ; `pnpm test` reste sans
Docker. Le câblage au container et la transaction de décision arrivent au Lot 2A-2b.

### Sélection du backend

`PERSISTENCE=memory|postgres` est résolue de façon déterministe, **sans bascule
silencieuse** : dev/test sans valeur → `memory` ; production sans valeur →
erreur ; `postgres` → erreur « backend non implémenté » (Lot 2A-2), jamais de
repli mémoire. `getContainer()` mémoïse une `Promise<Container>` sur `globalThis`
(instance unique en cas d'appels concurrents) et **libère le cache si
l'initialisation échoue**.

```text
Interface → Route Handlers → use cases → politiques d'autorisation → ports → adaptateurs externes
                                 ↓
                    unité de travail → journal d'audit
```

Une intégration ne devra jamais être appelée directement depuis un composant. Chaque action portera
son niveau de risque, l'agent initiateur, son état d'approbation et un résultat journalisable.

## API interne (Lot 1B, simulée)

Routes internes, sans intégration externe ni persistance réelle :

| Méthode | Route                        | Rôle                          |
| ------- | ---------------------------- | ----------------------------- |
| GET     | `/api/agents`                | liste des agents              |
| GET     | `/api/tasks`                 | liste des tâches              |
| POST    | `/api/tasks`                 | création simulée d'une tâche  |
| POST    | `/api/tasks/[id]/transition` | transition contrôlée          |
| GET     | `/api/actions`               | liste des actions (filtrable) |
| POST    | `/api/actions/[id]/decision` | approbation/rejet humain      |
| GET     | `/api/audit`                 | journal d'audit filtré        |

Le container est mémoïsé sur `globalThis` et réservé au runtime Node.js. Son état
est **volatil** : il peut survivre à certains rechargements de modules en
développement sans garantie, et il est réinitialisé au redémarrage, au
déploiement, au démarrage à froid serverless ; chaque instance a son propre état.
La décision d'exécution résout toujours l'agent depuis `action.initiatedByAgentId`
via `AgentService` — jamais un agent fourni par l'appelant. La décision humaine
(approbation + action + audit) est appliquée par une unité de travail
transactionnelle en mémoire, tout-ou-rien. `decidedBy` est une étiquette
déclarative non authentifiée.

## Niveaux d'autorisation

| Niveau | Rôle         | Lecture seule | Réversible | Sensible                        |
| ------ | ------------ | ------------- | ---------- | ------------------------------- |
| 0      | Observation  | oui           | non        | non                             |
| 1      | Contributeur | oui           | non        | non                             |
| 2      | Opérateur    | oui           | oui        | approbation humaine obligatoire |
| 3      | Superviseur  | oui           | oui        | approbation humaine obligatoire |

Le niveau d'autorisation est nécessaire mais jamais suffisant pour une action
sensible : `requiresHumanApproval` ne peut pas contourner cette règle. La
décision est typée (`allowed` / `awaiting_approval` / `refused` + raison), un
rejet explicite est prioritaire et définitif, et toute information manquante
conduit au refus ou à l'attente, jamais à l'autorisation implicite.

## Journal d'audit — limites actuelles

L'implémentation en mémoire est append-only sur son interface publique mais
temporaire : aucune persistance, perte au redémarrage, non fiable entre
instances, inadaptée à la production. Chaque mutation d'un service écrit son
entrée d'audit avant d'être appliquée ; si l'audit échoue, la mutation est
abandonnée. L'atomicité transactionnelle réelle viendra avec PostgreSQL.

## Sécurité par défaut

- lecture seule distinguée des actions réversibles et sensibles ;
- approbation humaine obligatoire pour le sensible ;
- refus par défaut lorsqu'une décision manque ;
- secrets fournis uniquement par l'environnement ;
- aucune intégration active dans ce socle.

## Évolution prévue

PostgreSQL, l'authentification et l'API seront introduits après validation de leurs contrats. La
séparation en services déployables indépendamment n'est justifiée que par une contrainte mesurée de
sécurité, de charge ou d'organisation.
