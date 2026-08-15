# Synthèse exécutive — architecture future ICOS

## Décision centrale

ICOS doit évoluer depuis son modèle actuel, volontairement petit et robuste
(`Task → AgentAction → Approval → AuditEntry`), vers un système mission-centric gouverné :

```text
Instruction naturelle
→ Mission durable
→ contexte vérifié
→ Plan inspectable
→ sélection Agent + Capability + Skill
→ Policy/Approval
→ sélection modèle gouvernée par ICOS
→ routage technique par OmniRoute
→ Tool/MCP Gateway
→ exécution idempotente
→ vérification
→ résultat
→ Event Journal
→ mémoire dérivée
→ follow-up
```

Le chemin recommandé n'est pas de construire immédiatement Temporal, Graphiti, un runtime
OpenJarvis ou tous les canaux. Il est de livrer un premier ICOS utile : le scénario Dupont — préparer
un devis depuis une instruction naturelle, ne rien envoyer sans approbation, exécuter une seule fois,
puis reprendre après interruption.

## État réel et écart principal

ICOS possède déjà les bons noyaux :

- ports async et implémentations mémoire/PostgreSQL ;
- composition root explicite, aucun fallback PostgreSQL→mémoire ;
- Policy Engine v1 (`decideExecution`) fail-closed ;
- distinction identité humaine / autorisation agent ;
- journal d'audit append-only protégé au niveau SQL ;
- transactions unit-of-work pour décision/action/audit.

Mais il ne possède encore ni Mission, Plan, Run, Capability, Skill, Memory, Orchestrateur, Tool
Gateway ou AI Runtime. Le code actuel utilise trois risques (`read_only`, `reversible`, `sensitive`),
alors que le Master Plan cible cinq niveaux 0-4 : cet écart doit être traité avant l'orchestration.

## Architecture cible en neuf blocs

1. **CORE** : Mission, Plan, Run, Task, Action, Approval et Event Journal en PostgreSQL.
2. **GOUVERNANCE** : Capability Registry, Skill Registry, Policy Engine versionné et cycle de trust.
3. **ORCHESTRATION** : planification, sélection agent/skill, reprise, arrêt et vérification.
4. **AI GATEWAY / BUSINESS CONTROL PLANE** : `AiGatewayPort`, exigences de capability,
   classification métier, budget, restrictions client/projet, politique de routage métier,
   corrélation Mission/Run/Task, ledger d'usage métier et EvaluationStore.
5. **OMNIROUTE** : runtime externe durable et source de vérité technique pour providers, comptes,
   credentials, modèles, quotas, health, pricing technique, circuit breakers, retries, fallback et
   routage multi-provider. ICOS le pilote par contraintes ; il ne reconstruit pas son moteur.
6. **MEMORY** : port de contexte, provenance, FTS puis retrieval hybride si mesuré ; jamais vérité
   métier.
7. **INTEGRATIONS** : Tool/MCP Gateway unique, `ExecutionRecord` et idempotence avant chaque effet.
8. **QUALITY/OBSERVABILITY** : tests comportementaux, evals versionnées, traces techniques et coûts.
9. **CHANNELS/PROACTIVITY** : adapters seulement ; heartbeat sans autorité ; scheduler distinct de
   Temporal.

## Position sur OmniRoute et les providers IA

**ICOS pilote OmniRoute ; ICOS ne remplace pas OmniRoute.**

La frontière durable suit : **ICOS = WHY / WHAT / contraintes métier ; OmniRoute = HOW / WHERE /
routage technique.**

- ICOS produit un `AiRoutingRequest` : capability requise, criticité, qualité minimale,
  confidentialité, budget, contraintes client/projet, classes de providers autorisées, usage du free
  tier, préférence abonnement/crédits et règles métier de fallback.
- OmniRoute choisit techniquement provider, modèle, compte, chemin de routage et fallback selon son
  catalogue, quotas, health, latence, pricing, circuit breakers, lockouts et disponibilité.
- ICOS ne maintient ni second catalogue technique de providers/modèles, ni credentials, ni moteur de
  quota/health/fallback. Il peut conserver des projections dérivées pour affichage et réaction métier.
- Les APIs OpenAI-/Anthropic-compatible de NVIDIA NIM sont absorbées par OmniRoute ; aucun changement
  de domaine.
- Le provider, modèle et compte réellement utilisés, les fallbacks, tokens, latence et coûts retournés
  sont corrélés à Mission/Run/Task dans l'audit ICOS via l'`OmniRouteAdapter` (frontière unique
  entre ICOS et OmniRoute).
- Le ledger ICOS qualifie les coûts : `estimatedListCost`, `providerReportedCost`,
  `subscriptionIncludedCost`, `incrementalCost` et `savingsEstimate`. Un coût estimé n'est jamais
  présumé facturé.
- La génération modèle et l'effet externe sont séparés ; un retry/fallback d'inférence ne peut jamais
  doubler l'action externe.

La règle métier d'ICOS est d'exprimer les **seuils et préférences**. L'optimisation technique du modèle
le moins coûteux admissible appartient à OmniRoute. ICOS vérifie que le résultat respecte la policy,
mais ne reproduit pas le scoring technique.

## Position sur OpenJarvis

OpenJarvis est une source de patterns, pas un runtime à adopter. Sont retenus ou adaptés :

- `SkillManager`, manifests, catalogues et validation de dépendances ;
- `MemoryBackend`, chunking, provenance et hybrid RRF ;
- heartbeat et permission keys du `ProactiveAgent`, sans auto-approbation ;
- `ApprovalStore` comme pattern de mémoire de décision, pas comme autorité ;
- scheduler persistant cron/interval/once, distinct de Temporal ;
- MCP adapters et `BaseChannel` registry ;
- `HeuristicRouter` et `LearnedRouterPolicy` comme patterns pour R1/R3 ;
- EventBus/traces comme observabilité technique, distincte du journal immuable ;
- evals, scanners, guardrails et sandbox comme défense en profondeur.

Le self-improvement acceptable est strictement :

```text
succès répétés → SkillCandidate → preuves → eval → revue sécurité
→ approbation humaine → activation versionnée
```

Jamais d'auto-installation, d'auto-activation ni de modification autonome des permissions/guardrails.

## Chemin critique

1. terminer le Lot 2B-2 (ailleurs) ;
2. C1 Capability Registry ;
3. C2 Skill Registry & Trust Lifecycle ;
4. D1 Policy/Approval Engine v2 ;
5. D2 Mission, Plan, Run & Event Journal ;
6. D3 AI Gateway / OmniRoute Business Layer ;
7. D4 Orchestrateur v1 ;
8. G1 Tool/MCP Gateway + ExecutionRecord ;
9. G2 premier connecteur métier ;
10. M1 premier ICOS semi-autonome.

C3 (SkillsMP Discovery) devient parallélisable juste après C2 et n'est plus sur le chemin critique
de D1-D4. Mémoire, contrat conversationnel et harness d'évaluation avancent en parallèle dès que leurs
ports sont stables. R1-R3 enrichissent ensuite les contraintes métier, utilisant les capacités
OmniRoute plutôt que de les reproduire.

## Architecture en port/adapter — runtimes externes

```text
Instruction → Mission → Plan → Run → Effect
                                 ↓
                    ┌─── Policy/Approval ICOS (autorité)
                    ↓
              ┌────────────────────────────────────┐
              │   ICOS Core (domaine propriétaire)  │
              │   Mission · Run · Task · Agent       │
              │   Capability · Skill · Policy        │
              │   Event Journal · Business Memory    │
              └─────┬────┬────┬────┬────┬────┬─────┘
                    │    │    │    │    │    │
         ┌──────────┘    │    │    │    │    └──────────┐
         ↓               ↓    ↓    ↓    ↓               ↓
  ┌──────────────┐  ┌──────┐ ┌──────┐ ┌──────┐ ┌────────────┐ ┌──────────────┐
  │ AI Gateway   │  │ Mem0 │ │Browser│ │Dev   │ │ Sandbox    │ │ Observability│
  │ OmniRoute    │  │ Port │ │ Use  │ │Open  │ │ Port       │ │ Port         │
  │ Adapter      │  │      │ │Port  │ │Hands │ │            │ │              │
  └──────────────┘  └──────┘ └──────┘ │Port  │ └────────────┘ └──────────────┘
                                       └──────┘
```

ICOS ne reconstruit aucun de ces runtimes. Chaque capability externe est un port abstrait et un
adapter isolé.

## Classification BUILD / REUSE / ADAPT / DEFER / DISCARD

| Component                                      | Classification    | Raison                                                                                      |
| ---------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------- |
| Mission / Run / Task                           | **BUILD**         | Domaine cœur ICOS, aucun équivalent externe le couvre                                       |
| Capability / Skill Registry                    | **BUILD**         | Gouvernance de confiance, provenance, versioning, hard gates                                |
| Policy / Approval Engine                       | **BUILD**         | Autorité unique de décision, fail-closed, jamais externalisée                               |
| Event Journal (`audit_entries`)                | **BUILD**         | Source de vérité de l'audit, append-only SQL                                                |
| Business Memory (PostgreSQL)                   | **BUILD**         | Truth métier authoritative, source de toute décision                                        |
| Orchestrateur                                  | **BUILD**         | Sélection agent/skill, décomposition, reprise, arrêt                                        |
| Tool/MCP Gateway                               | **BUILD**         | Point d'entrée unique pour tous les effets externes                                         |
| ExecutionRecord + Idempotency                  | **BUILD**         | Garantie fondamentale contre double exécution                                               |
| OmniRoute                                      | **REUSE**         | Infrastructure IA mature, routage multi-provider, credentials, quotas, health, fallback     |
| Mem0                                           | **REUSE / ADAPT** | Mémoire contextuelle long terme, retrieval sémantique — adapt patterns, pas adopter runtime |
| Graphiti                                       | **DEFER**         | Relations temporelles avancées — seulement si besoin réel démontré (Phase H+)               |
| Browser Use                                    | **REUSE**         | Browser automation natif — port abstrait ICOS, permissions ICOS, audit ICOS                 |
| OpenHands                                      | **REUSE**         | Coding-agent backend — port abstrait ICOS, repo autorisés, merge approval ICOS              |
| E2B                                            | **REUSE**         | Sandbox externe isolé — port abstrait ICOS, sélection par risque/coût/confidentialité       |
| Langfuse                                       | **REUSE**         | Observabilité IA : tracing, prompts, evals, token/cost — pas la business DB                 |
| Agno / OpenAI Agents SDK / Google ADK / Mastra | **ADAPT**         | Patterns d'agents, HITL, sessions, workflows — inspirations architecturales                 |
| LangGraph                                      | **ADAPT**         | Checkpointing, interrupts, durable state — patterns pour workflows ICOS                     |
| OpenJarvis                                     | **ADAPT**         | Skill lifecycle, provenance, heartbeat, permission memory — patterns, pas runtime           |
| Holding IA                                     | **ADAPT**         | Briefs structurés, approval preview, audit timeline — leçons, pas architecture              |
| Temporal                                       | **DEFER**         | Seulement si workflows durables > garanties PostgreSQL + scheduler                          |
| Neo4j                                          | **DISCARD**       | Non retenu ; Graphiti peut s'appuyer sur Postgres                                           |
| n8n comme orchestrateur                        | **DISCARD**       | Connecteur seulement, jamais cerveau                                                        |
| JarvJS/open-interpreter                        | **DISCARD**       | Runtime non approprié comme cœur ICOS                                                       |

## Runtimes externes — dépendances non négociables

ICOS ne construit pas, ne duplique pas et ne remplace pas :

- **OmniRoute** : routing IA technique, credentials, catalogues, health, quotas, fallback.
- **Mem0** : mémoire contextuelle long terme, pas authoritative.
- **Browser Use** : automatisation navigateur, jamais frontière d'autorisation.
- **OpenHands** : backend spécialisé coding-agent, jamais autorité sur merge/déploiement.
- **E2B** : sandbox externe, sélectionné par risque/coût/confidentialité.
- **Langfuse** : observabilité IA, tracing, evals, token/cost.

Chaque capability externe passe par un **port abstrait** et un **adapter isolé** ; le domaine ICOS
ne connaît jamais l'implémentation sous-jacente.

## Anti-patterns — ne pas reproduire

- Adopter un framework agent comme core ICOS.
- Multiplier les orchestrateurs ou sources de vérité.
- Dupliquer OmniRoute, OpenHands, Langfuse ou Mem0 dans ICOS.
- Construire un browser agent maison alors que Browser Use existe.
- Rendre Mem0 ou Graphiti authoritative.
- Utiliser Langfuse comme business database.
- Laisser un agent choisir librement son provider.
- Laisser une skill auto-élever ses permissions.
- Laisser un coding agent merger main automatiquement.
- Laisser un browser agent envoyer/payer/publier sans policy.
- Installer toutes les dépendances dès maintenant.
- Mettre tout derrière MCP en oubliant que MCP n'est pas permission.

## Technologies différées

- pgvector seulement si FTS échoue sur un benchmark ;
- Graphiti/Neo4j seulement si les relations riches sont un besoin produit démontré ;
- Temporal seulement si PostgreSQL + scheduler ne garantit plus les workflows longs ;
- omnicanal/voix après le contrat conversationnel ;
- routing basé evals après un corpus versionné et un historique suffisant.

## Invariants finaux

> Liste canonique et unique des invariants architecturaux ICOS. [01-overview.md](./01-overview.md#4-invariants-non-négociables)
> y renvoie plutôt que de la dupliquer.

1. **PostgreSQL reste authoritative.** Aucune source dérivée (mémoire vectorielle, cache, graphe de
   connaissances) ne devient la vérité métier.
2. **Memory n'est jamais la vérité métier.** Toute information mémorisée porte une source, un niveau
   de confiance et une portée (Master Plan §11) ; en cas de conflit avec PostgreSQL, PostgreSQL
   gagne toujours (voir CAS 8 du [catalogue de tests](./10-behavioral-tests.md)).
3. **EventBus ne remplace pas l'Event Journal.** Un EventBus (pub/sub interne, traces d'exécution)
   peut coexister comme mécanisme de notification, mais l'écriture d'audit métier (`audit_entries`)
   reste append-only en base relationnelle, avant exécution.
4. **Scheduler ne remplace pas Temporal automatiquement.** Un scheduler persistant simple (cron,
   tâches périodiques) est légitime pour de la planification sans état de reprise complexe ; un
   moteur de workflow durable (Temporal ou équivalent) n'est introduit que lorsque la Mission a
   besoin de reprise multi-étapes avec état intermédiaire garanti (voir
   [08-technology-timeline.md](./08-technology-timeline.md)).
5. **MCP n'est pas un permission model.** Protocole d'intégration, jamais frontière d'autorisation ni
   protocole intra-domaine universel.
6. **Heartbeat n'est pas une autorité.** Une proposition du `ProactiveAgent` passe toujours par le
   Policy Engine ; aucune auto-approbation de niveau trivial.
7. **OmniRoute reste le moteur de routage technique.** Providers, comptes, credentials, OAuth,
   catalogue modèles, quotas, health, pricing technique, circuit breakers, retries et fallback ne
   sont pas dupliqués dans ICOS.
8. **ICOS définit les politiques de sélection.** ICOS reste le Control Plane métier (policies,
   restrictions, projections dérivées) au-dessus du routage technique d'OmniRoute.
9. **Aucun agent ne possède de credential provider.** Aucun agent n'accède directement à un
   credential provider.
10. **Aucun agent ne choisit librement son provider.** La sélection modèle reste gouvernée par ICOS,
    jamais par choix libre d'un agent.
11. **Aucun agent/canal/skill ne contourne Policy/Approval.** Quel que soit le chemin d'exécution
    (skill, outil MCP, scheduler, proactivité, canal), une action sensible (niveau ≥ 2 du Master Plan
    §5) passe toujours par la même porte d'évaluation.
12. **Aucun retry/fallback ne provoque de double action externe.** L'`idempotencyKey` et
    l'`ExecutionRecord` garantissent qu'aucun effet externe n'est dupliqué.
13. **Aucun agent ne peut augmenter ses propres permissions** ni celles d'un autre agent (Master Plan
    invariant 1, §6).
14. **L'identité humaine et l'identité agent restent distinctes** (rôle humain ≠ niveau d'autonomie
    agent).

## Cinq prochains lots recommandés

Après achèvement du Lot 2B-2 :

1. **C1 — Capability Registry** ;
2. **C2 — Skill Registry & Trust Lifecycle** ;
3. **D1 — Policy/Approval Engine v2** ;
4. **D2 — Mission, Plan, Run & Event Journal** ;
5. **D3 — AI Gateway / OmniRoute Business Layer**.

C3 SkillsMP Discovery peut démarrer en parallèle après C2. D3 précède impérativement D4
Orchestrateur v1, mais reste un petit lot de frontière : il ne reconstruit aucun registre ou routeur
technique déjà fourni par OmniRoute.

## Désaccords ou corrections apportées au Master Plan

- **OmniRoute** : l'audit v3.8.49 montre qu'il possède déjà les providers/comptes/credentials,
  catalogues, quotas, health, pricing, circuit breakers, retries, fallback, routage multi-account et
  télémétrie technique. La cible est donc un business control plane ICOS au-dessus d'OmniRoute, pas un
  second ModelRouter. ICOS exprime WHY/WHAT/contraintes ; OmniRoute décide HOW/WHERE.
- **Risque 0-4 vs code réel 3 valeurs** : la vision 0-4 est retenue mais doit être migrée de façon
  additive et compatible ; une substitution immédiate casserait des garanties déjà testées.
- **Temporal** : non requis avant le premier orchestrateur. L'état PostgreSQL suffit au run court ;
  Temporal vient après preuve d'un besoin de saga/attente durable complexe.
- **Graphiti** : non requis pour la première mémoire. PostgreSQL FTS puis pgvector mesuré sont plus
  simples et cohérents avec la source de vérité.
- **MCP** : protocole d'intégration, pas permission model ni protocole intra-domaine universel.
- **Self-improvement** : aucun cycle automatique ne peut aboutir à activation sans revue et
  approbation humaines.
