# Catalogue détaillé des lots futurs

> Chaque lot est une unité implémentable indépendante. Les lots dont le nom commence par 2B-2 sont
> en cours ailleurs dans ce document et ne sont pas redéfinis. Les préfixes C/D/E/F/G/M/R/P/Q/S/T
> servent au cadrage ; ils ne remplacent pas la numérotation officielle d'ICOS_PROGRESS.md.
>
> Le template est : ID · nom · objectif · raison · prérequis · concepts métier · ports/interfaces ·
> modifications base · événements · permissions/politiques · tests · risques · notes OA/OJ ·
> skills recommandés · Definition of Done · jalon suivant.

---

## C1 — Capability Registry

- **ID proposé** : C1
- **Phase Master Plan** : C ($20), priorité 4 ($31)
- **Objectif** : Créer l'entité domaine `Capability` et son registre versionné, vocabulaire commun
  pour déclarer ce qu'une skill, un agent ou un connecteur peut faire.
- **Raison** : Sans capability explicite et gouvernée, la sélection d'une skill ou d'un agent par
  l'Orchestrateur est une heuristique sans fondement contrôlable — ce qui violerait l'invariant
  "aucune skill n'a autorité sur les permissions". La Capability est le *contrat public* de toute
  compétence ICOS.
- **Prérequis** : fondations (Phase A, terminée). Le Lot 2B-2 n'est pas un prérequis strict pour
  créer le registre mais C1 ne pourra être utilisé par l'Orchestrateur tant que 2B-2 n'a pas posé
  les liens humain↔agent.
- **Concepts métier** :
  - `Capability` : id, name, version (semver avec attribution de version humaine au moment de la
    déprécation/approbation), description, category (cognitive / tool / data / communication / custom),
    inputSchema (JSON Schema décrivant les paramètres acceptés et leur niveau de confidentialité),
    outputSchema, classification (défaut sensitive=false, une capability non classifiée est refusée
    par défaut),
    status (proposed → active → deprecated → retired), retiredAt,
    createdAt, updatedAt.
  - `CapabilityRegistry` : enregistrement, mise à jour de statut, interrogation par catégorie et
    compatibilité de version, recherche de capabilities compatible-level (entier, ex. 1 compatible
    avec ≥1, 2 avec ≥2).
    Historique de statut immuable.
- **Ports / interfaces** :
  - `CapabilityRepositoryPort` (async, `null` pour absent) :
    `findById(id, options?)`, `findByName(name, options?)`, `findByStatus(status)`, `findByCategory(cat)`,
    `save(capability)`, `updateStatus(id, newStatus, reason)`, `searchCompatible(query, minLevel)`.
  - Implémentations mémoire et PostgreSQL, câblage dans Container.
- **Modifications base** :
  - Table `capabilities` : `id uuid PK`, `name text NOT NULL UNIQUE`, `version text NOT NULL`,
    `description text`, `category text NOT NULL CHECK`, `input_schema jsonb`, `output_schema jsonb`,
    `classification text NOT NULL DEFAULT 'unclassified'`, `status text NOT NULL CHECK(...)`,
    `retired_at timestamptz`, `created_at timestamptz DEFAULT now()`, `updated_at timestamptz`.
  - Table `capability_status_history` : `id uuid PK`, `capability_id uuid FK`, `old_status text`,
    `new_status text NOT NULL`, `reason text`, `transitioned_at timestamptz DEFAULT now()`.
  - Migrations additives uniquement (invariant ICOS).
  - Index unique sur `name`, index sur `status`, `category`.
- **Événements** : `capability.created`, `capability.updated`, `capability.status_changed`,
  `capability.retired` (append-only sur `audit_entries` après extension du check constraint).
- **Permissions / politiques** : une capability ne requiert pas d'approbation pour sa *création*
  (elle décrit, n'agit pas), mais son statut `active` et sa *rétractation* nécessitent une action
  humaine (permission `capabilities.manage`). L'extension ultérieure de `PERMISSIONS` dans la matrice
  de rôle est attendue.
- **Tests** :
  - Unitaire : création, unicité de nom, statut lifecycle, historique immuable.
  - Intégration : les deux implémentations (mémoire, PostgreSQL) retournent les mêmes résultats.
  - Comportemental : "Ajouter une nouvelle capability" → "Déprécier une capability".
- **Risques** :
  - Si le registre devient un goulot d'étranglement de review, prévoir un workflow de proposition
    avec approbation différée plutôt que de le rendre bypassable.
  - L'introduction de `inputSchema` prématurément complexe ajoute une dépendance JSON Schema sans
    valeur immédiate — une première version simpliste (description libre) est recommandée.
- **Notes Holding IA** : REUSE — Holding IA n'avait pas de registre de capabilities mais auditait les
  compétences agent par classification ad-hoc. Utile pour la *checklist de revue* de proposition.
- **Notes OpenJarvis** : REUSE — OpenJarvis a un pattern de `capability-validation` à inspecter pour
  ses parseurs de signature et son système de compatibilité. ADAPT — adapter la validation côté
  serveur plutôt que client, sans attribution automatique de permissions.
- **Dev skills recommandées** : Drizzle (schéma existant), Vitest, Zod (déjà dans la stack).
- **Definition of Done** :
  - `Capability` entité domaine avec statuts et schema.
  - Ports async + deux implémentations (memory, pg).
  - Migration additive.
  - Tests unitaires, intégration, 1 test comportemental.
  - Extension `auditEventTypeSchema` avec au moins les événements capability.
  - Aucune modification de la politique existante (decideExecution).
- **Débloque** : C2, D1, D3 (besoin lexique pour `CapabilityRegistry`).

---

## C2 — Skill Registry & Trust Lifecycle

- **ID proposé** : C2
- **Phase Master Plan** : C, priorité 4 ($31)
- **Objectif** : Entité domaine `Skill`, registre versionné, cycle de vie avec trust, provenance et
  activation humaine obligatoire. **Aucune auto-install, auto-activation ou auto-approbation.**
- **Raison** : Les skills sont le moyen d'exécution de l'Orchestrateur. Sans registre gouverné, tout
  agent pourrait accepter et exécuter un bloc configurable non audité — c'est exactement ce que le
  Master Plan interdit ($9).
- **Prérequis** : C1 (une skill déclare les capabilities qu'elle implémente).
- **Concepts métier** :
  - `Skill` : id, name, version, capabilityIds[], matching capabilities registry,
    trustLevel (native | curated | reviewed | quarantined | deprecated), status lifecycle du Master
    Plan $9 (discovered → quarantined → reviewed → approved → active → deprecated → revoked),
    provenance (SkillsMP URI ou ICOS-native), description, entrypoint (référence à une fonction, un
    MCP tool URI, ou un workflow), configSchema (JSON Schema), permissionScope (déclaratif, jamais
    effectif sans validation humaine), metadata, createdAt, attestedAt.
  - `SkillTrustStore` : historique des attestations/revues, score de sécurité agrégé.
  - **Règle absolue** : l'état `active` est exclusivement humain (`permission: skills.manage`).
  - **SkillsMP** est une source de découverte en lecture seule ; les candidats importés arrivent
    toujours en `quarantined`, jamais en `active`.
- **Ports / interfaces** :
  - `SkillRepositoryPort` : CRUD des skills, historique de statut, recherche par capability,
    recherche par trustLevel.
  - `SkillEvaluationPort` (optionnel, Phase Q) : exécute des evals versionnés contre une skill
    candidate, retourne un rapport.
- **Modifications base** :
  - Table `skills` : `id uuid PK`, `name text NOT NULL`, `version text NOT NULL`,
    `capability_ids uuid[]`, `trust_level text NOT NULL`, `status text NOT NULL CHECK(...)`.
    Les contraintes de transition (discovered→quarantined only, active→deprecated only) sont
    applicatives.
  - Table `skill_status_history` : immuable.
  - Table `skill_attestations` : proof hash, attestedBy, attestedAt, attestationType
    (security_review / eval / manual / skillsmp).
- **Événements** : `skill.discovered`, `skill.quarantined`, `skill.reviewed`,
  `skill.activated` (exige action humaine), `skill.deprecated`, `skill.revoked`.
- **Permissions / politiques** :
  - `skills.manage` pour activation, dépréciation et révocation.
  - `skills.propose` pour soumettre un candidat (agent ou humain, passe par le port
    `SkillProposalPort` et aboutit toujours en quarantaine).
  - **Aucune permission** ne permet l'auto-activation.
- **Tests** :
  - Unitaire : lifecycle complet, transition interdite testée pour chaque état.
  - Intégration : SkillsMP discovery crée bien des `quarantined`, jamais `active`.
  - Comportemental : "Découvrir une nouvelle skill" → "L'activer après revue" (CAS 6/7).
- **Risques** :
  - SkillsMP pourrait devenir une dépendance de disponibilité — prévoir un cache local du registre.
  - La quarantaine ne remplace pas une revue de sécurité humaine ; l'automatisation des evals
    (Phase Q) peut assister mais pas décider.
- **Notes Holding IA** : REUSE — Holding IA classifiait les agents par rôle mais sans provenance de
  compétence. Le pattern de *declaredSkills vs actualSkills* est utile : comparer la skill
  déclarée (registre) à la skill réellement invoquée (traces).
- **Notes OpenJarvis** : REUSE — OpenJarvis SkillManager a des patterns concrets pour le manifeste,
  la découverte et le trust (tiers 1-3, attestation, revue). REBUILD — la logique ICOS est plus
  stricte : le trust est décidé par gouvernance humaine, pas par scoring automatique. DISCARD —
  toute auto-activation ou skill-bootstrap non gouverné.
- **Dev skills recommandées** : Drizzle, Zod, Vitest, tests de transitions d'état.
- **Definition of Done** :
  - Skill entité domaine avec lifecycle complet et invariants de transition.
  - Ports async, deux implémentations.
  - SkillsMP import read-only testé.
  - Toute auto-activation refusée structurellement (pas dans le même commit qu'un endpoint
    d'activation).
- **Débloque** : D4 (Orchestrateur), Q2 (Skill Discovery from Traces).

---

## C3 — SkillsMP Discovery (read-only)

- **ID / phase** : C3 · Phase C, priorité 5 du Master Plan §31.
- **Objectif** : Découvrir depuis SkillsMP les descriptions de skills disponibles et créer des
  candidats locaux en quarantaine — sans installer, activer ou exécuter quoi que ce soit.
- **Raison** : SkillsMP est une source de découverte, jamais une autorité d'installation. Une
  connexion read-only permet d'alimenter C2 sans transférer la confiance à un catalogue externe.
- **Prérequis** : C2 ; C1 pour mapper les capabilities externes vers le vocabulaire ICOS.
- **Concepts métier** : `SkillSource`, `DiscoveryCursor`, `SkillCandidate`, provenance externe,
  empreinte du manifeste, statut de synchronisation, conflit de nom/version.
- **Ports / interfaces** : `SkillDiscoverySourcePort.list(cursor)`, `fetchManifest(externalId)`,
  `SkillCandidateImportPort.import(candidate)` ; adapter SkillsMP HTTP ou MCP en lecture seule.
- **Base** : `skill_sources`, `skill_discovery_runs`, `skill_candidates` ou extension explicite des
  tables C2 ; unicité `(source_id, external_id, external_version, content_hash)` ; aucun champ
  `active` modifiable par l'adapter.
- **Événements** : `skill.discovery.started`, `skill.candidate.discovered`,
  `skill.candidate.unchanged`, `skill.discovery.failed`, `skill.candidate.quarantined`.
- **Permissions / policies** : synchronisation déclenchable par `skills.discover`; consultation par
  `skills.read`; activation toujours séparée et réservée à `skills.manage`. Le contenu externe est
  non fiable jusqu'à validation.
- **Tests** : import idempotent ; reprise par cursor ; collision de nom ; manifeste malformé refusé ;
  source indisponible non bloquante ; candidat toujours `quarantined` ; aucune écriture distante.
- **Risques** : compromission du catalogue, typosquatting et dépendance réseau. Contrôles : hash,
  provenance, cache local, allowlist de source, taille limite et scanners.
- **Holding IA** : ADAPT — conserver les briefs/prompts utiles comme candidats sourcés, pas comme
  skills actives.
- **OpenJarvis** : ADAPT — reprendre le pattern de découverte/manifeste du `SkillManager`; DISCARD —
  écriture directe de skills auto-découvertes dans un répertoire exécutable.
- **Skills de développement recommandées** : adapter HTTP/MCP, validation Zod, tests de résilience.
- **Definition of Done** : sync read-only idempotente, provenance et hash persistés, quarantaine
  structurelle, tests offline avec fake source, aucun credential SkillsMP exposé au domaine.
- **Débloque** : alimentation gouvernée du registre et, plus tard, Q2.

---

## D1 — Policy/Approval Engine v2

- **ID proposé** : D1
- **Phase Master Plan** : C/D
- **Objectif** : Étendre `decideExecution` (3 niveaux existing: read_only/reversible/sensitive) vers
  les 5 niveaux (0-4) du Master Plan $5, avec politique versionnée, preview conditionnelle et
  prise de décision humaine explicitement séparée de l'exécution. **Le résultat n'est jamais un
  exécutable mais une décision à interpréter**.
- **Raison** : Le code actuel a 3 niveaux et un traitement spécial `sensitive`. Le Master Plan en
  requiert 5 pour distinguer la lecture (0), les actions préparatoires (1), les actions réversibles
  contrôlées (2), l'approbation humaine obligatoire (3), et le critique/interdit sans procédure
  renforcée (4). Cette extension est le prérequis de l'Orchestrateur (D4) et du Tool Gateway (G1).
- **Prérequis** : C1 (Capability Registry fournit la classification de l'action).
- **Concepts métier** :
  - `PolicyVersion` : id, name, rules, riskLevelMap, scope, version semver, status, authoredBy,
    activatedAt.
  - `PolicyEvaluation` : action/riskLevel + agentLevel + declarativeRequiresApproval + policyRules
    → decision (allowed | denied | requires_preview | requires_human).
  - Le TRE `sensitive` (code actuel) se splitte en niveau 3 (requiert humain) et 4 (strictement
    procédure renforcée + double approbation ou interdiction). `read_only` → 0, `reversible` → 2.
  - **Invariant conservé** : si l'action est niveau ≥3, le requiert humain déclaratif est ignoré
    (l'évaluation de risque prime sur la déclaration).
  - **Preview** : le compute d'une action sans signature et sans commit est possible à n'importe
    quel niveau ; il produit un `PolicyPreviewReport` (action, risque, évaluation, raisons,
    sécurité).
  - L'ambiguïté refuse toujours ; l'état inconnu refuse toujours.
- **Ports / interfaces** :
  - `PolicyEnginePort` : `evaluate(action: ActionEvaluationRequest) → PolicyEvaluation`,
    `preview(action: ActionEvaluationRequest) → PolicyPreviewReport`,
    `getPolicy(scope, version?) → PolicyVersion`.
  - `ApprovalPort` : `submit(actionId, evidence?)`, `decide(approvalId, decision, reason)`,
    `getPending(agent/human) → PendingApproval[]`.
  - Extends `decideExecution` sans le réécrire ; `decideExecution` peut être conservé comme implé
    du niveau de base pour les phases de test.
- **Modifications base** :
  - Table `policy_versions` : `id uuid PK`, `name text`, `rules jsonb`, `risk_level_map jsonb`,
    `version text`, `scope text[]`, `authored_by text`, `activated_at timestamptz`,
    `created_at timestamptz`.
  - Extension `action.risk` de `CHECK` (read_only/reversible/sensitive) → CHECK
    (0/1/2/3/4) avec migration additive et compatibilité temporaire (le code supporte les deux
    durant une fenêtre de transition).
  - `Approval` evolue pour accepter `policyVersion` au moment de la décision (conservant
    l'UNIQUE(actionId) et la finalité du rejected).
- **Événements** : `action.risk.classified`, `policy.evaluated`,
  `policy.evaluated.requires_human`, `policy.evaluated.denied`.
- **Permissions / politiques** :
  - `approvals.decide` existant est conservé pour les niveaux 1-3.
  - Niveau 4 : nécessite `approvals.decide.critical` (ou deux approbations selon ADR).
- **Tests** :
  - Unitaire : chaque niveau 0-4 avec agentLevel 0-3, toutes les combinaisons.
  - Rétrocompatibilité : tout cas qui passait `decideExecution` passe PolicyEngine v2 avec les
    mêmes entrées mappées.
  - Transition `sensitive` → niveau 3 ou 4 : comportement identique documenté.
- **Risques** :
  - La migration du domaine `risk` du code existant vers 0-4 est le risque principal. ADR-0008
    proposé (voir [06](./06-adr-backlog.md)).
  - La transition du check constraint SQL doit être additive (laisser cohabiter l'ancienne
    contrainte via CHECK OR).
- **Notes Holding IA** : REUSE — le `riskLevelMap` sur les actions. ADAPT — les "approval lifecycles"
    de Holding IA avec preview/semaine. Conserver l'immutabilité de la décision rejected du code ICOS.
- **Notes OpenJarvis** : ADAPT — `ApprovalStore` d'OpenJarvis et permission memory sont utiles
    comme patterns pour la persistance des décisions mais ne remplacent pas la version immuable
    dans le journal d'audit ICOS. DISCARD — toute auto-approbation ou permission memory qui
    court-circuiterait la décision souveraine.
- **Dev skills recommandées** : Zod (schemas existants), Vitest, Drizzle.
- **Definition of Done** :
  - `PolicyEnginePort` + implé utilisant l'existant comme base.
  - 5 niveaux supportés, mapping avec l'existant documenté.
  - Transaction additive : le check constraint SQL existant est étendu, pas remplacé.
  - Aucun chemin ne court-circuite la politique.
- **Débloque** : D2, D4, G1.

---

## D2 — Mission, Plan, Run & Event Journal

- **ID proposé** : D2
- **Phase Master Plan** : D
- **Objectif** : Créer les entités `Mission`, `Plan`, `Run` comme état durable, stoppable et
  reprenable — en base relationnelle, pas en mémoire d'exécution.
- **Raison** : L'unité de travail actuelle est `Task` isolée, attachée à un `Agent` direct. La cible
  du Master Plan est une `Mission` qui se décompose en `Plan` → `Task[]`. C'est le squelette de
  l'orchestration. L'état doit être en base, car la conversation n'est jamais la source de vérité
  ($17).
- **Prérequis** : D1 (Policy Engine : chaque Run démarre avec une évaluation de niveau de risque).
- **Concepts métier** :
  - `Mission` : id, title, description, status (draft → active → paused → completed → failed →
    cancelled), source (human | agent | scheduled), originalRequest, conversationId?,
    createdAt, updatedAt. Une Mission annulée interrompt toute Task associée non terminale.
  - `Plan` : id, missionId FK, steps (structuré, pas une string libre), status, agentAssignments,
    skillAssignments, createdAt.
  - `Run` : id, missionId FK, stepId, agentId, actionId?, status (pending → {running, blocked,
    cancelled} → {succeeded, failed, timed_out}), startedAt, completedAt, error?, result.
  - Mission/Plan/Run sont des entités séparées ; le Plan vit et peut être inspecté même avant son
    exécution.
- **Ports / interfaces** :
  - Identique au pattern : `MissionRepositoryPort`, `PlanRepositoryPort`, `RunRepositoryPort`
    (async, `null` pour absent).
- **Modifications base** :
  - Tables `missions`, `plans`, `runs` avec FK cascade sur missions.
  - **UNIQUE(missionId, stepId)** sur `runs` pour empêcher la double exécution d'une étape.
  - Index de recherche par status et agentId.
- **Événements** : `mission.created`, `mission.transitioned`, `plan.generated`,
  `plan.skill_selected`, `run.started`, `run.completed`, `run.failed`. Le check constraint
  `auditEventTypeSchema` est étendu en conséquence.
- **Permissions / politiques** : La création d'une Mission est ouverte à tout agent ou humain
  autorisé. Le runtime `cancelled` nécessite permission (`tasks.write` existant) et vérifie que la
  Mission n'est pas terminée.
- **Tests** :
  - Unitaire : lifecycle Mission complet, annulation en chaîne.
  - Intégration : création Plan + Run, idempotence de step.
  - Comportemental : « Créer une mission sur requête imparfaite » → l'un des 5 scénarios du Master
    Plan $21.
- **Risques** :
  - Laisser `Plan` comme simple JSON conduit à un couplage agent-skill fort. Structurer le Plan
    comme une séquence d'étapes avec capability cible, pas de skill fixe — la résolution
    (skill→capability) est faite au moment du Run, pas avant.
  - `cancelled` doit être broadcast (interrompre les runs actifs). Commencer par un polling au
    prochain tick de l'Orchestrateur.
- **Notes Holding IA** : ADAPT — le pattern de "brief structuré" avec slots est utile pour le Plan.
  REUSE — l'audit de mission timeline dans Holding IA.
- **Notes OpenJarvis** : REUSE — la décomposition traces/EventBus est un pattern pour lier les Runs
    aux événements techniques sans polluer l'Event Journal. DISCARD — toute exécution asynchrone
    non auditable dans le journal métier.
- **Dev skills recommandées** : Drizzle, Vitest, transactions PostgreSQL.
- **Definition of Done** :
  - Mission/Plan/Run entités avec statuts et invariants.
  - Ports async + deux implémentations.
  - Migration additive (tables, index, FK).
  - Annulation d'une Mission : toutes les Tasks non terminales associées passent à cancelled.
  - Aucun accès direct aux providers modèles (réservé à D3).
- **Débloque** : D4, E1, P1.

---

## D3 — AI Gateway / OmniRoute Business Layer

- **ID / phase** : D3 · Phase D.
- **Objectif** : Fournir le plus petit contrat permettant à D4 d'appeler l'IA proprement via
  OmniRoute : `AiGatewayPort`, `OmniRouteAdapter`, requirements métier, corrélation d'usage et
  séparation stricte entre génération et effet externe.
- **Raison** : OmniRoute v3.8.49 possède déjà providers/comptes/credentials, catalogues modèles et
  free tiers, quotas/reset windows, health/latency/pricing, circuit breakers/lockouts, retries,
  fallback, multi-account routing, stratégies, budgets par requête, explications, télémétrie, MCP,
  evals et protocol translation. D3 ne doit en reconstruire aucun.
- **Prérequis** : C1, D1 et D2. C3 est non bloquant.
- **Concepts métier** : `CapabilityRequirement`, `BusinessCriticality`, `PrivacyClass`,
  `QualityThreshold`, `AiBudget`, `AllowedProviderClasses`, `SubscriptionPreference`,
  `AiRoutingPolicy`, `ModelGeneration`, `AiGenerationResult`. `ModelGeneration` produit une
  proposition persistée ; elle n'est jamais un effet externe.
- **Ports / interfaces** :
  - `AiGatewayPort.generate(request) → AiGenerationResult` ;
  - `AiRoutingRequest` contient Mission/Run/Task correlation, requirements, budget, presets
    (`quality-first`, `cheap`, `fast`, `coding`), fallback autorisé/interdit et restrictions ;
  - `OmniRouteAdapter` traduit vers les contraintes par requête OmniRoute et normalise provider,
    modèle, compte, routing explanation, tokens, latence, fallbacks et coûts retournés.
- **Base** : pas de tables `ai_providers`/`ai_models` authoritatives. Table légère
  `ai_generations` : correlation ids, request policy/version, status, proposition/hash, provider/model/
  account réels, route explanation, usage et coûts retournés. `omniroute_connection_id` est une
  référence de configuration, jamais un secret provider.
- **Événements** : `ai.generation.requested/completed/failed`, `ai.routing.constraint_refused`,
  `ai.fallback.observed`. Pas d'événements ICOS prétendant gérer la santé technique du provider.
- **Permissions / policies** : agents/skills n'accèdent ni aux providers, ni comptes, ni credentials,
  ni au MCP management. La policy ICOS choisit les contraintes ; OmniRoute choisit HOW/WHERE. Les
  défenses OmniRoute complètent mais ne remplacent pas Authorization/Policy/Approval ICOS.
- **Tests** : mapping exact des requirements ; preset/budget/fallback on/off ; provider réel audité ;
  OmniRoute indisponible fail-closed ; credential absent de tous les payloads ; proposition persistée ;
  retry d'inférence sans ExecutionRecord ni effet externe ; adapter remplaçable par fake.
- **Risques** : fuite de responsabilité vers ICOS, dépendance stratégique OmniRoute, guardrail
  OmniRoute fail-open, coût mal interprété. Contrôles : contract tests, matrice de propriété, aucune
  route directe provider, coûts qualifiés ultérieurement dans R1.
- **Holding IA** : ADAPT la corrélation d'usage ; DISCARD les secrets dans workflows.
- **OpenJarvis** : REUSE le pattern adapter/port ; DISCARD tout runtime/provider direct.
- **Skills de développement recommandées** : ports/adapters, Zod, contract testing, sécurité.
- **Definition of Done** : D4 peut générer via `AiGatewayPort`; OmniRoute reste seule vérité
  technique ; aucun registre/monitor/router technique ICOS ; résultat réel corrélé et proposition
  persistée ; aucun credential provider stocké par ICOS.
- **Débloque** : D4.

---

## D4 — Orchestrateur v1

- **ID / phase** : D4 · Phase D, priorité 6 du Master Plan §31.
- **Objectif** : Lire une Mission active, produire un Plan structuré, résoudre agents/skills actifs,
  exécuter les steps cognitifs, persister chaque Run et restituer un résultat — sans effet externe
  direct, réservé à G1.
- **Raison** : Le système actuel ne coordonne que des Tasks isolées. D4 devient le premier moteur du
  cycle Mission → Plan → délégation → vérification → restitution tout en restant stoppable et
  reprenable depuis PostgreSQL.
- **Prérequis** : C2, D1, D2 et D3. C3 est recommandé pour alimenter le registre, mais une skill
  native active suffit au premier test.
- **Concepts métier** : `PlanningRequest`, `PlanStep` (capability requise, dépendances, input refs,
  expected output, risk hint), `Assignment`, `RunReport`, `VerificationResult`. Le Plan référence des
  capabilities ; la skill concrète est résolue au démarrage du Run parmi les versions actives.
- **Ports / interfaces** : `OrchestratorPort.start(missionId)`, `resume(missionId)`,
  `pause(missionId)`, `cancel(missionId)`, `status(missionId)` ; consomme Mission/Plan/Run repos,
  Skill/Capability registries, PolicyEnginePort et AIModelPort ; aucune interface provider/tool
  externe directe.
- **Base** : aucune nouvelle table obligatoire si D2 couvre plan steps et assignments ; ajouter
  seulement un checkpoint/version optimiste si absent. Les résultats volumineux restent référencés,
  pas copiés dans l'état Mission.
- **Événements** : `orchestrator.mission_started`, `plan.generated`, `assignment.selected`,
  `run.started`, `run.blocked`, `run.verified`, `run.completed`, `mission.paused`, `mission.completed`.
- **Permissions / policies** : policy évaluée pour chaque step et réévaluée avant transition vers un
  futur effet externe ; une skill inactive/révoquée ou une capability inconnue bloque le Run ;
  annulation de Mission prime sur une approbation antérieure.
- **Tests** : CAS 1, 3, 7, 11, 12, 15 ; plan déterministe avec fake model ; reprise après crash ;
  dépendance de step ; skill révoquée entre planification et run ; annulation concurrente ; limite
  de profondeur/boucle.
- **Risques** : récursion infinie, plan trop libre, perte de checkpoint, orchestration bruyante,
  contournement tool. Contrôles : limite de steps/tours, schéma strict, checkpoints transactionnels,
  délégation invisible et absence structurelle de tool provider.
- **Holding IA** : ADAPT — briefs/slots et timeline ; DISCARD — n8n comme orchestrateur central.
- **OpenJarvis** : ADAPT — traces par turn/step, loop guards et stall detection ; DISCARD — exécution
  non gouvernée ou état uniquement en mémoire.
- **Skills de développement recommandées** : state machines, TDD, transactions et tests de reprise.
- **Definition of Done** : Mission simple planifiée et terminée ; pause/cancel/reprise prouvés ;
  chaque step audité ; aucun effet externe direct ; aucun provider direct ; CAS associés passants.
- **Débloque** : F1, G1, M1 et P1.

---

## E1 — Memory/Context Port + provenance

- **ID / phase** : E1 · Phase E.
- **Objectif** : Introduire un port de mémoire non-authoritative pour stocker et retrouver du
  contexte avec source, confiance, date, validité, scope et possibilité de correction.
- **Raison** : L'Orchestrateur doit retrouver du contexte sans confondre souvenir dérivé, preuve et
  état métier. La frontière doit exister avant toute optimisation RAG.
- **Prérequis** : D2 ; D4 est consommateur mais peut être développé en parallèle sur un fake.
- **Concepts métier** : `MemoryRecord`, `Provenance`, `Confidence`, `ValidityWindow`, `MemoryScope`
  (session, working, project, client, long-term, decision), `Correction` et `RetrievalResult`.
- **Ports / interfaces** : `MemoryContextPort.store(record)`, `retrieve(query, filters)`,
  `correct(recordId, correction)`, `invalidate(recordId, reason)`, `delete(recordId)` ; résultats
  classés mais toujours accompagnés de provenance.
- **Base** : `memory_records`, `memory_corrections`, `memory_sources`; index par scope, subject et
  validité. Les références vers des entités métier ne copient pas leur état authoritative.
- **Événements** : `memory.stored`, `memory.retrieved`, `memory.corrected`, `memory.invalidated`.
- **Permissions / policies** : la portée limite les lectures ; les secrets ne sont jamais mémorisés ;
  la mémoire n'autorise ni action ni permission ; PostgreSQL métier gagne en cas de conflit.
- **Tests** : CAS 8 et 22 ; provenance manquante refusée ; correction versionnée ; scope isolé ;
  enregistrement expiré exclu ; parité repositories mémoire/PostgreSQL.
- **Risques** : fuite inter-client, donnée périmée et mémoire prise pour vérité. Contrôles : filtres de
  scope obligatoires, validité explicite et libellé `derived` dans les réponses.
- **Holding IA** : REBUILD — pas de couche mémoire exploitable comme contrat durable.
- **OpenJarvis** : REUSE du contrat `MemoryBackend`/`RetrievalResult`; ADAPT vers ports async et
  PostgreSQL ; DISCARD des stores in-memory comme persistance de production.
- **Skills de développement recommandées** : modélisation de provenance, Drizzle, tests d'isolation.
- **Definition of Done** : contrat et deux implémentations, correction/versionnement, aucun accès de
  policy à Memory, CAS 8/22 passants.
- **Débloque** : E2, F1 et amélioration du contexte D4.

---

## E2 — Ingestion documentaire + PostgreSQL FTS

- **ID / phase** : E2 · Phase E.
- **Objectif** : Ingérer des documents, les découper avec provenance par chunk et fournir une
  recherche lexicale PostgreSQL FTS avant toute base vectorielle.
- **Raison** : Le FTS couvre le premier besoin RAG avec la stack existante, sans service ni modèle
  d'embedding obligatoire.
- **Prérequis** : E1 ; scanners de sécurité minimaux disponibles ou implémentés dans ce lot.
- **Concepts métier** : `DocumentSource`, `IngestionJob`, `Chunk`, `ChunkPolicy`, `RetrievalQuery` et
  `Citation`; déduplication par hash de contenu.
- **Ports / interfaces** : `DocumentIngestionPort.ingest(source, policy)`, `reindex(sourceId)`,
  `remove(sourceId)` ; `TextRetrievalPort.search(query, scope, topK)`.
- **Base** : `memory_documents`, `memory_chunks`, colonne `tsvector`, index GIN, hash unique par
  source/version/chunk ; jobs et erreurs d'ingestion persistés.
- **Événements** : `document.ingestion.started/completed/failed`, `document.reindexed`,
  `context.retrieved`.
- **Permissions / policies** : fichiers secrets et contenu hors scope bloqués ; contenu externe
  marqué non fiable ; les instructions trouvées dans un document ne deviennent jamais des commandes.
- **Tests** : qualité FTS de référence, citations, déduplication, réindexation, suppression, injection
  hostile, fichiers sensibles, limites de taille et encodage.
- **Risques** : prompt injection et perte de provenance. Contrôles : séparation
  instructions/contenu, scanners, citations obligatoires et ingestion idempotente.
- **Holding IA** : ADAPT des documents/prompts utiles comme corpus sourcé, jamais comme autorité.
- **OpenJarvis** : REUSE du chunking, `ingest_path`, attribution de source et budgets de contexte ;
  REBUILD avec Postgres FTS au lieu de SQLite FTS5.
- **Skills de développement recommandées** : PostgreSQL FTS, sécurité d'ingestion, benchmarks RAG.
- **Definition of Done** : corpus test indexé/retrouvé avec citations, provenance complète, scanner
  actif et benchmark initial archivé.
- **Débloque** : E3 et conversation contextualisée.

---

## F1 — Contrat conversationnel v1

- **ID / phase** : F1 · Phase F.
- **Objectif** : Transformer une instruction naturelle en intention et commande de Mission, avec
  résolution de contexte, clarification minimale et réponse adaptée au niveau de détail demandé.
- **Raison** : L'utilisateur parle à ICOS, pas à une collection d'agents. Le contrat doit être stable
  avant les canaux supplémentaires.
- **Prérequis** : D4 ; E1 recommandé pour le contexte ; D3 pour l'inférence via OmniRoute.
- **Concepts métier** : `ConversationTurn`, `Intent`, `ResolvedReference`, `Clarification`,
  `ResponseEnvelope`, `FactQualification` (fait vérifié, inférence, hypothèse, proposition, action
  préparée/exécutée/bloquée).
- **Ports / interfaces** : `ConversationPort.handle(turn)`, `IntentResolverPort.resolve(turn,
  context)`, `ResponsePresenterPort.present(result, detailLevel)` ; aucune dépendance à un canal.
- **Base** : conversations/tours si non couverts par l'auth existante ; référence à Mission et
  classification de chaque assertion ; pas de copie des secrets ni du state métier.
- **Événements** : `conversation.turn.received`, `intent.resolved`, `clarification.requested`,
  `response.presented`.
- **Permissions / policies** : l'intention ne vaut jamais autorisation ; une formulation impérative ne
  contourne pas D1 ; références ambiguës sensibles exigent clarification.
- **Tests** : CAS 1, 12, 13, 15 ; instruction ambiguë ; changement de détail ; contradiction ; fait vs
  hypothèse ; continuité après plusieurs jours.
- **Risques** : questions excessives, certitude feinte et fuite de détails internes. Contrôles : seuil
  de clarification, qualification des affirmations, synthèse unique.
- **Holding IA** : REUSE des briefs structurés et slots ; ADAPT des scénarios CRM.
- **OpenJarvis** : ADAPT du contexte injecté et des envelopes de channel ; pas du runtime agent.
- **Skills de développement recommandées** : Zod, evals conversationnelles et conception de prompts.
- **Definition of Done** : instructions CAS converties en commandes typées, pas de bruit de
  délégation, assertions qualifiées et comportement canal-agnostique.
- **Débloque** : M1, I1 et expérience « parler à un employé ».

---

## G1 — Tool/MCP Gateway + ExecutionRecord

- **ID / phase** : G1 · Phase G.
- **Objectif** : Créer le passage unique de tout effet externe, avec Policy/Approval, revalidation,
  idempotence et audit juste avant la sortie.
- **Raison** : L'approbation n'est pas l'exécution et un timeout/retry ne doit jamais doubler un
  effet. MCP transporte l'appel mais ne décide pas de son autorisation.
- **Prérequis** : D1, D2 et D4.
- **Concepts métier** : `ToolDescriptor`, `ToolInvocation`, `ExecutionRecord`, `IdempotencyKey`,
  `ExecutionAttempt`, `ExternalResult`, `HumanPreview`; statuts requested → blocked/awaiting_approval
  → executing → succeeded/failed/cancelled.
- **Ports / interfaces** : `ToolGatewayPort.describe`, `preview`, `request`, `execute`; adapters MCP,
  HTTP/SDK ou interne ; aucun agent ne reçoit l'adapter concret.
- **Base** : `tool_descriptors`, `execution_records`, `execution_attempts`; contrainte unique sur
  `idempotency_key`; version optimiste ; résultat/hash stocké pour répondre aux retries.
- **Événements** : `tool.requested`, `tool.blocked`, `execution.started/succeeded/failed`,
  `execution.duplicate_suppressed`, `approval.revalidated`.
- **Permissions / policies** : capability et actionType enregistrés ; policy vérifiée à la demande et
  juste avant effet ; rejection/cancel/expiry terminaux ; MCP metadata ne vaut jamais permission.
- **Tests** : CAS 2, 4-7, 9, 17 ; deux workers ; timeout après succès distant ; rejet concurrent ;
  tool inconnu ; idempotencyKey réutilisée avec payload différent refusée.
- **Risques** : double effet, action tardive, tool smuggling et secrets en arguments. Contrôles :
  transaction/lease, schemas stricts, scanners et allowlist.
- **Holding IA** : REUSE preview/approve/edit/reject ; REBUILD avec atomicité et idempotence ;
  DISCARD approved=executed.
- **OpenJarvis** : REUSE du pattern tool adapter et scanners ; DISCARD des exécuteurs null/silencieux.
- **Skills de développement recommandées** : transactions, idempotence distribuée, MCP, security.
- **Definition of Done** : aucun connecteur ne contourne le Gateway ; CAS d'idempotence/race passants ;
  audit avant/après chaque tentative ; effet et approbation distincts.
- **Débloque** : G2, M1 et tous les connecteurs.

---

## G2 — Premier connecteur métier

- **ID / phase** : G2 · Phase G, priorité 8 du Master Plan §31.
- **Objectif** : Livrer un vertical slice de lecture de dossier client, préparation puis envoi de
  devis derrière G1, désactivé par défaut.
- **Raison** : Sans intégration réelle, l'Orchestrateur reste une démonstration. Un seul connecteur
  étroit permet de prouver le contrat avant d'étendre Gmail/GitHub/Dolibarr/n8n.
- **Prérequis** : G1, F1 et une source métier choisie explicitement pour M1.
- **Concepts métier** : `ClientFileRef`, `QuoteDraft`, `QuoteDeliveryRequest`; le CRM/DigitalOS reste
  externe et n'est jamais importé dans le domaine ICOS.
- **Ports / interfaces** : `ClientFileTool.read`, `QuoteTool.prepare`, `QuoteTool.send`; adapter MCP ou
  API dédié derrière ToolGatewayPort.
- **Base** : configuration d'intégration et références externes opaques ; aucun miroir CRM complet ;
  réutilise ExecutionRecord.
- **Événements** : `client_file.read`, `quote.prepared`, `quote.sent`, `integration.failed`.
- **Permissions / policies** : intégration disabled by default ; scopes minimaux ; read niveau 0,
  préparation niveau 1, envoi classé selon D1 et soumis à approval si requis.
- **Tests** : M1, CAS 1-7, indisponibilité, données partielles, timeout distant, révocation credential.
- **Risques** : choix du CRM trop tôt, fuite client et coupling API. Contrôles : port étroit, fake
  contractuel, configuration par environnement et secret hors domaine.
- **Holding IA** : REUSE scénarios CRM et UX WhatsApp approve/edit/reject ; DISCARD dépendance domaine
  directe à Supabase/n8n/Meta/Twilio.
- **OpenJarvis** : REUSE du pattern connector/channel désactivé par défaut.
- **Skills de développement recommandées** : contract tests, API adapter, sécurité des données client.
- **Definition of Done** : scénario M1 passe avec sandbox/fake et environnement autorisé ; aucune
  dépendance du domaine au fournisseur ; intégration désactivée sans configuration.
- **Débloque** : M1 puis vertical slices H1.

---

## Q1 — Behavioral & Evaluation Harness

- **ID / phase** : Q1 · transversal D-F / Quality.
- **Objectif** : Automatiser les tests comportementaux end-to-end et créer un `EvaluationStore`
  minimal pour comparer modèles, skills et policies avec jeux versionnés.
- **Raison** : Les tests unitaires ne prouvent ni la continuité ni l'absence de double action. Le
  routing futur ne peut apprendre sans mesures comparables.
- **Prérequis** : contrats C1-D4 ; les scénarios peuvent utiliser des fakes avant implémentation.
- **Concepts métier** : `EvaluationSuite`, `EvaluationCase`, `EvaluationRun`, `Score`, `Evidence`,
  `Baseline`, `Regression`.
- **Ports / interfaces** : `EvaluationRunnerPort.run(suite, subject)`, `EvaluationStorePort.record`,
  `compare`; adapters fake-model/fake-tool et judge optionnel soumis au même AI Runtime.
- **Base** : `evaluation_suites`, `evaluation_cases`, `evaluation_runs`, `evaluation_scores` ; version
  du modèle/skill/policy/prompt et seed obligatoires.
- **Événements** : `evaluation.started/completed/failed`, `regression.detected`.
- **Permissions / policies** : données de test anonymisées ; un score ne modifie ni ModelPolicy ni
  Skill status ; activation/revue séparée.
- **Tests** : les 24 cas de [10-behavioral-tests.md](./10-behavioral-tests.md), déterminisme des fakes,
  reprise d'eval, comparaison baseline et fuite de données.
- **Risques** : juge biaisé, benchmark gaming et coût. Contrôles : scorers déterministes prioritaires,
  corpus versionné, échantillons et budgets.
- **Holding IA** : ADAPT les scénarios métier comme cas d'eval.
- **OpenJarvis** : REUSE séparation evals/correctness et benchmarks/latency, configs versionnées et
  traces ; ADAPT aux invariants ICOS.
- **Skills de développement recommandées** : Vitest, fixtures, eval design et statistiques simples.
- **Definition of Done** : suite versionnée exécutable en CI sur fakes, résultats persistés,
  régressions visibles et aucune activation automatique.
- **Débloque** : M1, Q2 et R3.

---

## M1 — Premier ICOS semi-autonome

- **ID / phase** : M1 · jalon transversal D-G.
- **Objectif** : Prouver le scénario Dupont de bout en bout décrit dans
  [11-first-autonomous-icos.md](./11-first-autonomous-icos.md).
- **Raison** : Valider une utilité réelle et gouvernée avant les technologies avancées.
- **Prérequis** : D1-D4, Q1, F1, G1-G2 ; E1 minimal recommandé.
- **Concepts métier / ports** : réutilise exclusivement les contrats livrés ; n'introduit aucun
  nouveau domaine ni bypass de démonstration.
- **Base / événements** : aucune nouvelle table ; la chronologie doit être reconstructible depuis
  Event Journal, Mission/Run, invocations IA et ExecutionRecord.
- **Permissions / policies** : envoi jamais avant approval si classé sensible ; annulation et rejet
  priment ; provider uniquement via OmniRoute.
- **Tests** : CAS 1-14 au minimum, interruption/redémarrage, timeout après envoi et status concis.
- **Risques** : contourner les contrats pour accélérer la démo. Contrôle : DoD interdit toute voie
  spéciale M1.
- **Holding IA / OpenJarvis** : réutilisation uniquement via les patterns déjà reconstruits.
- **Skills de développement recommandées** : e2e, testcontainers, vérification avant completion.
- **Definition of Done** : les 12 critères « usable ICOS v1 » sont démontrés dans le périmètre M1,
  audit complet et aucune double action.
- **Débloque** : R1, P1 et H1.

---

## R1 — AI Business Routing Policy & Usage Ledger

- **ID / phase** : R1 · extension Phase G/K préparatoire.
- **Objectif** : Enrichir D3 avec les overlays business d'abonnement/budget, un UsageLedger corrélé et
  des policies de contraintes envoyées à OmniRoute — sans routeur technique ICOS.
- **Raison** : Exploiter abonnements payés, API, crédits, free tiers et modèles locaux selon les
  contrats métier, tout en laissant OmniRoute gérer comptes, quotas, reset windows et choix de route.
- **Prérequis** : D3 et invocations observables.
- **Concepts métier** : `SubscriptionBusinessMetadata` (owner, cost center, client/project eligibility,
  preference), `BusinessBudget`, `AiRoutingPolicy`, `UsageEntry`; le ledger distingue
  `estimatedListCost`, `providerReportedCost`, `subscriptionIncludedCost`, `incrementalCost` et
  `savingsEstimate`. Aucun coût OmniRoute n'est présumé facturé.
- **Ports / interfaces** : `AiPolicyPort.resolve(taskContext) → AiRoutingPolicy`,
  `BusinessUsageLedgerPort.record(result, correlation)` ; `AiGatewayPort` envoie la policy à
  OmniRoute. Aucun `ModelRouterPort` ni sélection de candidat côté ICOS.
- **Base** : metadata business des connexions/subscriptions, budgets et `ai_business_usage_ledger`
  append-only ; aucune copie de compte provider, quota ou credential.
- **Événements** : `ai.business_policy.resolved`, `ai.usage.correlated`, `ai.budget.blocked`.
- **Permissions / policies** : humains autorisés gèrent ownership/restrictions/budgets ; l'agent
  fournit les requirements, jamais provider/modèle/compte. Free tier et fallback sont des contraintes
  métier explicites.
- **Tests** : budget strict, free tier interdit, préférence abonnement puis crédits, coût inclus vs
  incrémental, résultat sans coût provider, rapprochement Mission/Run/Task.
- **Risques** : traiter estimation comme facture, dupliquer les quotas OmniRoute, rendre une préférence
  business obligatoire alors qu'aucune route ne convient.
- **Holding IA** : REBUILD.
- **OpenJarvis** : ADAPT l'analyse de classe de tâche comme input de policy, pas son routeur.
- **Skills recommandées** : ledger, money semantics et règles pures.
- **Definition of Done** : coûts qualifiés, policy métier explicable, aucune sélection technique ICOS,
  aucun compte/quota/secret dupliqué.
- **Débloque** : R2.

---

## R2 — OmniRoute Operational Projections & Reactions

- **ID / phase** : R2 · extension AI Gateway.
- **Objectif** : Consommer health, quotas, fenêtres de reset, latence, catalogues, route explanations,
  budgets et métriques depuis les API ou le MCP OmniRoute ; en dériver uniquement des réactions métier.
- **Raison** : OmniRoute possède déjà monitor, lockouts, circuit breakers, retries et fallback. ICOS a
  besoin de visibilité et de politiques de réaction, pas d'un second moteur.
- **Prérequis** : R1 et contrats OmniRoute observables.
- **Concepts métier** : `OmniRouteProjection` datée, `OperationalConstraint`, `BusinessReaction`
  (pause mission, alerte budget, refuser une classe, demander validation). Les projections sont
  dérivées, expirantes et jamais authoritative.
- **Ports / interfaces** : `OmniRouteOperationsPort.readModels/readHealth/readQuotas/readMetrics/
  explainRoute`; management séparé dans `OmniRouteManagementPort` et soumis à Policy/permissions.
  Pas de `ModelHealthMonitor`, `FallbackPlanner` ou `CircuitState` ICOS.
- **Base** : cache/projections TTL optionnels et cursors de sync ; OmniRoute reste source. Pas de
  tables de health/quota prétendant faire autorité.
- **Événements** : `omniroute.projection.refreshed/stale`, `ai.business_reaction.triggered`,
  `omniroute.management.requested`.
- **Permissions / policies** : tools MCP read-only distincts des writes ; toute configuration write
  est une action ICOS gouvernée. Une projection stale ne peut élargir la policy.
- **Tests** : projection expirée, MCP indisponible, quota/health contradictoire, route explanation,
  write sans permission, fail-open guardrail OmniRoute traité comme insuffisant.
- **Risques** : cache pris pour vérité, duplication accidentelle, management MCP contournant Policy.
- **Holding IA** : REBUILD.
- **OpenJarvis** : REUSE pattern MCP adapter, pas fallback router.
- **Skills recommandées** : MCP, caching TTL et policy testing.
- **Definition of Done** : visibilité opérationnelle sans monitor maison, reads/writes séparés,
  réactions métier testées, aucune duplication du routage OmniRoute.
- **Débloque** : R3 et exploitation transparente.

---

## P1 — Proactivity Engine + heartbeat gouverné

- **ID / phase** : P1 · Phase E/F puis K.
- **Objectif** : Réévaluer périodiquement missions, tâches, deadlines, approvals, failures et
  follow-ups pour produire observations, propositions ou commandes gouvernées.
- **Raison** : ICOS doit agir comme un collaborateur permanent, sans transformer la proactivité en
  autorité autonome.
- **Prérequis** : D1, D2, D4 et M1 ; scheduler fake ou déclenchement manuel suffit initialement.
- **Concepts métier** : `Heartbeat`, `ProactiveObservation`, `FollowUpCandidate`, `DeduplicationKey`,
  `QuietHours`, `AttentionBudget`.
- **Ports / interfaces** : `ProactivityPort.evaluate(now, scopes)`, `MissionQueryPort`,
  `NotificationProposalPort`; aucune méthode d'effet externe direct.
- **Base** : `heartbeat_runs`, `proactive_observations`, `follow_up_candidates`; déduplication et
  statut dismissed/acted/expired.
- **Événements** : `heartbeat.started/completed`, `follow_up.proposed/suppressed`,
  `deadline.at_risk`.
- **Permissions / policies** : heartbeat ne possède aucune permission ; toutes les commandes repassent
  D1/D4/G1 ; quiet hours et fréquence configurées par humain.
- **Tests** : CAS 16 ; approbation en attente ; mission annulée ; doublon ; quiet hours ; échec répété ;
  absence de travail ; heartbeat concurrent.
- **Risques** : spam, auto-approbation implicite et dépendance à la mémoire. Contrôles : budget
  d'attention, PostgreSQL comme source et séparation observation/exécution.
- **Holding IA** : ADAPT client×action autonomy et previews.
- **OpenJarvis** : ADAPT la boucle collect→classify→propose ; DISCARD tiers trivial auto-approuvé et
  permission memory non versionnée.
- **Skills de développement recommandées** : règles temporelles, déduplication et UX notifications.
- **Definition of Done** : les six catégories sont réévaluées, aucune action directe, CAS 16 passant
  et toutes les propositions explicables.
- **Débloque** : S1 et autonomie avancée K1.

---

## S1 — Scheduler persistant

- **ID / phase** : S1 · support Phase E/F.
- **Objectif** : Déclencher durablement des tâches `once`, `interval` et `cron`, notamment le
  heartbeat, avec lease et anti-double-run.
- **Raison** : La proactivité doit survivre aux redémarrages, mais ne justifie pas Temporal.
- **Prérequis** : P1 et D2.
- **Concepts métier** : `Schedule`, `ScheduledTrigger`, `Lease`, `ScheduleRun`; le payload référence
  une commande Orchestrateur, jamais un prompt libre exécutable directement.
- **Ports / interfaces** : `SchedulerPort.create/pause/resume/cancel/list`, `DueTriggerClaimPort` et
  `OrchestratorCommandPort.enqueue`.
- **Base** : `schedules`, `schedule_runs`, lease owner/expiry, contrainte unique schedule+fireTime.
- **Événements** : `schedule.created/paused/resumed/cancelled`, `schedule.triggered/skipped/failed`.
- **Permissions / policies** : création/modification humaine ou commande agent gouvernée ; déclencheur
  ne contourne pas Policy ; timezone/DST explicites.
- **Tests** : deux workers, crash après claim, DST, missed run, pause, cancel, once idempotent.
- **Risques** : double exécution et dérive horaire. Contrôles : lease DB, clé de feu unique, horloge
  injectable.
- **Holding IA** : REBUILD.
- **OpenJarvis** : REUSE modèle cron/interval/once et store ; ADAPT exécution vers l'Orchestrateur ;
  DISCARD appel direct `system.ask(prompt)`.
- **Skills de développement recommandées** : scheduling, concurrence PostgreSQL, fake clocks.
- **Definition of Done** : reprise après crash, aucune double commande et heartbeat durable.
- **Débloque** : proactivité de production ; pas Temporal automatiquement.

---

## Q2 — Skill Discovery from Traces

- **ID / phase** : Q2 · préparation Phase K.
- **Objectif** : Détecter les séquences réussies répétées et créer un `SkillCandidate` avec preuves,
  sans installation ni activation automatique.
- **Raison** : L'amélioration continue doit être proposée à partir du réel tout en restant gouvernée.
- **Prérequis** : C2, Q1, traces D4/G1 et volume suffisant.
- **Concepts métier** : `SkillCandidate`, `TracePattern`, `EvidenceBundle`, `SecurityReview`,
  `ActivationProposal`; cycle succès → candidate → evidence → eval → revue → approval → activation.
- **Ports / interfaces** : `TraceMiningPort.findPatterns`, `SkillCandidatePort.propose`,
  `SecurityReviewPort.review`, `SkillEvaluationPort.evaluate`.
- **Base** : `skill_candidates`, `skill_candidate_evidence`, `security_reviews`, liens vers eval runs ;
  aucun write direct vers skill active.
- **Événements** : `skill_candidate.detected/evaluated/reviewed/approved/rejected/promoted`.
- **Permissions / policies** : seule une approbation humaine `skills.manage` promeut ; candidate ne
  peut modifier permissions, guardrails ou son propre reviewer.
- **Tests** : moins de trois succès, échecs mixtes, traces de policies différentes, tentative
  d'auto-promotion, preuve supprimée, réévaluation après nouvelle version.
- **Risques** : corrélation prise pour compétence, poisoning des traces et auto-modification.
- **Holding IA** : ADAPT declared vs actual skills.
- **OpenJarvis** : ADAPT `discover_from_traces`; DISCARD écriture immédiate du manifeste dans un
  répertoire exécutable.
- **Skills de développement recommandées** : trace mining, sécurité supply-chain et eval design.
- **Definition of Done** : pipeline complet jusqu'à proposition d'activation, frontière humaine
  testée structurellement, aucune auto-activation.
- **Débloque** : K1.

---

## R3 — Evals métier vers policy de routage

- **ID / phase** : R3 · préparation Phase K.
- **Objectif** : Exploiter les résultats `EvaluationStore` ICOS pour proposer des seuils/préférences
  métier transmis à OmniRoute, sans classer ni router techniquement les modèles dans ICOS.
- **Raison** : OmniRoute peut conclure « meilleur pour coding » ; ICOS doit mesurer « devis correct,
  conforme et accepté ». Les deux evals sont complémentaires et restent séparées.
- **Prérequis** : R2, Q1, corpus versionné et minimum d'échantillons.
- **Concepts métier** : `TaskClass`, `BusinessOutcomeMetric`, `QualityThresholdProposal`,
  `AiPolicyProposal`, `ConfidenceInterval`, `RoutingExperiment`; activation et rollback gouvernés.
- **Ports / interfaces** : `BusinessQualityPort.evaluate`, `AiPolicyProposalPort.propose/review` ; une
  policy approuvée enrichit l'`AiRoutingRequest` envoyé à OmniRoute. Les evals/routing explanations
  OmniRoute peuvent être des preuves, pas l'autorité du résultat métier.
- **Base** : résultats métier bruts, agrégats, expériences et proposals versionnés ; aucun mapping
  authoritative query-class→model côté ICOS.
- **Événements** : `business_evaluation.completed`, `ai_policy.proposed/approved/activated/rolled_back`.
- **Permissions / policies** : aucune auto-promotion d'une policy critique ; privacy, provider classes
  et hard gates ne sont jamais assouplis par score.
- **Tests** : échantillon insuffisant, divergence eval OmniRoute/ICOS, dérive, rollback, metric gaming,
  policy critique sans approbation, modèle local techniquement bon mais résultat métier insuffisant.
- **Risques** : confusion eval technique/métier, feedback loop et auto-promotion.
- **Holding IA** : REBUILD.
- **OpenJarvis** : ADAPT `LearnedRouterPolicy` uniquement comme pattern d'observation/min_samples ;
  DISCARD mapping actif automatique.
- **Skills recommandées** : eval design, statistiques et governance.
- **Definition of Done** : policy proposée depuis outcomes métier, revue et réversible ; OmniRoute
  conserve tout scoring et choix technique.
- **Débloque** : optimisation avancée K1.

---

## E3 — Retrieval hybride conditionnel

- **ID / phase** : E3 · Phase E, conditionné par benchmark.
- **Objectif** : Ajouter embeddings/pgvector et fusion sparse+dense uniquement si E2 ne satisfait pas
  le seuil de retrieval défini.
- **Raison** : La similarité sémantique peut améliorer le rappel, mais ajoute coût, modèle et
  réindexation ; elle doit prouver sa valeur.
- **Prérequis** : E2, D3 pour embeddings via OmniRoute, benchmark Q1.
- **Concepts métier** : `EmbeddingProfile`, `VectorIndexVersion`, `FusionPolicy`; aucun changement de
  vérité/provenance.
- **Ports / interfaces** : extension d'implémentation de TextRetrievalPort ;
  `EmbeddingPort.embed` derrière AI Runtime ; fusion RRF.
- **Base** : extension pgvector, embeddings versionnés par modèle/dimension, jobs de réindexation.
- **Événements** : `embedding.generated`, `vector_index.rebuilt`, `retrieval.benchmark.completed`.
- **Permissions / policies** : texte envoyé pour embedding soumis à privacy ModelPolicy ; local si
  exigé ; suppression propage aux vecteurs.
- **Tests** : benchmark FTS vs hybride, changement modèle, dimension incompatible, reindex, deletion.
- **Risques** : lock-in embeddings, fuite et index obsolète.
- **Holding IA** : REBUILD.
- **OpenJarvis** : REUSE RRF/over-fetch ; REBUILD FAISS/BM25 avec Postgres+pgvector persistant.
- **Skills de développement recommandées** : pgvector, IR metrics et data migrations.
- **Definition of Done** : gain minimal prédéfini démontré ; sinon lot abandonné documenté sans
  introduire pgvector.
- **Débloque** : E4 seulement si relations riches restent insuffisantes.

---

## H1 — DigitalOS/Polivia, première vertical slice

- **ID / phase** : H1 · Phase H.
- **Objectif** : Construire une tranche métier lead→qualification→proposition, puis étendre par lots
  séparés jusqu'au reporting, sans importer DigitalOS dans ICOS-core.
- **Raison** : Valider l'architecture sur un pipeline métier long après M1.
- **Prérequis** : M1, G1 et connecteurs nécessaires ; D2/D4 stables.
- **Concepts métier** : la pipeline demeure un domaine DigitalOS externe ; ICOS manipule Mission,
  capabilities et références externes.
- **Ports / interfaces** : tools de pipeline derrière Gateway, événements entrants signés, status
  queries ; n8n éventuel comme connecteur périphérique.
- **Base** : références externes et checkpoints ICOS uniquement ; pas de duplication intégrale CRM.
- **Événements** : `pipeline.stage.observed`, `mission.blocked`, `deliverable.verified`.
- **Permissions / policies** : chaque étape classifiée ; production/déploiement sensibles ; secrets
  par adapter.
- **Tests** : attente humaine, reprise longue, événement dupliqué, stage externe divergent, cancel.
- **Risques** : n8n central, couplage vertical et durée longue.
- **Holding IA** : REUSE scénarios CRM ; DISCARD runtime Sofia/IRIS et ghost agents.
- **OpenJarvis** : ADAPT scheduler/traces ; pas le runtime.
- **Skills de développement recommandées** : vertical slicing, integration contracts, sagas.
- **Definition of Done** : première tranche réelle gouvernée, reprenable et auditée ; évaluation du
  besoin Temporal selon ADR-0012.
- **Débloque** : H2+ et éventuellement T1.

---

## I1 — Contrat d'adapter de canal

- **ID / phase** : I1 · Phase I.
- **Objectif** : Définir messages entrants/sortants, identité externe, conversation et delivery sans
  aucune logique métier ou permission propre au canal.
- **Raison** : WhatsApp, Telegram et voix doivent être de simples adapters du même ICOS.
- **Prérequis** : F1, G1 et identité/session stables.
- **Concepts métier** : `ChannelMessage`, `ChannelIdentityLink`, `DeliveryReceipt`, `ChannelStatus`.
- **Ports / interfaces** : `ChannelAdapterPort.connect/disconnect/send/onMessage/status`; normalisation
  vers ConversationPort.
- **Base** : liens d'identité, message ids/idempotence, receipts ; contenu retenu selon policy.
- **Événements** : `channel.message.received/sent/failed`, `channel.identity.linked`.
- **Permissions / policies** : canal n'accorde aucun droit ; identité liée et vérifiée côté serveur ;
  signatures/replay protection ; G1 pour effet sortant.
- **Tests** : CAS 21, message dupliqué, identité inconnue, delivery timeout, canal désactivé.
- **Risques** : spoofing, secret bot, divergence UX.
- **Holding IA** : REUSE UX WhatsApp approve/edit/reject, pas l'orchestration.
- **OpenJarvis** : REUSE `BaseChannel`, registry et `ChannelMessage`; ADAPT policy/identity ICOS.
- **Skills de développement recommandées** : adapters, webhooks sécurisés, idempotence.
- **Definition of Done** : fake channel et contrat testés ; aucune dépendance métier au canal.
- **Débloque** : I2 et J1.

---

## I2 — Adapters WhatsApp et Telegram

- **ID / phase** : I2 · Phase I.
- **Objectif** : Ajouter WhatsApp et Telegram via deux adapters indépendants derrière I1.
- **Raison** : Éprouver le contrat sur des transports différents sans dupliquer les use cases.
- **Prérequis** : I1.
- **Concepts / ports** : aucun nouveau concept métier ; implémentations ChannelAdapterPort et mapping
  approve/edit/reject vers commandes typées.
- **Base / événements** : réutilise I1 ; configuration/credential refs séparées.
- **Permissions / policies** : disabled by default, signatures, allowlist et rate limits ; aucun
  token exposé aux agents.
- **Tests** : contrats communs, webhooks dupliqués, pièces jointes refusées/limitées, retries et ordre.
- **Risques** : différences platform API et consentement.
- **Holding IA** : REUSE l'UX, ADAPT l'identité et l'idempotence.
- **OpenJarvis** : REUSE la forme des adapters, pas les credentials directs dans runtime agent.
- **Skills recommandées** : API WhatsApp/Telegram, webhook security.
- **Definition of Done** : mêmes scénarios cockpit passants sur deux canaux, aucune logique business.
- **Débloque** : omnicanal élargi.

---

## J1 — Adapter voix

- **ID / phase** : J1 · Phase J.
- **Objectif** : Ajouter entrée/sortie voix comme adapter du contrat conversationnel, avec
  transcription, consentement, rétention et confirmation adaptée aux actions sensibles.
- **Raison** : La voix ne doit pas créer une voie d'autorisation plus faible.
- **Prérequis** : I1, F1 et ADR consentement/rétention validé.
- **Concepts métier** : `VoiceSession`, `TranscriptSegment`, `ConfirmationChallenge`.
- **Ports / interfaces** : `VoiceAdapterPort` compose ChannelAdapterPort, SpeechToTextPort et
  TextToSpeechPort ; Twilio CI reste candidat d'infrastructure.
- **Base** : metadata et transcript selon politique de rétention ; audio brut non conservé par défaut.
- **Événements** : `voice.session.started/ended`, `transcript.created`, `confirmation.failed`.
- **Permissions / policies** : identité forte et confirmation explicite pour sensible ; pas
  d'approbation sur simple détection d'un « oui » ambigu.
- **Tests** : bruit, interruption, homophones, consentement absent, replay audio, confirmation.
- **Risques** : usurpation, PII et coût.
- **Holding IA** : ADAPT l'UX conversationnelle.
- **OpenJarvis** : REUSE le principe adapter ; security ICOS renforcée.
- **Skills recommandées** : audio UX, privacy, adversarial testing.
- **Definition of Done** : scénario read-only vocal sûr ; action sensible requiert challenge robuste.
- **Débloque** : expérience voix avancée.

---

## K1 — Autonomie avancée gouvernée

- **ID / phase** : K1 · Phase K.
- **Objectif** : Combiner proactivité, skill candidates et routing observé sans permettre
  auto-modification de permissions, policies ou guardrails.
- **Raison** : L'autonomie utile vient après preuves de contrôle, pas par multiplication d'agents.
- **Prérequis** : P1/S1, Q2, R3, M1 stable et registre de risques maîtrisé.
- **Concepts métier** : `ImprovementProposal`, `AutonomyBudget`, `GuardrailVersion`,
  `RollbackPlan`; toutes les améliorations sont propositions versionnées.
- **Ports / interfaces** : `ImprovementGovernancePort.propose/review/approve/activate/rollback`.
- **Base** : propositions, preuves, décisions, versions et rollbacks ; aucun overwrite mutable.
- **Événements** : `improvement.proposed/reviewed/approved/activated/rolled_back`.
- **Permissions / policies** : séparation proposer/reviewer/approver ; agent jamais approbateur de sa
  proposition ; changements critiques niveau 4.
- **Tests** : auto-approbation, collusion d'agents, rollback, eval régressée, policy protégée.
- **Risques** : dérive, reward hacking, perte de contrôle.
- **Holding IA** : DISCARD prolifération et ghost agents.
- **OpenJarvis** : ADAPT learning/optimization comme générateurs de propositions ; DISCARD mutation
  automatique du runtime actif.
- **Skills recommandées** : governance, eval security, rollback design.
- **Definition of Done** : cycle complet humainement approuvé, réversible et audité ; invariants
  sécurité inchangés.
- **Débloque** : pleine vision graduelle, jamais autonomie incontrôlée.

---

## T1 — Temporal Durable Workflows (conditionnel)

- **ID / phase** : T1 · Phase H+ conditionnelle.
- **Objectif** : Introduire Temporal uniquement si les seuils ADR-0012 démontrent que PostgreSQL +
  scheduler ne suffit plus aux sagas, attentes longues ou compensations.
- **Raison** : Temporal résout la durabilité complexe, pas la simple planification périodique.
- **Prérequis** : D2/D4/S1, incident ou benchmark documenté et ADR accepté.
- **Concepts métier** : aucun domaine métier dépendant de Temporal ; workflow/activity adapters,
  compensation et correlation ids.
- **Ports / interfaces** : implémentation de `DurableWorkflowPort` derrière Orchestrateur ; le domaine
  conserve Mission/Run authoritative.
- **Base** : PostgreSQL ICOS garde état métier ; Temporal garde son état d'exécution interne ;
  corrélation/reconciliation explicites.
- **Événements** : `durable_workflow.started/waiting/compensated/completed` dans Event Journal.
- **Permissions / policies** : chaque activity repasse Gateway/Policy ; replay Temporal ne réexécute
  pas un effet grâce à idempotence.
- **Tests** : worker crash, replay, signal tardif, compensation, cancel, activité dupliquée.
- **Risques** : double source de statut et coût opérationnel.
- **Holding IA** : DISCARD n8n comme substitut.
- **OpenJarvis** : scheduler ne couvre pas ce besoin ; aucun runtime repris.
- **Skills recommandées** : Temporal, sagas, distributed systems.
- **Definition of Done** : besoin mesuré résolu, reconciliation testée, aucun déplacement de vérité
  métier hors PostgreSQL.
- **Débloque** : pipelines H longs si réellement nécessaire.

---

## E4 — Knowledge Graph / Graphiti (conditionnel)

- **ID / phase** : E4 · Phase H+ conditionnelle.
- **Objectif** : Ajouter un graphe dérivé lorsque les relations temporelles client↔projet↔décision ne
  sont pas servies correctement par SQL/FTS/pgvector.
- **Raison** : Un graphe n'est justifié que par des requêtes produit reproductibles.
- **Prérequis** : E3 ou preuve qu'un graphe est requis indépendamment du vectoriel ; ADR store accepté.
- **Concepts métier** : `DerivedEntity`, `DerivedRelation`, `GraphSnapshot`, provenance et validity ;
  aucun nœud n'est authoritative.
- **Ports / interfaces** : `KnowledgeGraphPort.query/rebuild/invalidate`; implémentation Graphiti
  cachée derrière le port.
- **Base** : mapping source entity/version → nœud/edge ; store Graphiti choisi comme détail
  d'infrastructure, Neo4j non imposé.
- **Événements** : `knowledge_graph.rebuilt`, `derived_relation.created/invalidated`.
- **Permissions / policies** : scopes/provenance propagés ; contradiction avec PostgreSQL résolue en
  faveur de PostgreSQL.
- **Tests** : CAS 8, rebuild total, source corrigée, edge périmé, isolation client.
- **Risques** : hallucination de relations, divergence et nouvelle infrastructure.
- **Holding IA** : REBUILD.
- **OpenJarvis** : ADAPT le backend knowledge graph comme pattern expérimental, pas runtime.
- **Skills recommandées** : graph modeling, provenance et reconciliation.
- **Definition of Done** : gain produit mesuré, rebuild déterministe et aucune lecture d'autorité
  depuis le graphe ; sinon décision de ne pas introduire la technologie.
- **Débloque** : questions relationnelles H+, sans devenir prérequis général.

---

## Récapitulatif des gates de lots

- D3 (fondation AI Runtime) précède D4.
- G1 précède tout effet externe et G2.
- R1 → R2 → R3 est strictement séquentiel : économie mesurée, puis santé/fallback, puis qualité
  observée.
- P1 précède S1 ; scheduler ne remplace jamais Temporal.
- Q2 et R3 produisent des propositions ; K1 conserve l'approbation humaine.
- E3, E4 et T1 sont abandonnables sans bloquer M1 si leur déclencheur empirique n'est pas atteint.
