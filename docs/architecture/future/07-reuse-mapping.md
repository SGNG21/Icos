# Cartographie de réutilisation — Holding IA et OpenJarvis

> Classifications REUSE / ADAPT / REBUILD / DISCARD pour chaque pattern examiné.
> Les classifications OpenJarvis sont fondées sur l'audit concret des fichiers source
> (proactive_agent.py, approval_store.py, events.py, skills/manager.py, scheduler/scheduler.py,
> learning/routing/router.py, learning/routing/learned_router.py, docs/user-guide/memory.md,
> docs/user-guide/security.md, docs/user-guide/channels.md).

## 1. Classification synthétique

| Pattern                     | Holding IA                             | OpenJarvis                                                                           | Pourquoi                                                                                                                                                                                          |
| --------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Skill Registry**          | REUSE (déclaredSkills vs actualSkills) | REUSE (SkillManager discovery, catalogue, overlays)                                  | Les deux sont des patterns de découverte et de registre; la gouvernance ICOS (quarantaine, activation humaine) est plus stricte                                                                   |
| **Capability Registry**     | —                                      | REUSE (capability-validation, parsing de signature)                                  | Utile pour le parseur de compatibilité                                                                                                                                                            |
| **Memory / Context Port**   | —                                      | ADAPT (MemoryBackend ABC, chunking pipeline, SQLite FTS5, hybrid RRF)                | L'interface MemoryBackend est un bon contrat; l'implémentation ICOS passe par Postgres FTS/pgvector, pas SQLite                                                                                   |
| **Proactivity / Heartbeat** | REUSE (auto-exec routine tasks)        | ADAPT (ProactiveAgent tier system + permission memory)                               | Le système de tiers (trivial/low/medium/high) est utile, mais ICOS ne peut pas auto-approuver trivial                                                                                             |
| **Approval / Policy**       | REUSE (approval lifecycle, preview)    | ADAPT (ApprovalStore, permission memory)                                             | La permission memory OpenJarvis sert d'inspiration pour la mémoire d'approbation ICOS, mais ne remplace pas l'autorité décisionnelle                                                              |
| **Scheduler**               | —                                      | REUSE (TaskScheduler base, store persistant, cron/interval/once)                     | Bon pattern pour scheduler simple; compatible avec l'invariant scheduler ≠ Temporal                                                                                                               |
| **MCP Adapters**            | —                                      | REUSE (pattern d'adapter générique)                                                  | ICOS utilise le même pattern : Tool/MCP Gateway comme seul point d'entrée                                                                                                                         |
| **Model Router**            | —                                      | ADAPT (HeuristicRouter + LearnedRouterPolicy)                                        | ICOS contrôle par policy; OpenJarvis inspire le routing heuristique/learned mais le Control Plane ICOS exige l'évaluation de capacité/coût/confidentialité                                        |
| **EventBus / Traces**       | —                                      | DISCARD (comme runtime direct); ADAPT (comme pattern pour la notification technique) | L'EventBus technique OpenJarvis (pub/sub in-process, 75+ event types) est un bon modèle pour l'observabilité ICOS, mais ne remplace jamais l'Event Journal                                        |
| **Evals**                   | —                                      | REUSE (framework d'évaluation, use-case benchmarks, scénarios)                       | Les 40 benchmarks et les use-case eval configs sont un pattern pour l'évaluation ICOS                                                                                                             |
| **Channels**                | —                                      | REUSE (BaseChannel ABC, adapter registry)                                            | Exactement le pattern ICOS : canaux = adapters sans logique métier propre                                                                                                                         |
| **Security / Sandbox**      | —                                      | ADAPT (GuardrailsEngine pipeline, SecretScanner, File Policy)                        | Les scanners et le pipeline d'exécution sont utiles; le sandbox OpenJarvis est à inspecter plus avant                                                                                             |
| **Self-improvement**        | —                                      | DISCARD (auto-discovery from traces directe)                                         | OpenJarvis écrit directement les skills découvertes; ICOS impose quarantaine puis activation humaine, le pattern de découverte depuis traces est utile mais le cycle d'activation est plus strict |

## 2. Détails Holding IA

### REUSE (patterns à intégrer)

- **Brief structuré** : template de demande avec slots pour les paramètres obligatoires/optionnels — utile pour le Plan (Phase D).
- **DéclaredSkills vs ActualSkills** : comparer les skills déclarées dans le registre aux skills réellement invoquées dans les traces.
- **RiskLevelMap** : correspondance entre type d'action et niveau de risque, précurseur du Policy Engine v2 (D1).
- **Approval lifecycle** : soumission, preview, période de décision, expiration.
- **Client×Action autonomy** : laisser à chaque client/utilisateur la possibilité de définir le niveau d'autonomie par action.

### ADAPT (déjà intégré dans le code existant)

- **Idempotency** : le code ICOS existant n'a pas encore d'idempotencyKey explicite, mais les leçons de Holding IA (double exécution) sont intégrées dans le design de G1 (ExecutionRecord + idempotencyKey).
- **Credentials isolés** : le concept de credentials hors de portée des agents est un acquis du design.

### DISCARD (ne pas reproduire)

- **n8n comme orchestrateur central** : ICOS a son propre orchestrateur ; n8n est un connecteur, pas le cerveau.
- **Mutable-states-only** : pas d'historique immuable = pas de reprise fiable.
- **Pas d'idempotence** : déjà corrigé dans le design.
- **Approved=executed** : conflation dangereuse ; ICOS sépare décision et exécution.
- **47/57/119 agents** : prolifération non gouvernée ; ICOS impose un registre avec activation humaine.
- **Direct domain dep on n8n/Supabase/Meta/Twilio** : ICOS s'appuie sur PostgreSQL et Better Auth ; les dépendances externes sont en périphérie, pas dans le domaine.

## 3. Détails OpenJarvis

### 3.1 SkillManager (skills/manager.py)

**REUSE — fort**

- Pattern de `discover()` : scanne des répertoires, first-seen wins, valide le graphe de dépendances.
- `get_catalog_xml()` : génération d'un catalogue lisible par le modèle, avec exclusion des skills internes (`disable_model_invocation`). Ce pattern est directement utilisable pour le catalogue ICOS.
- Overlays (`_load_overlays`) : optimisation découplée du manifeste.
- `resolve()` : résolution de skill par nom avec KeyError.

**ADAPT — moyen**

- `discover_from_traces()` : pattern d'analyse de traces récurrentes → conversion en skill candidate. Utile pour Q2 (Skill Discovery from Traces) mais ICOS ne normalise pas en `discovered`, seulement en `quarantined`.
- Le format de manifeste TOML (`skill.toml`) diffère du format ICOS attendu (Capability-based, pas tool-based). Le pattern de sérialisation est adaptable.

**DISCARD**

- `_NullToolExecutor` : l'exécuteur null d'OpenJarvis n'est pas un pattern ICOS acceptable — ICOS refuse avec un PolicyEvaluation explicite plutôt que de fournir un stub silencieux.
- `remove()` avec `shutil.rmtree` : la suppression de skill ICOS est une transition d'état, pas une opération de filesystem.
- Les arguments templates (`arguments_template = "{}"`) : ICOS utilise JSON Schema (`inputSchema`).

### 3.2 Memory Backends (tools/storage/*.py + docs user-guide)

**REUSE — très fort**

- `MemoryBackend` ABC avec `store()`, `retrieve()`, `delete()`, `clear()` — exactement le pattern d'interface attendu pour le Memory/Context Port ICOS (E1).
- `RetrievalResult` avec `content`, `score`, `source`, `metadata` — contrat stable.
- SQLite FTS5 comme backend _par défaut_ — confirme le choix ICOS de commencer par Postgres FTS.
- Chunking pipeline avec `chunk_size` / `chunk_overlap` / `min_chunk_size` — très proche du besoin ICOS.
- Pipeline d'ingestion (`ingest_path()`) avec skipping auto des fichiers cachés/binaires.
- Hybrid RRF (Reciprocal Rank Fusion) — pattern de fusion sparse/dense utile pour E3 (Hybrid Retrieval).

**ADAPT — moyen**

- MemoryRegistry singletons → ICOS utilise des ports async, pas un registry de backends.
- La provenance (`source`) est incluse mais le système de `provenance` ICOS (corrigible, versionné) est plus sophistiqué.
- ContextInjection avec min_score/max_context_tokens — pattern excellent pour le contexte du modèle.

**DISCARD**

- `FAISSMemory` in-memory only → ICOS exige de la persistance (Postgres ftab).
- Aucune des implémentations OpenJarvis n'est une source de vérité, en accord avec l'invariant Memory ≠ authoritative state.

### 3.3 ProactiveAgent (agents/proactive_agent.py)

**ADAPT — fort**

- Le système de tiers (trivial/low/medium/high) est un pattern que ICOS pourrait ADAPT pour la classification simplifiée des actions de proactivité. Mais ICOS ne peut **jamais** auto-approuver le niveau `trivial` : toute action doit passer par le Policy Engine, même les plus simples.
- Le pattern heartbeat (collecte → LLM → proposition → action) est utile pour le design de P1.
- Le `permission_key` (ex. `email_delete:domain:noreply.github.com`) est un pattern excellent pour la permission memory ICOS.

**DISCARD — important**

- L'auto-approbation des tiers `trivial` est inacceptable dans l'architecture ICOS. Une action classifiée 0 (read-only) par le Policy Engine ICOS peut être approuvée automatiquement, mais cette décision passe par le Policy Engine, pas par l'agent.
- `always_approve` / `always_deny` stocké dans la base SQLite sans versionnement : la permission memory ICOS doit être révocable et versionnée.
- Le LLM génère directement les permissions — ICOS ne laisse jamais le LLM décider des permissions; les permissions ICOS sont pré-établies dans la politique.
- `_extract_json_block` : parsing heuristique du JSON modèle → ICOS utilise Zod schema validation.

### 3.4 ApprovalStore (tools/approval_store.py)

**ADAPT — moyen**

- Structure de `permission_memory` (pattern key → décision → compteurs) : utile pour la mémoire d'approbation ICOS, mais ICOS ne l'utilise pas comme autorité. La mémoire d'approbation est une donnée dérivée (révocable), pas authoritaire.
- TTL de 24 heures sur les actions en attente (`ttl_hours`) : pattern utile pour l'expiration des approbations.

**DISCARD**

- SQLite comme backend → ICOS utilise PostgreSQL pour toute donnée durable.
- `set_permission` upsert sans historique : la permission memory ICOS doit avoir un historique immuable (table de transitions).

### 3.5 EventBus (core/events.py)

**REUSE — fort (comme pattern d'observabilité)**

- 75+ types d'événements dans une seule taxonomy organisée par phase.
- `EventType` enum clair, pub/sub in-process thread-safe.
- `record_history` optionnel pour inspection/test.
- Singleton avec `get_event_bus()` / `reset_event_bus()`.
- L'EventBus est technique seulement; il travaille _au-dessus_ de l'Event Journal métier, jamais à sa place.

**ADAPT**

- La taxonomy d'événements ICOS sera différente (plus proche des événements domaine : inference_start, skill_invoked, etc.).
- ICOS doit expliciter la règle : "écris l'Event Journal avant de notifier l'EventBus" (pas l'inverse).

**DISCARD**

- Aucun. Le pattern EventBus est exactement ce dont ICOS a besoin pour l'observabilité, tant qu'il reste clairement séparé de l'Event Journal métier.

### 3.6 TaskScheduler (scheduler/scheduler.py)

**REUSE — moyen**

- `ScheduledTask` avec `schedule_type` (cron | interval | once), `status`, `next_run`.
- Store persistant : `SchedulerStore` sauve en base les tâches périodiques.
- Background polling thread avec `poll_interval` réglable.
- `compute_next_run` avec heuristique de repli pour cron sans croniter.

**ADAPT**

- L'exécution se fait via `JarvisSystem.ask()` — ICOS exécute via l'Orchestrateur, pas directement.
- Le polling loop n'est pas un pattern que ICOS reproduit; ICOS utilise des triggers async ou un worker dédié.

**DISCARD**

- Rien à discarter — ce scheduler est suffisant pour P1 (scheduler simple/durable) et respecte l'invariant scheduler ≠ Temporal.

### 3.7 Model Router (learning/routing/router.py + learned_router.py)

**ADAPT — fort**

- `HeuristicRouter` : rules by complexity/code/math/urgency, tag-based selection. Pattern utile pour R1.
- `LearnedRouterPolicy` : `classify_query()` → query class → model mapping, trace-driven, feedback-scored. Pattern pour R3.
- `ModelScore.composite_score()` : 0.6*success_rate + 0.4*feedback. ICOS peut étendre pour inclure coût, latence et confidentialité.
- `min_samples` (5) : seuil minimal avant d'appliquer un mapping appris.

**DISCARD**

- OpenJarvis route directement vers les providers ; ICOS route **toujours** via OmniRoute, pas d'appel direct.
- L'absence de vérification de confidentialité et de capacité dans le routing OpenJarvis est une lacune que ICOS comble structurellement avec `ModelPolicy` et `CapabilityRegistry`.
- L'auto-apprentissage dans OpenJarvis (update_from_traces → changement de mapping) se fait sans gouvernance humaine ; ICOS impose une revue et un versionnement de `ModelPolicy` avant tout changement.

### 3.8 Channels (channels/, docs/user-guide/channels.md)

**REUSE — très fort**

- `BaseChannel` ABC avec `connect()`, `send()`, `on_message()`, `disconnect()`, `status()`, `list_channels()` — exactement le contrat que ICOS doit adopter.
- ChannelRegistry (décorateur `@ChannelRegistry.register`) : pattern d'enregistrement de canaux.
- `ChannelMessage` structuré : `channel`, `sender`, `content`, `message_id`, `conversation_id`, `session_id`, `metadata`.
- Les canaux n'ont pas de logique business : ils sont des adapters purs, exactement comme ICOS le requiert.
- Les channels sont **disabled by default** : pattern de sécurité.

**ADAPT**

- La connexion directe aux providers (Telegram Bot API, Discord Bot API, etc.) est correcte pour ICOS, mais ICOS ajoute ICOS ajoute sa couche d'application Policy Engine avant toute action déclenchée par un message entrant.
- L'intégration EventBus (CHANNEL_MESSAGE_RECEIVED/SENT) est un bon pattern pour la télémétrie.

### 3.9 Security (docs/user-guide/security.md, security/*.py)

**REUSE — fort**

- `GuardrailsEngine` : wrapper d'inference engine avec pré/post scan. Pattern de pipeline.
- `SecretScanner` + `PIIScanner` : détection de clés API, PII, fichiers sensibles.
- `AuditLogger` append-only avec subscription EventBus.
- Modes : WARN / REDACT / BLOCK.

**ADAPT**

- Les scanners ICOS doivent être contrôlés par le Policy Engine, pas exécutés indépendamment.
- FilePolicy (blocage de fichiers sensibles) : pattern à intégrer dans le Tool/MCP Gateway.

### 3.10 Self-improvement / SkillDiscovery (skills/manager.py:discover_from_traces + learning/agents/skill_discovery.py)

**DISCARD** (comme cycle d'activation directe) — **ADAPT** (comme pattern de détection)

- `discover_from_traces()` : analyse des séquences d'outils récurrentes et minutage de fréquence → candidature de skill. Le pattern de détection est excellent pour Q2.
- **Mais** : OpenJarvis écrit directement les skills découvertes dans `~/.openjarvis/skills/discovered/`. ICOS impose quarantaine → evidence → eval → security review → approval humaine → activation. Le détecteur ICOS dépose en `quarantined`, jamais en `active`.
- `min_frequency=3`, `min_outcome=0.5` : les seuils ICOS doivent être plus stricts (min. 3 exécutions réussies avec policy identique + vérification humaine du résultat).

## 4. Tableau de synthèse des recommandations

### Patterns à réutiliser directement (REUSE)

| Pattern                                            | Document source                     | Livrable ICOS                    |
| -------------------------------------------------- | ----------------------------------- | -------------------------------- |
| MemoryBackend ABC + RetrievalResult                | OpenJarvis memory.md                | E1 (Memory/Context Port)         |
| Chunking pipeline + ingest_path                    | OpenJarvis memory.md                | E2 (Ingestion + FTS)             |
| RRF fusion                                         | OpenJarvis storage/hybrid.py        | E3 (Hybrid Retrieval)            |
| BaseChannel ABC + ChannelRegistry + ChannelMessage | OpenJarvis channels/_stubs.py, docs | I1 (Channel Adapter Contract)    |
| Skill catalog XML                                  | OpenJarvis skills/manager.py        | C2 (Skill Registry)              |
| GuardrailsEngine pipeline                          | OpenJarvis security/                | G1 (Tool/MCP Gateway)            |
| Taxonomy d'events EventBus                         | OpenJarvis core/events.py           | Observabilité technique          |
| declaredSkills vs actualSkills                     | Holding IA                          | Q2 (Skill Discovery from Traces) |

### Patterns à adapter (ADAPT)

| Pattern                               | Adaptation nécessaire                                                   | Livrable ICOS      |
| ------------------------------------- | ----------------------------------------------------------------------- | ------------------ |
| ProactiveAgent tier system            | Supprimer l'auto-approbation trivial; tout passe par Policy Engine      | P1 (Proactivity)   |
| ApprovalStore permission memory       | Remplacer SQLite par PostgreSQL; ajouter historique immuable            | D1 (Policy v2)     |
| HeuristicRouter + LearnedRouterPolicy | Ajouter vérification de capacité, confidentialité et coût via OmniRoute | R1-R3 (AI Runtime) |
| TaskScheduler                         | Connecter à l'Orchestrateur au lieu de l'exécution directe              | P1 (Scheduler)     |
| Approval lifecycle                    | Conserver l'immutabilité de la décision rejected d'ICOS                 | D1                 |
| ContextInjection                      | Provenance corrigeable + scope ICOS                                     | E1-E2              |

### Patterns à reconstruire (REBUILD)

| Pattern                  | Pourquoi                                                          | Livrable ICOS |
| ------------------------ | ----------------------------------------------------------------- | ------------- |
| Skill Registry ICOS      | Lifecycle plus strict (quarantaine, activation humaine, SkillsMP) | C2            |
| Policy Engine ICOS       | Basé sur decideExecution, 5 niveaux, versionné                    | D1            |
| AI Runtime Control Plane | ICOS pilote OmniRoute, ne le remplace pas                         | D3, R1-R3     |
| Mission/Plan/Run         | Domaine ICOS spécifique, OpenJarvis n'en a pas                    | D2            |
| Orchestrateur ICOS       | Pas de pattern équivalent dans OpenJarvis                         | D4            |

### Patterns à écarter (DISCARD)

| Pattern                                  | Raison                                                    |
| ---------------------------------------- | --------------------------------------------------------- |
| n8n comme orchestrateur                  | ICOS a son orchestrateur ; n8n est un connecteur          |
| Auto-approbation de tiers (trivial)      | Toute action passe par le Policy Engine                   |
| Auto-installation de skill depuis traces | Quarantaine obligatoire + activation humaine              |
| Connexion directe agent→provider         | OmniRoute est l'unique infra multi-provider               |
| Mutable states only                      | Historique immuable requis pour toute transition métier   |
| Conflation approved=executed             | Séparation stricte entre décision et exécution            |
| EventBus comme journal métier            | EventBus technique distinct de l'Event Journal immuable   |
| Glob de permissions par LLM              | Les permissions sont pré-établies dans les politiques     |
| SkillsMP comme autorité d'installation   | SkillsMP est une source de découverte, pas d'installation |

## 5. Runtimes externes — classification post-audit

| Runtime                     | Classification    | ICOS =                                                                                            | Runtime =                                                                 | Risque principal                                                                                                     |
| --------------------------- | ----------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **OmniRoute**               | **REUSE**         | WHY / WHAT / contraintes metier                                                                   | HOW / WHERE / routing technique                                           | Duplication accidentelle du routeur ; ICOS ne doit pas maintenir de ProviderRegistry/ModelRegistry technique         |
| **Mem0**                    | **REUSE / ADAPT** | Truth metier (PostgreSQL) ; provenance ; scope ; corrigibilite                                    | Memoire contextuelle long terme ; retrieval semantique ; personnalisation | Memoire derivee prise pour authoritative ; fuite inter-client                                                        |
| **Graphiti**                | **DEFER**         | Relationnel metier deja couvert par PostgreSQL                                                    | Relations temporelles riches                                              | Introduit trop tot sans besoin produit demontre                                                                      |
| **Browser Use**             | **REUSE**         | Permissions ; domaines autorises ; risk classification ; approval ; audit ; idempotence           | Navigation ; extraction ; interaction DOM ; automatisation native         | L'adapter ne doit pas devenir une frontiere d'autorisation ; submit/send/buy/delete/publish != read/navigate/extract |
| **OpenHands**               | **REUSE**         | Repo autorises ; mission ; budget ; policy ; quality gates ; merge approval ; deployment approval | Coding loop ; workspace ; interaction technique agents IA                 | Coding agent merge main automatiquement sans permission                                                              |
| **E2B**                     | **REUSE**         | Selection sandbox (risque, cout, confidentialite, reseau, persistance)                            | Execution isolee ; sandbox externe                                        | Tous les agents obtiennent acces hote par defaut                                                                     |
| **Langfuse**                | **REUSE**         | Event Journal = verite metier ; Langfuse = observabilite IA                                       | LLM tracing ; prompt telemetry ; datasets ; evals ; token/cost            | Langfuse utilise comme business database ; confusion entre eval OmniRoute/Langfuse/ICOS                              |
| **Agno**                    | **ADAPT**         | Agent Registry ICOS ; policy ; approval ; skill lifecycle                                         | Team semantics ; context providers ; multi-tenancy ; channel patterns     | Patterns copies sans justification produit                                                                           |
| **OpenAI Agents SDK**       | **ADAPT**         | Orchestrateur ICOS ; Policy Engine ; Tool Gateway                                                 | Handoffs ; runner semantics ; HITL ; sandbox ; realtime ; tracing         | Runtime externe devient cceur ICOS                                                                                   |
| **Google ADK**              | **ADAPT**         | Orchestrateur ICOS ; plan ; mission                                                               | Task API ; workflow graph ; delegation ; artifacts ; sessions             | Runtime externe remplace domaine                                                                                     |
| **Mastra**                  | **ADAPT**         | Orchestrateur ICOS ; policy ; audit                                                               | TypeScript patterns ; workflows ; suspend/resume ; tool contracts         | Dependance TypeScript non justifiee pour le core                                                                     |
| **LangGraph**               | **ADAPT**         | Etat durable ICOS (PostgreSQL) ; checkpoints propres                                              | Checkpointing ; interrupts ; durable state                                | Remplace la source de verite PostgreSQL                                                                              |
| **OpenJarvis**              | **ADAPT**         | Skill Registry ; Policy Engine ; Event Journal ; Memory Port                                      | Skill lifecycle ; provenance ; heartbeat ; memory backends                | Runtime OpenJarvis devient cceur ICOS                                                                                |
| **Holding IA**              | **ADAPT**         | Policy/Approval existant ; audit existant                                                         | Briefs structures ; approval preview ; audit timeline ; clientxaction     | Architecture Holding IA recopiee                                                                                     |
| **Temporal**                | **DEFER**         | PostgreSQL + scheduler ; workflows courts                                                         | Sagas longs ; attentes non bornees ; compensation                         | Introduit trop tot sans besoin de reprise complexe                                                                   |
| **Neo4j**                   | **DISCARD**       | PostgreSQL relationnel ; pgvector si besoin semantique                                            | Store de graphe dedie                                                     | Nouvelle base sans justification                                                                                     |
| **n8n comme orchestrateur** | **DISCARD**       | Orchestrateur ICOS (D4)                                                                           | Orchestration d'automatisations                                           | n8n redevient cerveau central                                                                                        |
| **JarvJS/open-interpreter** | **DISCARD**       | Orchestrateur ICOS ; policy ; approval ; audit                                                    | Runtime d'execution IA                                                    | Runtime non audite comme cceur ICOS                                                                                  |

### Regles d'integration de runtimes externes

1. **Port abstrait ICOS** : chaque runtime externe a un port defini (OmniRoute, MemoryPort,
   BrowserPort, DevelopmentGateway, SandboxPort, ObservabilityPort) ; le domaine ne connait
   jamais l'implementation.
2. **Adapter isole** : chaque implementation est un adapter (OmniRouteAdapter, Mem0Adapter,
   BrowserUseAdapter, OpenHandsAdapter, E2BSandboxAdapter, LangfuseAdapter) ; les credentials
   et la communication restent isoles.
3. **Policy/Approval ICOS avant tout effet** : aucun runtime externe ne contourne le Policy Engine.
4. **Source de verite claire** : PostgreSQL = verite metier ; Event Journal = verite audit ;
   Mem0 = memoire derivee ; Langfuse = observabilite IA ; OmniRoute = routing technique.
5. **Pas d'installation prematuree** : les runtimes DEFER (Graphiti, Temporal) et les
   capabilities OPTIONNELLES (Browser Use, OpenHands, E2B, Langfuse) ne sont introduits
   que lorsque le besoin est demontre ou que le premier ICOS semi-autonome est stable.
