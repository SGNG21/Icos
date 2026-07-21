# ICOS

ICOS est le futur cockpit central de Holding IA : un assistant opérationnel destiné à
orchestrer progressivement DigitalOS et l'écosystème Polivia, sous contrôle humain.

> **Statut : initialisation.** L'interface et les modèles présents constituent un socle. Les
> intégrations, la persistance, l'authentification et toute capacité d'exécution sont désactivées.

## Stack

- Next.js 16 avec App Router et React 19 ;
- TypeScript en mode strict ;
- Tailwind CSS 4 ;
- ESLint, Prettier et Vitest ;
- validation des variables d'environnement avec Zod ;
- pnpm comme gestionnaire de paquets.

## Prérequis

- Node.js 24 LTS ;
- pnpm 11.10.0.

Le projet cible volontairement Node.js 24 via `.nvmrc` et `engines`. Node.js 26 est installé sur la
machine ayant servi à l'initialisation, mais cette version non LTS cible n'est pas la référence du
projet. Avec nvm :

```bash
nvm use
corepack enable
pnpm install
```

Ne placez jamais de secret dans le repository. Copiez `.env.example` vers `.env.local` et renseignez
uniquement les variables nécessaires sur votre machine.

## Commandes

```bash
pnpm dev           # serveur de développement
pnpm build         # build de production
pnpm lint          # analyse ESLint
pnpm typecheck     # vérification TypeScript
pnpm format        # formatage Prettier
pnpm format:check  # contrôle du formatage
pnpm test          # tests unitaires
pnpm check         # tous les contrôles qualité
```

## Organisation

- `src/app` : routes, layout et styles globaux ;
- `src/components` : composants d'interface et de mise en page ;
- `src/core` : domaine pur — contrats Zod (`core/contracts`, source unique de
  vérité), politique d'autorisation et cycle de vie des tâches ;
- `src/features` : données de démonstration typées par les contrats ;
- `src/config` : validation de l'environnement à la demande (`loadEnv`) ;
- `src/server` : ports de services, implémentations en mémoire, journal d'audit,
  unité de travail transactionnelle, use cases, couche HTTP et container ;
- `src/app/api` : Route Handlers internes simulés (runtime Node.js, dynamiques) ;
- `docs` : architecture, décisions et feuille de route ;
- `tests` : emplacement réservé aux futurs tests transverses.

## API interne (simulée)

Une API interne expose le domaine sans aucune intégration externe : `GET
/api/agents`, `GET|POST /api/tasks`, `POST /api/tasks/[id]/transition`, `GET
/api/actions`, `POST /api/actions/[id]/decision`, `GET /api/audit`. Le cockpit lit
directement le container côté serveur (rendu dynamique) et le panneau
Approbations effectue ses décisions via ces routes. Voir
[l'ADR-0003](docs/decisions/0003-internal-api-and-composition.md).

## Limites actuelles

La conversation ne déclenche aucune action. Les agents affichés sont des données de démonstration.
Il n'existe ni base PostgreSQL, ni API publique, ni authentification, ni connexion à GitHub, OpenAI,
Anthropic, n8n ou Dolibarr. Le journal d'audit et les services sont en mémoire : ils perdent leur
état à chaque redémarrage, ne sont pas fiables entre plusieurs processus et ne constituent aucune
garantie d'audit de production. L'approbation d'une action enregistre une décision et un audit mais
ne déclenche **aucune** exécution réelle ; l'identité du décideur (`decidedBy`) est une étiquette
déclarative non authentifiée. Leur remplacement par PostgreSQL est prévu (voir la feuille de route,
[l'ADR-0002](docs/decisions/0002-zod-contracts-and-in-memory-services.md) et
[l'ADR-0003](docs/decisions/0003-internal-api-and-composition.md)).

## Prochaines étapes

1. Définir le modèle de permissions et le journal d'audit persistant.
2. Choisir la couche PostgreSQL et créer les premières migrations.
3. Ajouter l'authentification et la gestion des rôles.
4. Concevoir une API interne avant toute intégration externe.

Consultez aussi [l'architecture](docs/architecture/overview.md), la
[feuille de route](docs/roadmap/initial-roadmap.md) et les
[règles de contribution](CONTRIBUTING.md).
