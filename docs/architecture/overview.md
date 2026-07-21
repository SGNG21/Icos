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
5. `server` héberge les ports de services et leurs implémentations en mémoire,
   ainsi que le journal d'audit ; il accueillera les adaptateurs de persistance.
6. `config` valide la configuration à la demande (`loadEnv`) ; les intégrations
   restent optionnelles et inactives.

```text
Interface → cas d'usage → politiques d'autorisation → ports → adaptateurs externes
                              ↓
                         journal d'audit
```

Une intégration ne devra jamais être appelée directement depuis un composant. Chaque action portera
son niveau de risque, l'agent initiateur, son état d'approbation et un résultat journalisable.

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
