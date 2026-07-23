---
name: icos-workflows-temporal
description: Use when designing a long-running, multi-step, interruptible or resumable execution that outlives a single Postgres transaction
---

# icos-workflows-temporal

## Objectif

Définir comment ICOS orchestre une exécution longue et reprenable, en
utilisant les anti-patterns constatés dans l'orchestration n8n de Holding IA
comme repoussoir explicite : transitions non atomiques, absence
d'idempotence, retries aveugles, actions marquées `executed` prématurément,
routes d'exécution vides, absence de DLQ, causalité incomplète.

## Contexte d'utilisation

- Un processus dépasse la durée ou la fiabilité raisonnable d'une transaction
  Postgres unique (`icos-postgresql` reste la solution par défaut tant que
  ce n'est pas le cas).
- Le processus doit survivre à un redémarrage du service.
- Le processus comporte plusieurs étapes avec des points de reprise
  explicites après échec partiel.

**Ne doit PAS s'activer quand** une tâche métier reste transactionnelle et
rapide au sens d'une seule transaction Postgres (→ `icos-postgresql` /
`icos-agent-orchestration` restent la solution par défaut), ou pour statuer
sur les règles métier d'agents elles-mêmes plutôt que sur leur substrat
d'exécution (→ `icos-agent-orchestration`).

## Invariants ICOS

- Temporal (ou tout moteur d'exécution durable équivalent) est une
  **dépendance externe significative** : son introduction n'est jamais
  décidée par défaut, elle nécessite validation explicite de l'utilisateur.
- n8n n'est jamais l'orchestrateur central d'ICOS ; au mieux un adaptateur
  temporaire vers un système externe, jamais le porteur de la logique
  métier ou de l'état d'exécution.
- Un scheduler, cron ou heartbeat ne fait que déclencher une évaluation : il
  n'accorde aucune autorité et ne remplace ni un moteur de workflow durable,
  ni ses garanties de reprise, d'idempotence et de causalité.
- Un EventBus de télémétrie/pub-sub n'est ni une source d'état métier, ni
  l'Event Journal immuable d'ICOS ; toute transition faisant foi est
  persistée en PostgreSQL selon les invariants `icos-postgresql`.
- Chaque transition d'état (`approved` → `execution_requested` → `executed`
  → `failed`) est un événement distinct et observable, jamais une inférence
  implicite.
- Un état `executed` n'est écrit qu'après confirmation réelle de
  l'exécution — jamais en amont, jamais par un stub qui n'exécute rien.
- Toute reprise après échec est idempotente : rejouer une étape déjà
  exécutée ne doit produire aucun effet de bord supplémentaire (clé
  d'idempotence obligatoire).
- Les retries sont bornés, avec backoff et jitter — jamais un retry aveugle
  et illimité.
- Une file de messages morts (DLQ) existe pour toute étape pouvant échouer
  durablement, avec un chemin de traitement humain explicite.
- La causalité complète (quelle mission, quel run, quelle tâche a déclenché
  cette étape) reste traçable de bout en bout.

## Ce qu'elle doit vérifier avant d'agir

1. Ce processus a-t-il réellement besoin d'un moteur d'exécution durable, ou
   une transaction Postgres classique (`icos-postgresql`) suffit-elle ?
2. Si un moteur externe est envisagé, la décision a-t-elle été explicitement
   validée par l'utilisateur (dépendance externe significative) ?
3. Chaque étape a-t-elle une clé d'idempotence avant d'être conçue comme
   rejouable ?
4. Existe-t-il une route de traitement pour chaque échec possible, ou
   certaines branches restent-elles vides comme dans Holding IA ?
5. L'état `executed` est-il écrit seulement après confirmation réelle
   d'exécution ?
6. Une DLQ ou un mécanisme équivalent est-il prévu pour les échecs
   persistants ?

## Technologies autorisées

Aucune par défaut. Temporal (self-hosted ou Cloud) est la piste de référence
pour l'exécution durable si un besoin concret émerge en Phase 3, mais son
adoption reste une décision distincte nécessitant validation explicite
(aucune preuve d'usage dans Holding IA à évaluer). Jusque-là, toute
exécution multi-étapes reste portée par les use cases et transactions
Postgres existants.

## Anti-patterns

Tous confirmés par l'audit Holding IA (orchestration n8n, 29+ workflows,
84,4 % de taux d'échec historique constaté sur le VPS) :

- Marquer une action `executed` alors qu'un seul nœud stub est réellement
  branché (WF-B `action-dispatch.json`).
- Laisser une décision `approved` sans qu'aucune route d'exécution associée
  ne soit branchée (WF-C `action-decision.json`, six routes vides).
- Bug de séquencement où une valeur calculée dans un nœud est relue depuis
  la sortie d'un nœud précédent au lieu du nœud qui l'a produite (WF-A
  `action-create.json`, `risk_forced`).
- Absence d'authentification sur un webhook déclencheur.
- Absence de transaction ou d'idempotence entre insertion, décision,
  exécution et résultat (requêtes REST indépendantes).
- Utiliser des images Docker `latest` non figées, ou des permissions
  d'exécution trop larges (`NODE_FUNCTION_ALLOW_BUILTIN=*` constaté).
- Absence de DLQ métier pour les échecs d'exécution.
- Expression cron mal alignée avec l'intention documentée (ex. un
  commentaire annonçant « toutes les 6h » pour une expression qui ne
  s'exécute qu'une fois par jour) — vérifier systématiquement les
  expressions cron contre leur documentation.

## Sécurité

Voir `icos-security` : toute reprise ou retry reste soumise au pipeline
d'autorisation et ne doit jamais permettre à une action expirée ou rejetée
d'être exécutée par un message tardif.

## Stratégie TDD

- Test qu'un rejeu (replay) d'une étape déjà exécutée ne produit aucun effet
  de bord supplémentaire (idempotence), avant d'implémenter la logique de
  reprise.
- Test que chaque branche d'échec possible a un comportement défini (jamais
  une route vide silencieuse).
- Test que l'état `executed` n'est jamais atteint sans confirmation réelle
  simulée de l'exécution sous-jacente.
- Test de non-régression sur les expressions de planification (cron ou
  équivalent) contre leur documentation.

## Définition de done

- Toute étape a une clé d'idempotence testée.
- Aucune branche d'échec vide.
- La décision d'introduire un moteur d'exécution durable externe est
  explicitement validée et documentée dans une ADR avant tout code.
- La causalité Mission → Run → Task → Action est vérifiable de bout en bout
  pour chaque exécution testée.
