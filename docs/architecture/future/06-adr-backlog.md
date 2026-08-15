# Backlog d'ADR proposés

> Les ADR existants (0001-0007, 0023) couvrent les fondations et la conformité. Ce backlog propose les
> décisions architecturales non tranchées que les lots futurs devront résoudre explicitement, sous forme
> d'ADR formels.

## ADR-0008 — Extension du modèle de risque : 3 niveaux → 5 niveaux

- **Contexte** : Le code actuel a trois valeurs de `risk` (`read_only`, `reversible`, `sensitive`
  avec traitement spécial) et `authorizationLevel` 0-3. Le Master Plan §5 décrit 5 niveaux (0-4) avec
  des comportements de gouvernance détaillés (double approbation pour 4, etc.).
- **Décision à prendre** : Quels niveaux 0-4 remplacent read_only/reversible/sensitive et quel est le
  mapping exact ? Quels sont les chemins de transition additive pour le check constraint SQL et les
  invariants de `decideExecution` ?
- **Proposition** : `read_only` → 0, `reversible` → 2, `sensitive` → 3 (requiert humain) avec
  possibilité de monter certaines actions en 4 (critique, double approbation, ou refus structurel).
  Prévoir une fenêtre additive où le CHECK (0|1|2|3|4|read_only|reversible|sensitive) autorise les
  deux jeux de valeurs.
- **Déclencheur** : Lot D1.
- **Groupé avec** : ADR-0009 (Policy versionnée).

## ADR-0009 — Politique versionnée : format et cycle de vie

- **Contexte** : D1 introduit `PolicyVersion` avec règles sur la classification du risque et les
  décisions d'approbation. Le format n'est pas encore figé.
- **Décision** : `PolicyVersion` est-elle une simple agrégation de règles par classe de risque ou un
  véritable langage de règles (decision tables, Rego/OPA) ? Choix : décision table simple avec
  override par actionType pour la v1. OPA est envisagé pour v2 seulement si les règles deviennent
  suffisamment complexes (ex. politiques conditionnelles multi-facteurs).
- **Déclencheur** : Lot D1.

## ADR-0010 — Idempotence des actions extérieures

- **Contexte** : G1 introduit `ExecutionRecord` et `idempotencyKey`. Holding IA a montré
  l'absence d'idempotence comme un problème majeur (double exécution par retry).
- **Décision** : Quel algorithme de génération d'idempotencyKey ? (UUID v4 + hash de l'action
  request). Quand le verrou d'idempotence est-il levé ? (jamais : l'action a son attestation
  unique ; tout retry avec la même key retourne le résultat existant sans ré-exécuter).
- **Déclencheur** : Lot G1.

## ADR-0011 — EventBus technique vs Event Journal

- **Contexte** : Le code actuel (`audit_entries`) est un event journal métier append-only strict.
  OpenJarvis utilise un EventBus pour les traces techniques d'exécution.
- **Décision** : ICOS introduit-il un EventBus/pub-sub pour les notifications intra-process
  (Orchestrateur → Memory, Run → heartbeat, etc.) ? Oui, mais avec une règle explicite : un EventBus
  technique ne remplace et ne duplique jamais l'Event Journal métier. L'Event Journal est écrit avant
  toute notification technique et sert de référence de réconciliation en cas de divergence.
- **Déclencheur** : Lot D2/D4/E1.

## ADR-0012 — Temporal : seuil d'introduction

- **Contexte** : Le premier orchestrateur (D4) fonctionne sans Temporal. Le Master Plan mentionne
  Temporal pour les workflows durables. OpenJarvis a un scheduler persistant mais le scheduler ne
  remplace pas Temporal.
- **Décision** : À partir de quel point le besoin de reprise complexe justifie-t-il Temporal ?
  Proposition : quand une mission dépasse 5 étapes séquentielles OU quand une étape peut être
  bloquée > 1 heure sur une attente externe non bornée OU quand le parallélisme multi-étape avec
  compensation devient nécessaire. En dessous de ces seuils, PostgreSQL + statut de Mission/Task
  est suffisant.
- **Déclencheur** : Lot P1 ou H1+ selon l'observation empirique.

## ADR-0013 — Séparation génération modèle / effet externe

- **Contexte** : D3 introduit l'appel modèle (génération), G1 le passage à effet externe. Le
  retry/fallback de génération ne doit pas provoquer de double action.
- **Décision** : Le résultat du modèle est stocké comme `InvocationResult` (en base) et n'est
  jamais directement exécuté. L'effet externe est une seconde action indépendante avec sa propre
  idempotencyKey, soumise à Policy/Approval. La génération et l'exécution sont donc dédoublées
  temporellement et transactionnellement.
- **Déclencheur** : Lot D3/G1.

## ADR-0014 — SkillsMP : modalité de synchronisation

- **Contexte** : C3 propose la synchronisation read-only depuis SkillsMP. Les candidats arrivent en
  quarantaine.
- **Décision** : Pull (ICOS interroge périodiquement) ou poussée (SkillsMP notifie) ? Proposition :
  pull pour la v1 (ICOS maîtrise son rythme), notification asynchrone optionnelle si SkillsMP
  la supporte. La quarantaine de tout import reste non négociable.
- **Déclencheur** : Lot C3.

## ADR-0015 — Cycle de self-improvement : SkillCandidate → activation

- **Contexte** : Q2 propose la découverte de skills candidates depuis les traces d'exécution. Le
  cycle est : succès répété → evidence → eval → security review → approval → activation.
- **Décision** : Quelle preuve est nécessaire ? (minimum 3 exécutions réussies avec policy
  identique et vérification humaine du résultat). L'évaluation est-elle automatique ? (oui, mais
  la revue de sécurité est humaine). L'activation est-elle humaine ? (oui, toujours).
- **Déclencheur** : Lot Q2, avant K1.

## ADR-0016 — Classification de confidentialité des données IA

- **Contexte** : Les providers/routes exposés par OmniRoute ont des garanties différentes, tandis
  qu'ICOS connaît la classification client/projet de la donnée.
- **Décision** : ICOS définit `PrivacyClass` et `AllowedProviderClasses` comme contraintes métier
  envoyées à OmniRoute. La projection du catalogue peut aider à l'UI, mais OmniRoute conserve le
  catalogue technique et applique le choix dans l'enveloppe autorisée. Les données critiques n'ont
  jamais de fallback vers une classe non autorisée.
- **Déclencheur** : Lot D3/R1.

## ADR-0017 — Heartbeat et proactivité : ne jamais confondre avec une autorité d'exécution

- **Contexte** : P1 propose un heartbeat de réévaluation périodique.
- **Décision** : Le heartbeat produit des observations, pas des ordres. Il peut proposer une
  réévaluation au Policy Engine, mais ne déclenche jamais d'exécution. Toute action de heartbeat
  repasse par l'Orchestrateur avec les mêmes portes de gouvernance.
- **Déclencheur** : Lot P1.

## ADR-0018 — Propriété des credentials IA

- **Contexte** : OmniRoute v3.8.49 possède déjà provider accounts, API keys/OAuth, chiffrement et
  secret management. Les dupliquer dans ICOS créerait deux autorités et augmenterait la surface de
  fuite.
- **Décision** : ICOS ne stocke aucune API key/OAuth provider. Il conserve seulement
  `omnirouteConnectionId`, ownership métier, restrictions client/projet et statut enabled-for-business.
  Les secrets restent dans OmniRoute ou son secret store dédié. `OmniRouteAdapter` s'authentifie à
  OmniRoute avec une identité de service ICOS, sans recevoir les secrets sous-jacents.
- **Déclencheur** : Lot D3.

## ADR-0019 — OmniRoute comme controlled external runtime

- **Contexte** : OmniRoute est déjà un runtime complet de routage multi-provider : comptes,
  credentials, catalogues, sync modèles, quotas/reset, health/latency/pricing, circuit breakers,
  lockouts, retries/fallback, multi-account routing, télémétrie, MCP et evals techniques.
- **Décision** : `AiGatewayPort` est l'abstraction ICOS et `OmniRouteAdapter` son implémentation cible.
  ICOS exprime WHY/WHAT/contraintes métier ; OmniRoute choisit HOW/WHERE/provider/modèle/compte.
  ICOS ne forke ni ne copie le runtime et ne maintient que des overlays métier et projections
  dérivées. Une indisponibilité OmniRoute devient un échec explicite, jamais un bypass provider.
- **Déclencheur** : Lot D3.

## ADR-0020 — Sémantique des coûts IA

- **Contexte** : Le coût estimé OmniRoute peut être un prix catalogue théorique et non une facture
  réellement payée, notamment avec abonnements, crédits, free tiers et modèles locaux.
- **Décision** : Le futur UsageLedger distingue au minimum `estimatedListCost`,
  `providerReportedCost`, `subscriptionIncludedCost`, `incrementalCost` et `savingsEstimate`, avec
  devise, unité, source et confiance. Aucun champ générique `cost` n'est utilisé pour une décision
  financière sans qualification.
- **Déclencheur** : Lot R1.

## ADR-0021 — MCP OmniRoute : séparation lecture et management

- **Contexte** : Le control plane MCP OmniRoute expose health, quotas, modèles, métriques,
  explications, budgets et configuration.
- **Décision** : ICOS expose deux ports : opérations read-only et management write. Tout write est une
  action gouvernée par permissions, Policy/Approval et audit ICOS. Les scopes MCP renforcent mais ne
  remplacent pas l'autorisation ICOS.
- **Déclencheur** : Lot R2.

## ADR-0022 — Séparation evals OmniRoute / evals ICOS

- **Contexte** : OmniRoute évalue routing et aptitude modèle ; ICOS évalue réussite métier.
- **Décision** : Les deux stores et taxonomies restent distincts. Les résultats OmniRoute sont des
  preuves techniques ; les outcomes ICOS alimentent des propositions de policy. Aucun résultat ne
  promeut automatiquement une policy critique.
- **Déclencheur** : Q1/R3.

## ADR-0023 — Fondation de conformité réglementaire

- **Statut** : accepté (voir `docs/decisions/0023-compliance-foundation.md`).
- **Contenu** : Taxonomie de classification C0–C3, invariant de rétention gouvernée, Privacy by Design,
  gate Compliance, registre des traitements, périmètre réglementaire (RGPD, ePrivacy, NIS2, AI Act, DGA).
- **Déclencheur** : COMPLIANCE-0.

## ADR-0024 — Stratégie de chiffrement des données personnelles (C3)

- **Contexte** : COMPLIANCE-2 impose le chiffrement at-rest des colonnes C3. Plusieurs approches
  possibles : chiffrement natif PostgreSQL (pgcrypto), chiffrement applicatif avec libsodium, ou
  chiffrement via un secret store externe (Vault).
- **Décision à prendre** : Quel niveau de chiffrement (colonne, page, disque) ? Où sont les clés ?
  Comment l'accès déchiffré est-il audité ?
- **Proposition** : Chiffrement au niveau colonne via extension PostgreSQL `pgcrypto` avec clé stockée
  dans un vault externe (Vault ou équivalent). ICOS ne possède jamais la clé de déchiffrement en
  mémoire applicative ; les accès passent par une fonction DB SECURITY DEFINER qui audite chaque
  lecture. Alternative acceptable si vault non disponible : clé dérivée d'un secret d'application
  (moins sécurisée, à documenter).
- **Déclencheur** : COMPLIANCE-2, avant Phase E.

## ADR-0025 — Mécanisme de consentement RGPD

- **Contexte** : COMPLIANCE-2 implémente le mécanisme de consentement (Art. 7 RGPD) pour les
  traitements optionnels (recommandations, profiling agent, mémoire conversationnelle).
- **Décision à prendre** : Stockage du consentement (table dédiée vs champ dans user_preferences) ?
  Preuve de consentement (timestamp, finalité, version du document) ? Retrait (désactivation immédiate
  du traitement) ?
- **Proposition** : Table dédiée `user_consents(user_id, purpose, version, granted_at, ip_address,
user_agent)` — append-only, pas de mise à jour. Le retrait ajoute une ligne `revoked_at`. La
  dernière ligne pour chaque `(user_id, purpose)` détermine l'état courant. Aucune donnée sensible
  dans les colonnes (pas d'email, pas de corps de formulaire).
- **Déclencheur** : COMPLIANCE-2.
