# Architecture initiale

## Objectif

ICOS adopte un monolithe modulaire Next.js. Ce choix permet de livrer l'interface, les futures API
internes et les règles métier dans un seul déploiement, tout en gardant des frontières explicites.

## Couches

1. `app` compose les routes et les layouts, sans porter de règle métier.
2. `components` contient l'interface réutilisable et les assemblages visuels.
3. `features` regroupe les domaines et expose leurs types, données et règles.
4. `server` accueillera les cas d'usage, ports de persistance et adaptateurs externes.
5. `config` valide la configuration au démarrage ; les intégrations restent optionnelles et inactives.

```text
Interface → cas d'usage → politiques d'autorisation → ports → adaptateurs externes
                              ↓
                         journal d'audit
```

Une intégration ne devra jamais être appelée directement depuis un composant. Chaque action portera
son niveau de risque, l'agent initiateur, son état d'approbation et un résultat journalisable.

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
