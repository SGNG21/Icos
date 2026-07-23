---
name: icos-agent-orchestration
description: Use when defining task or skill lifecycle, specialized agents, agent capability registries, deterministic routing before LLM fallback, or resolving which agent initiated an action
---

# icos-agent-orchestration

## Objectif

Définir comment ICOS orchestre missions, tâches et agents sans reproduire la
prolifération d'agents non gouvernée observée dans Holding IA (57 prompts,
~35 « agents fantômes » sans implémentation). Impose une chaîne de
corrélation stricte et une distinction nette agent / capacité / workflow /
infrastructure.

## Contexte d'utilisation

- Conception du cycle de vie des tâches (Phase 3 de la feuille de route).
- Ajout d'un nouvel agent spécialisé, d'une nouvelle capacité, ou évaluation
  d'un `SkillCandidate` proposé à partir de traces répétées.
- Résolution de l'agent initiateur d'une action.
- Décision de router une requête de façon déterministe ou via un LLM.

**Ne doit PAS s'activer quand** la question porte sur le substrat technique
d'exécution d'un processus long/reprenable plutôt que sur les règles
métier d'agents (→ `icos-workflows-temporal`), ou sur l'exposition/
consommation d'une capacité via le protocole MCP plutôt que sur le modèle
interne d'agents (→ `icos-mcp-integrations`).

## Invariants ICOS

- Chaîne de corrélation complète : Mission → Run → Task → Action → Decision
  → Result. Toute action est traçable jusqu'à sa mission d'origine.
- Un agent est déclaré uniquement s'il a : une responsabilité démontrée, des
  capacités déclarées, des outils autorisés explicites, des politiques
  associées, des entrées/sorties typées, un owner, des tests, et une mini-ADR
  avant création.
- Distinction stricte : un **agent** porte une responsabilité typée et
  testée ; une **capacité** décrit ce qu'il peut demander ; un **skill** est
  une procédure versionnée composant capacités/outils ; un **tool** est un
  adaptateur d'exécution soumis aux permissions ; un **workflow** orchestre
  des étapes ; une **infrastructure** (queue, scheduler, base) n'est jamais
  elle-même présentée comme un agent.
- Des traces répétées peuvent produire un `SkillCandidate`, jamais un skill
  actif. Son lifecycle ICOS est gouverné et explicite : `discovered` →
  `quarantined` → `reviewed` → `approved` → `active` →
  `deprecated`/`revoked`. Seul `active` est invocable ; aucune découverte ne
  s'auto-active ni ne modifie permissions, policies ou hard gates.
- Une évolution de routage apprise depuis les traces reste une proposition
  évaluée et versionnée avec fallback déterministe ; elle ne remplace jamais
  les règles explicites ni leur revue humaine.
- La décision d'exécution résout toujours l'agent depuis
  `action.initiatedByAgentId` côté serveur — jamais un agent fourni
  directement par l'appelant.
- Le routage déterministe (règles explicites) précède tout fallback vers un
  LLM ; un LLM n'est invoqué que lorsque le routage déterministe ne peut pas
  trancher.
- Anti-prolifération : pas de nouvel agent sans preuve qu'une capacité
  existante ne suffit pas. Le registre d'agents reste petit et auditable.
- Toute action agent respecte le pipeline d'autorisation ICOS
  (`icos-security`) : niveau d'autorisation nécessaire mais jamais suffisant
  pour une action sensible.

## Ce qu'elle doit vérifier avant d'agir

1. L'agent proposé a-t-il une responsabilité, des capacités, et des tests
   déjà esquissés — ou s'agit-il d'un nom sans implémentation (« agent
   fantôme ») ?
2. Une capacité existante peut-elle couvrir ce besoin sans créer un nouvel
   agent ?
3. La résolution de l'agent initiateur passe-t-elle bien par le serveur,
   jamais par une valeur fournie par le client ?
4. Le routage proposé est-il déterministe en premier lieu, avec un LLM
   seulement en dernier recours documenté ?
5. La chaîne Mission → Run → Task → Action → Decision → Result est-elle
   complète pour ce nouveau cas d'usage, ou une étape manque-t-elle ?
6. Le résultat de l'action est-il observable (état, sortie, erreur) plutôt
   qu'implicite ?
7. Un pattern issu de traces est-il conservé comme `SkillCandidate` en
   quarantaine jusqu'à revue et approbation explicites, sans activation ni
   changement de permissions automatique ?

## Technologies autorisées

Infrastructure ICOS existante (use cases, ports, container). Aucun
orchestrateur externe (n8n, moteur de workflow tiers) comme mécanisme
central — voir `icos-workflows-temporal` pour l'exécution longue durée et
`icos-mcp-integrations` pour l'exposition d'outils.

## Anti-patterns

Confirmés par l'audit Holding IA :

- Modèle « 47/57/119 agents » : prolifération de noms d'agents sans
  implémentation réelle vérifiable (ARNO, MEMO, TOKI, VALDO, CODER, etc. —
  aucun workflow ni appel modèle associé).
- Confondre un composant d'infrastructure (label, workflow, vue) avec un
  agent (COCKPIT, SYNC, DISCOVERY, PIPELINE, BOARD dans Holding IA —
  doivent devenir des services/capacités, jamais des agents).
- Router entièrement via un prompt LLM opaque sans étape déterministe
  préalable (constaté : le routeur IRIS de Holding IA route sur prompt seul,
  cite des agents inexistants, comportement non déterministe).
- Dupliquer un prompt d'agent à plusieurs endroits avec des versions
  divergentes (constaté : `AUDIT.md` §1.3/§2.2 de Holding IA — prompt de
  test divergent du prompt canonique).
- Laisser l'appelant fournir l'identité de l'agent initiateur au lieu de la
  résoudre côté serveur.

## Sécurité

Voir `icos-security` : toute action d'agent reste soumise au pipeline
d'autorisation normal. Un agent n'obtient jamais de privilège implicite du
seul fait d'exister — cf. feuille de route Phase 3 : « agents spécialisés
sans privilège implicite ».

## Stratégie TDD

- Test de résolution serveur de l'agent initiateur (rejet si l'appelant
  tente de fournir un agent différent) avant d'implémenter une nouvelle
  action.
- Test du routage déterministe avec des cas couvrant toutes les règles
  explicites avant d'ajouter un fallback LLM.
- Test de la chaîne de corrélation complète (Mission → Run → Task → Action →
  Decision → Result) pour un nouveau cas d'usage, avant l'implémentation.
- Test négatif : un agent non déclaré dans le registre ne peut pas être
  invoqué.
- Test de lifecycle : un `SkillCandidate` découvert ou révoqué n'est pas
  invocable et sa promotion ne peut modifier aucune policy.
- Eval de promotion sur un corpus versionné : qualité, régressions, refus et
  faux positifs sont mesurés avant toute activation d'un skill ou d'une règle
  de routage apprise. Réussir cette eval est nécessaire mais jamais suffisant
  pour activer ou promouvoir un skill : elle ne confère par elle-même aucune
  autorisation d'activation, et la revue de sécurité (`icos-security`) ainsi
  que la validation humaine explicite restent obligatoires avant tout passage
  à `approved`/`active`. Aucune promotion automatique ne peut résulter du seul
  score d'une eval.

## Définition de done

- Chaque nouvel agent a une mini-ADR, des capacités déclarées, et des tests.
- Aucun agent fantôme introduit (nom sans implémentation testée).
- La résolution serveur de l'agent initiateur est couverte par un test.
- Le routage déterministe est testé avant tout fallback LLM.
