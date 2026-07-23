# Pack de compétences ICOS — conception

## Statut et objectif

Ce document définit un pack de 8 compétences (skills) internes destinées à
guider tout développement futur d'ICOS au-delà du socle actuel (Phase 0/1).
Il ne modifie aucun code applicatif, aucune migration, aucune dépendance, et
ne touche pas au Lot 2B-2 en cours dans le dépôt principal. Il produit
uniquement de la documentation et des fichiers de compétences dans ce
worktree indépendant (`icos-research`).

Chaque compétence est un guide de jugement, pas un générateur de code : elle
définit ce qu'un agent doit vérifier, refuser ou questionner avant d'agir sur
un domaine donné d'ICOS, conformément aux ADR existants
(`docs/decisions/0001` à `0007`), à l'architecture
(`docs/architecture/overview.md`) et à la feuille de route
(`docs/roadmap/initial-roadmap.md`).

## Principe directeur

**ICOS reste la source de vérité architecturale.** Holding IA
(`SGNG21/holding-ia`) est un dépôt legacy, lu en lecture seule, qui ne sert
que de réservoir d'idées et de composants potentiels — jamais de modèle à
suivre par défaut. Aucune implémentation qui s'y trouve n'est considérée
fiable tant qu'elle n'a pas été inspectée et classée
REUSE / ADAPT / REBUILD / DISCARD par la compétence `icos-legacy-reuse`.

## Les 8 compétences

| Compétence | Rôle | Phase roadmap principale |
| --- | --- | --- |
| `icos-architecture` | Frontières de couches, contrats, extraction | Transversale (0→3) |
| `icos-security` | Auth, autorisation, secrets, audit | Transversale (1→3) |
| `icos-postgresql` | Schéma, migrations, transactions, erreurs | Phase 1 |
| `icos-rag-memory` | Mémoire conversationnelle, embeddings, pgvector | Phase 2 |
| `icos-agent-orchestration` | Cycle de vie des tâches, agents spécialisés | Phase 3 |
| `icos-workflows-temporal` | Exécution durable multi-étapes | Phase 3 |
| `icos-mcp-integrations` | Exposition/consommation d'outils MCP | Phase 3 |
| `icos-legacy-reuse` | Évaluation systématique de Holding IA | Transversale |

Le contenu détaillé (objectif, contexte d'utilisation, invariants,
vérifications préalables, technologies autorisées, anti-patterns, sécurité,
stratégie TDD, définition de done) vit dans chaque
`.claude/skills/icos-*/SKILL.md`. Ce document couvre la conception
d'ensemble : frontières, déclenchement, et matrice de capacités.

## Frontières entre compétences (éviter le chevauchement)

L'architecture ICOS a une règle constante : une compétence gouverne un
**invariant**, pas une **technologie**. Deux compétences peuvent toucher le
même fichier ; elles ne doivent jamais statuer sur la même question.

- **`icos-architecture` vs les autres** — `icos-architecture` est la
  compétence de dernier recours pour « dans quelle couche ce code va-t-il ? ».
  Les 7 autres compétences supposent les frontières déjà connues et se
  concentrent sur leur domaine. Si une compétence spécialisée hésite sur une
  question de couche, elle renvoie à `icos-architecture`.
- **`icos-security` vs `icos-postgresql`** — `icos-security` statue sur *qui*
  peut faire *quoi* (rôles, permissions, approbation humaine, contenu
  d'audit). `icos-postgresql` statue sur *comment* la donnée est stockée et
  rendue atomique. Une garde d'autorisation (guard HTTP, `requirePermission`)
  relève de `icos-security` ; un verrou `FOR UPDATE` ou un trigger
  append-only relève de `icos-postgresql`. Les deux se retrouvent sur
  l'unité de travail transactionnelle (Lot 2A-2b) : `icos-postgresql` définit
  l'atomicité, `icos-security` définit ce que l'audit doit/ne doit pas
  contenir.
- **`icos-postgresql` vs `icos-rag-memory`** — `icos-postgresql` fixe la
  mécanique générique (Drizzle, migrations additives, mapping Zod,
  transactions, erreurs). `icos-rag-memory` hérite de ces invariants mais
  ajoute des règles propres aux embeddings et à la mémoire IA : dimension
  vectorielle figée par contrat, fournisseur d'embedding derrière une
  interface, jamais d'embedding silencieusement absent ou substitué. Une
  extension `pgvector` ou une colonne `embedding` passe d'abord par
  `icos-postgresql` pour le schéma, puis par `icos-rag-memory` pour la
  sémantique de rétention et de recherche.
- **`icos-agent-orchestration` vs `icos-workflows-temporal`** —
  `icos-agent-orchestration` définit les règles *métier* : quels agents
  existent, leur niveau d'autorisation, qui peut initier/décider une tâche,
  la séparation stricte humain/agent. `icos-workflows-temporal` définit le
  *substrat d'exécution* : comment un processus long, interruptible et
  reprenable est orchestré techniquement (Temporal workflows/activities). Une
  tâche métier simple, transactionnelle et rapide reste dans
  `icos-postgresql`/`icos-agent-orchestration` sans jamais invoquer Temporal ;
  Temporal n'intervient que lorsque l'exécution dépasse la durée ou la
  fiabilité d'une transaction Postgres unique (anti-pattern détaillé dans le
  SKILL.md correspondant).
- **`icos-agent-orchestration` vs `icos-mcp-integrations`** —
  `icos-agent-orchestration` gouverne le modèle *interne* d'agents ICOS (leur
  cycle de vie, leurs décisions). `icos-mcp-integrations` gouverne
  l'*exposition/consommation* de capacités via le protocole MCP, qu'il
  s'agisse d'un outil MCP qu'ICOS expose à un client externe (IDE, Claude
  Code) ou d'un serveur MCP externe qu'ICOS consomme (GitHub, n8n). Un appel
  MCP entrant est toujours traité comme une action soumise au pipeline
  `decideExecution` normal — jamais un chemin d'exécution parallèle.
- **`icos-legacy-reuse` vs toutes les autres** — `icos-legacy-reuse` ne
  définit aucun invariant technique propre à ICOS. C'est une compétence de
  *méthode* : elle s'invoque avant qu'une des 7 autres compétences ne
  commence une conception, pour vérifier si Holding IA offre une idée ou un
  composant exploitable. Elle ne remplace jamais le jugement de la compétence
  spécialisée concernée.

## Déclenchement (résumé)

Le déclenchement précis de chaque compétence est porté par le champ
`description` de son `SKILL.md` (convention « Use when... »). Résumé :

| Compétence | Se déclenche quand… |
| --- | --- |
| `icos-architecture` | nouveau module, doute sur la couche, nouvelle frontière de contrat |
| `icos-security` | auth, session, rôle, permission, secret, audit, action sensible |
| `icos-postgresql` | schéma Drizzle, migration, repository, transaction, erreur de persistance |
| `icos-rag-memory` | mémoire conversationnelle, rétention, embeddings, pgvector, RAG |
| `icos-agent-orchestration` | cycle de vie de tâche, agents spécialisés, résolution de privilège agent |
| `icos-workflows-temporal` | exécution longue, multi-étapes, devant survivre à un redémarrage |
| `icos-mcp-integrations` | exposition ou consommation d'un outil/serveur MCP |
| `icos-legacy-reuse` | avant toute nouvelle capacité ICOS, pour vérifier l'existant dans Holding IA |

## Matrice : capacité future → compétence → technologie → composant Holding IA → priorité → échéance roadmap

Verdicts Holding IA issus de l'audit en lecture seule mené dans cette
session (SGNG21/holding-ia, commit courant). Priorité : **P1** (bloquant pour
la phase roadmap indiquée), **P2** (utile mais différable), **P3**
(exploratoire, non engagé).

| Capacité future | Compétence | Technologie envisagée | Composant Holding IA | Verdict | Priorité | Phase roadmap |
| --- | --- | --- | --- | --- | --- | --- |
| Moteur de politiques (Policy Engine) | `icos-security` | Extension de `core/authorization` (pur, testé), pas de moteur externe | `knowledge/procedures/ARCHITECTURE-gates.md` (paliers auto/gate/hard_gate) | **ADAPT** (idée de palier de risque uniquement — jamais le code, le chemin « auto » n'était qu'un stub jamais exécuté) | P1 | Phase 1 |
| Approbations humaines persistées | `icos-security` + `icos-postgresql` | Déjà en place (Lot 2A-2b) ; formaliser matrice de permissions | `n8n/action-dispatch.json`, `n8n/action-create.json`, `n8n/action-decision.json` | **ADAPT** (idée du workflow de dispatch, pas le nœud n8n) | P1 | Phase 1 (fait pour l'essentiel) |
| Workflows métier (orchestration de tâches) | `icos-agent-orchestration` | Use cases + UoW existants ; Temporal seulement si durée/fiabilité l'exige | n8n comme moteur d'orchestration | **REBUILD/DISCARD** (7-8/29 workflows actifs, identifiants figés, dérive de credentials — cf. `AUDIT.md` §4) | P2 | Phase 3 |
| pgvector / RAG (base de connaissance) | `icos-rag-memory` | `pgvector` sous Postgres existant, Drizzle, fournisseur d'embedding derrière interface | `knowledge_base`, `client_memory` (schema.sql) | **DISCARD** (code — `embedding_skipped: true`, embeddings NULL constatés, `ETAT_ACTUEL.md` §4) / **ADAPT** (forme du schéma seulement, avec dimension vectorielle et fournisseur figés dès le départ, jamais de fallback silencieux) | P1 | Phase 2 |
| Graphiti (graphe de connaissances temporel) | `icos-rag-memory` | À évaluer indépendamment ; aucune preuve dans Holding IA | non trouvé dans Holding IA | **N/A** — aucune base de comparaison ; évaluation à faire sur critères ICOS seuls (coût, dépendance externe significative → relève d'une décision nécessitant validation explicite de l'utilisateur avant adoption) | P3 | Phase 2+ |
| Orchestration d'agents spécialisés | `icos-agent-orchestration` | Résolution serveur stricte de l'agent (`initiatedByAgentId`), pas de table de messagerie agent-à-agent | `agents/` (57 prompts), `supabase/agent-communication.sql` | **ADAPT** (idée du routage de modèle par niveau de risque) / **DISCARD** (tables de messagerie — dérive prod/schéma confirmée, `ETAT_ACTUEL.md` §3, aucun consommateur réel) | P1 | Phase 3 |
| Modèle de routage Opus/Sonnet/Haiku par risque | `icos-agent-orchestration` | Politique déclarative dans `core`, jamais codée en dur côté prompt | `CLAUDE.md`/`agents/CLASSIFICATION.md` (discipline) vs `AUDIT.md` §1.3/§2.2 (violation : prompts dupliqués, ~35 « agents fantômes ») | **ADAPT** (le principe, avec un fichier canonique unique et testé — jamais la duplication constatée) | P2 | Phase 3 |
| Temporal (exécution durable) | `icos-workflows-temporal` | Temporal Cloud ou self-hosted — dépendance externe significative, nécessite validation explicite | aucun usage dans Holding IA | **N/A** — aucune preuve à évaluer ; introduction future soumise à décision explicite (dépendance externe significative) | P3 | Phase 3 |
| MCP (exposition/consommation d'outils) | `icos-mcp-integrations` | Serveurs MCP standards, pipeline `decideExecution` inchangé | aucun usage réel dans Holding IA (mentions incidentes seulement) | **N/A** — aucune preuve à évaluer ; conception à faire sur les invariants ICOS seuls | P2 | Phase 3 |
| Intégration GitHub (lecture seule d'abord) | `icos-mcp-integrations` | GitHub via MCP ou API REST directe, lecture seule en premier | non applicable | **N/A** | P2 | Phase 3 |
| Intégration n8n (lecture seule d'abord) | `icos-mcp-integrations` | Appel HTTP contrôlé vers instance n8n existante, lecture seule en premier | `n8n/` (workflows), VPS self-hosted | **REBUILD** si réutilisé (crédentiels pourris, workflows majoritairement inactifs — `AUDIT.md` §4) ; ICOS ne doit pas dépendre de l'instance Holding IA actuelle | P2 | Phase 3 |
| Hooks (cycle de vie d'action/tâche) | `icos-architecture` + `icos-security` | Hooks internes typés (pré/post mutation), pas de hooks shell arbitraires | aucun équivalent structuré trouvé | **N/A** | P2 | Phase 1→3 |
| Observabilité (OpenTelemetry) | `icos-architecture` | OTel SDK Node, exporteur configurable, aucun secret dans les traces | aucun usage dans Holding IA | **N/A** — dépendance externe non triviale si backend managé choisi ; décision d'introduction soumise à validation explicite | P2 | Phase 2→3 |
| Evals (qualité des réponses IA) | `icos-rag-memory` + `icos-agent-orchestration` | Suite d'évaluation interne (jeux de cas + assertions), pas de SaaS externe par défaut | aucun usage dans Holding IA | **N/A** | P2 | Phase 2 |
| Tests bout-en-bout (Playwright) | `icos-architecture` | Playwright, exécuté en local/CI, jamais contre une instance de production | aucun usage dans Holding IA | **N/A** — nouvelle dépendance de développement, soumise à validation explicite avant ajout | P2 | Phase 1→3 |
| CI (GitHub Actions) | `icos-architecture` + `icos-security` | Pipeline `pnpm check` + `test:integration` (Docker) + `build`, secrets via GitHub Encrypted Secrets uniquement | aucun usage trouvé (déploiement Vercel direct dans Holding IA) | **N/A** — introduction soumise à validation explicite (accès à des secrets de déploiement) | P1 | Phase 1 |
| Sécurisation des secrets (checklist d'accès) | `icos-security` | Processus documentaire interne, jamais de secret en clair dans un fichier versionné | `docs/autonomie/checklist-acces-*.md` | **ADAPT** (format de checklist uniquement — Holding IA a documenté sa propre fuite de `VITE_CLAUDE_API_KEY` côté client, cf. `ROADMAP.md` section SÉCURITÉ) | P1 | Transversale |

**Lecture de la matrice** : toute ligne marquée **N/A** signifie qu'aucune
preuve exploitable n'existe dans Holding IA — la compétence correspondante
doit concevoir sur la base des ADR ICOS et des bonnes pratiques générales,
sans référence de réutilisation. Toute introduction d'une dépendance externe
significative (Temporal, un backend OTel managé, un service d'embedding
tiers, Playwright, GitHub Actions avec accès à des secrets de déploiement)
reste, conformément à la directive de l'utilisateur, soumise à validation
explicite avant toute décision d'adoption — cette matrice documente des
options, pas des décisions.

## Audit local OpenJarvis — enseignements vérifiés

Inspection en lecture seule de `.openjarvis-audit/OpenJarvis-main` à la
révision `3a9f20617637e747a14f015c6fd9104d85a0541d`. Aucun code, fichier,
dépendance ou choix de stack OpenJarvis n'est repris dans ICOS. Les verdicts
ci-dessous portent sur les **patterns**, à réimplémenter selon les invariants
ICOS lorsqu'ils sont retenus.

| Zone inspectée | Constat source vérifié | Verdict ICOS |
| --- | --- | --- |
| SkillManager, manifests, dépendances | Manifest versionné avec étapes, capacités et dépendances ; validation des cycles et de la profondeur avant exécution (`skills/types.py`, `dependency.py`, `manager.py`) | **ADAPT** — conserver contrats déclaratifs et validations, avec contrats Zod et gouvernance ICOS |
| Trust, provenance, capacités dangereuses | Tiers `bundled/workspace/indexed/unreviewed`, sidecar `.source`, détection de trois capacités dangereuses ; blocage à l'import seulement pour `unreviewed` dangereux (`skills/security.py`, `importer.py`) | **ADAPT** provenance/trust ; **REBUILD** l'enforcement fail-closed ICOS ; **DISCARD** toute équivalence trust = permission |
| Découverte depuis les traces | Sous-séquences de 2 à 4 outils retenues par fréquence/outcome, puis manifests écrits dans `skills/discovered/` (`learning/agents/skill_discovery.py`, `skills/manager.py`) | **ADAPT** en proposition `SkillCandidate` ; **REBUILD** le lifecycle gouverné, absent d'OpenJarvis |
| Agent / Capability / Skill / Tool | Agent persistant, capacité comme exigence de policy, skill comme procédure, `SkillTool` comme adaptateur vers `BaseTool` (`agents/manager.py`, `security/capabilities.py`, `skills/tool_adapter.py`, `tools/_stubs.py`) | **ADAPT** la séparation conceptuelle ; réimplémentation dans le domaine ICOS |
| MemoryBackend, hybrid retrieval, provenance | Port `MemoryBackend`, résultats avec `source`/metadata, fusion sparse+dense par RRF (`tools/storage/_stubs.py`, `hybrid.py`) ; facts best-effort en JSONL (`memory/store.py`, `service.py`) | **ADAPT** retrieval/provenance derrière le Context Port ; **DISCARD** comme état métier ou fallback de PostgreSQL |
| ProactiveAgent / heartbeat | Cron collecte des données et propose des actions, mais auto-approuve le tier `trivial` et les permissions mémorisées (`agents/proactive_agent.py`) | **ADAPT** le trigger ; **DISCARD** toute autorité, auto-approbation ou mutation implicite de policy |
| Scheduler | Polling cron/interval/once, persistance des runs, ticks d'agents et détection de stalls (`scheduler/scheduler.py`, `agents/scheduler.py`) | **ADAPT** comme déclencheur observable ; **DISCARD** comme moteur de workflow durable |
| ApprovalStore / permission memory | Actions pending avec TTL et décisions persistées ; règles `always_approve/always_deny` réappliquées (`tools/approval_store.py`) | **ADAPT** TTL/traçabilité ; **REBUILD** sous PostgreSQL/policies ICOS ; **DISCARD** l'auto-élargissement des droits |
| MCP adapter/provider | Client découvre les specs, Provider crée des `MCPToolAdapter`, serveur expose les outils via `ToolExecutor` (`mcp/client.py`, `tools/mcp_adapter.py`, `mcp/server.py`) | **ADAPT** la frontière adapter/provider ; **DISCARD** toute exécution sans identité serveur et `decideExecution` |
| EventBus / traces | EventBus synchrone en mémoire avec historique optionnel ; TraceStore SQLite et feedback mutable (`core/events.py`, `traces/collector.py`, `traces/store.py`) | **ADAPT** télémétrie et corrélation ; **REBUILD** l'Event Journal immuable PostgreSQL ; **DISCARD** EventBus comme autorité |
| Model routing | Routeur heuristique déterministe ; routeur appris choisissant par classe après seuil d'échantillons et score traces/feedback (`learning/routing/router.py`, `learned_router.py`) | **ADAPT** déterministe-first, seuils, fallback et evals ; **DISCARD** promotion automatique d'une policy apprise |
| Evals et sécurité | Runner/scorer séparés, corpus sécurité avec vulnérabilités et pièges de faux positifs ; contrôles capacités, boundary scanning, taint et audit hash-chain (`evals/core/*`, `evals/datasets/security_scanner.py`, `evals/scorers/security_scanner.py`, `security/*`) | **REUSE** la forme corpus + scorer déterministe ; **ADAPT** défense en profondeur ; **DISCARD** defaults permissifs et scans post-hoc comme hard gate |

### Lifecycle de skills retenu pour ICOS

OpenJarvis n'implémente pas un état `quarantined`, `reviewed`, `approved`,
`active`, `deprecated` ou `revoked`. Son répertoire `discovered/` est une
zone de sortie, mais les manifests qui s'y trouvent sont ensuite chargeables
par un appel explicite à `discover()`. ICOS ne reprend donc pas ce lifecycle
implicite. La cible gouvernée est :

`discovered` → `quarantined` → `reviewed` → `approved` → `active` →
`deprecated`/`revoked`.

Seul `active` est invocable. Une découverte, signature, provenance ou
classification de trust ne peut jamais activer un skill, accorder une
capacité, modifier une permission/policy/hard gate, ni contourner une
approbation humaine. Un heartbeat, scheduler, EventBus, résultat mémoire ou
appel MCP ne constitue jamais une autorité ; PostgreSQL reste l'état métier
authoritative et l'Event Journal immuable reste distinct de la télémétrie.

## Emplacement des fichiers

- Compétences : `.claude/skills/icos-<nom>/SKILL.md` (convention standard de
  découverte Claude Code, cohérente avec `superpowers:writing-skills`).
- Conception : le présent document,
  `docs/superpowers/specs/2026-07-23-icos-skills-pack-design.md`.

## Hors périmètre (rappel)

Ce travail ne modifie aucun fichier sous `src/`, aucune migration, aucune
dépendance de `package.json`, ne touche pas à `main`, ne merge rien, et ne
touche pas au Lot 2B-2 (dépôt principal `/Users/coco/icos`).
