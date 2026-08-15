# Architecture future ICOS — Vue d'ensemble

> **Statut : proposition d'architecture, non validée.**
> Document produit dans le worktree `docs/future-architecture`, sans modification de code applicatif.
> Sources : `docs/ICOS_MASTER_PLAN.md`, ADR 0001-0007, `docs/architecture/overview.md`,
> `docs/roadmap/initial-roadmap.md`, l'état réel de `src/`, l'audit Holding IA et l'audit OpenJarvis
> (voir [07-reuse-mapping.md](./07-reuse-mapping.md)).

## 1. Où en est réellement ICOS aujourd'hui

Le Master Plan décrit une cible ambitieuse (§4, §7, §16 : Mission → plan → agents → skills →
exécution → vérification → approbation → livraison → audit → mémoire). Le code réel, au 23 juillet
2026, est beaucoup plus étroit — et c'est une bonne nouvelle : chaque brique existante est petite,
testée, et gouvernée par des invariants stricts qu'il faut _étendre_, jamais contourner.

### 1.1 Modèle de domaine réel

```text
Agent (id, name, role, status, authorizationLevel 0-3, description)
Task (id, title, description?, status, assignedAgentId?, createdAt, updatedAt)
  status: draft → queued → {awaiting_approval, running, cancelled}
          queued → awaiting_approval → {running, cancelled}
          running → {succeeded, failed, cancelled}
          (états terminaux : aucune sortie)
AgentAction (id, initiatedByAgentId, taskId?, kind, risk, requiresHumanApproval,
             approvalStatus, requestedAt)
  risk: read_only | reversible | sensitive
  approvalStatus: not_required | pending | approved | rejected
Approval (id, actionId, decision, decidedByLabel, reason?, decidedAt)
  UNIQUE(actionId) — au plus une décision finale par action
AuditEntry (id, eventType, actorType, actorLabel, taskId?, actionId?, details JSON, occurredAt)
  eventType ∈ 12 valeurs figées (check constraint SQL)
```

**Il n'existe aujourd'hui ni `Mission`, ni `Run`, ni `Plan`, ni `Skill`, ni `Memory`.** Le domaine est
un graphe plat Task → Action → Approval → Audit. C'est la référence structurante de tout ce
document : chaque lot futur doit dire explicitement comment il _étend_ ce graphe, jamais comment il
le remplace.

### 1.2 Le Policy Engine existe déjà — en miniature

`src/core/authorization/decide.ts` (`decideExecution`) EST le moteur de politique actuel. Ses
garanties, non négociables, sont déjà correctes et doivent survivre à toute évolution :

- un rejet humain est **définitif** — aucune réévaluation ultérieure ne peut le renverser ;
- un niveau d'autorisation insuffisant **refuse toujours**, jamais n'attend ;
- une action `sensitive` exige **toujours** une approbation humaine explicite, **même si**
  `requiresHumanApproval` est déclaré `false` — la politique prime sur la déclaration ;
- un état inconnu ou incohérent **refuse**, jamais n'autorise implicitement.

Le futur "Policy/Approval Engine" du Master Plan (§5 architecture cible) n'est donc pas une brique à
construire ex nihilo : c'est l'extension de cette fonction pure vers un service capable d'évaluer des
politiques nommées, versionnées, et couvrant des risques au-delà de read_only/reversible/sensitive
(ex. niveaux 0-4 du Master Plan §5). La compatibilité de comportement avec `decideExecution` est un
critère d'acceptation de tout lot qui y touche.

### 1.3 L'audit est déjà un event journal append-only

`audit_entries` est append-only **au niveau SQL** (trigger, migration `0001`), pas seulement par
convention applicative. C'est déjà l'`Event Journal` visé par le Master Plan §7.7 et §23, dans un
périmètre restreint (12 types d'événements). Un futur "EventBus technique" (cf. OpenJarvis) ne doit
**jamais** se substituer à cette table : voir [invariant EventBus ≠ Event Journal](#4-invariants-non-négociables).

### 1.4 Composition root et persistance

`src/server/container.ts` assemble tous les repositories derrière des ports asynchrones
(`server/repositories/ports.ts`), avec sélection de backend explicite (`memory` | `postgres`,
`server/persistence.ts`), sans fallback silencieux, et probe de connexion/schéma unique à
l'initialisation. Toute nouvelle entité future (Mission, Run, Skill, MemoryRecord...) doit suivre
exactement ce patron : port async, `null` pour absence, repository mémoire ET PostgreSQL dès le
départ, câblage dans `Container`.

### 1.5 Identité humaine vs autorisation agent — déjà séparées

Le Lot 2B-1b a posé une séparation stricte que le Master Plan exige (§18, invariant 9-10) :
`user_roles` (rôle humain : owner ⊇ admin ⊇ operator ⊇ viewer, `src/core/identity`) est totalement
indépendant d'`Agent.authorizationLevel` (0-3, autonomie agent). Cette séparation doit rester
intacte dans toute évolution — en particulier le futur `HumanAgentLink` (Lot 2B-2, Phase B du Master
Plan) ne doit pas fusionner ces deux notions.

## 2. Ce qui manque pour atteindre la cible du Master Plan

En miroir de la Phase A "largement réalisée" (Master Plan §19-20), les phases B → K restent à
construire. Ce document propose une trajectoire concrète pour les phases **C à K**, sous forme de
lots implémentables (voir [05-lot-catalogue.md](./05-lot-catalogue.md)), séquencés par dépendance
réelle (voir [02-dependency-graph.md](./02-dependency-graph.md)) et non par numérotation arbitraire.

| Écart                   | État réel                                                       | Cible Master Plan                                                                  |
| ----------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Unité de travail métier | `Task` isolée                                                   | `Mission` → `Plan` → `Task[]` avec délégation, dépendances                         |
| Registre de compétences | Aucun                                                           | `Skill` versionné, sourcé, quarantainé, attribué (§9)                              |
| Mémoire                 | Aucune (contexte reconstruit à chaque appel)                    | 5+ types de mémoire séparés, avec provenance et expiration (§11)                   |
| Orchestrateur           | Absent — les Route Handlers appellent directement les use cases | Décomposition, sélection agents/skills, plan, reprise (§7.2)                       |
| Politique de risque     | 3 niveaux (read_only/reversible/sensitive)                      | 5 niveaux (0-4, §5), avec interdiction explicite d'auto-élévation                  |
| Routage modèle          | Aucun (pas encore de génération IA en boucle)                   | Control Plane ICOS pilotant OmniRoute, infrastructure durable multi-provider (§13) |
| Canaux                  | Cockpit web uniquement                                          | web/desktop/terminal/mobile/voix + Twilio (§12)                                    |
| Intégrations            | Aucune active                                                   | GitHub, Gmail, Calendar, Drive, n8n, Dolibarr, CMS (§14)                           |

## 3. Couches cibles — mappées sur le code réel

```text
┌─────────────────────────────────────────────────────────────────┐
│ Couche conversationnelle (Phase F)                                │
│   compréhension intention · résolution contexte · clarification   │
│   minimale · niveau de détail adaptatif                           │
└───────────────────────────┬─────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│ Orchestrateur (Phase D)                                            │
│   décompose Mission → Plan → Task[] · sélectionne agents/skills   │
│   · applique le Policy Engine · gère reprise/erreur                │
└───────┬───────────────┬──────────────┬────────────────┬──────────┘
        ↓                ↓              ↓                ↓
┌───────────────┐ ┌─────────────┐ ┌────────────┐ ┌──────────────────┐
│ Agents         │ │ Skill        │ │ Memory /    │ │ Tool/MCP Gateway  │
│ (existant,     │ │ Registry     │ │ Context Port│ │ (Phase G)         │
│ étendu Phase B)│ │ (Phase C)    │ │ (Phase E)   │ │                   │
└───────┬───────┘ └──────┬──────┘ └─────┬──────┘ └────────┬─────────┘
        │                │               │                 │
        └────────────────┴───────┬───────┴─────────────────┘
                                  ↓
                  ┌───────────────────────────────┐
                  │ Policy/Approval Engine          │
                  │ (extension de decideExecution)  │
                  └───────────────┬─────────────────┘
                                  ↓
                  ┌───────────────────────────────┐
                  │ AI Business Control Plane ICOS  │
                  │ CapabilityRequirement · privacy │
                  │ quality · budget · restrictions │
                  │ AiGatewayPort → OmniRouteAdapter│
                  └───────────────┬─────────────────┘
                                  ↓
                  ┌───────────────────────────────┐
                  │ OmniRoute — runtime externe     │
                  │ providers · accounts · models   │
                  │ health · quota · routing · retry│
                  └───────────────┬─────────────────┘
                                  ↓
                  ┌───────────────────────────────┐
                  │ Event Journal (audit_entries,   │
                  │ append-only, SQL trigger)        │
                  └───────────────┬─────────────────┘
                                  ↓
                  ┌───────────────────────────────┐
                  │ PostgreSQL — source de vérité    │
                  │ authoritative                    │
                  └───────────────────────────────┘
```

Les intégrations externes (GitHub, Gmail, n8n, Dolibarr, Shopify, Twilio...) n'apparaissent qu'au
niveau du Tool/MCP Gateway — jamais appelées directement par un agent ou une skill, conformément à
l'invariant existant ("Une intégration ne devra jamais être appelée directement depuis un
composant", `docs/architecture/overview.md`).

## 4. Architecture en Port/Adapter

Chaque capability externe passe par un port abstrait ICOS et un adapter isolé. Le domaine ne connaît
jamais l'implémentation sous-jacente.

| Port                 | Adapter                                         | Runtime externe | Obligatoire pour M1 ?        |
| -------------------- | ----------------------------------------------- | --------------- | ---------------------------- |
| `AiGatewayPort`      | `OmniRouteAdapter`                              | OmniRoute       | Oui                          |
| `MemoryPort`         | `PostgresMemoryAdapter`, `Mem0Adapter` (future) | Postgres + Mem0 | Oui (Postgres); Mem0 = DEFER |
| `BrowserPort`        | `BrowserUseAdapter`                             | Browser Use     | Non — E2+                    |
| `DevelopmentGateway` | `OpenHandsAdapter`                              | OpenHands       | Non — E3+                    |
| `SandboxPort`        | `DockerSandboxAdapter`, `E2BSandboxAdapter`     | Docker / E2B    | Non — E4+                    |
| `ObservabilityPort`  | `LangfuseAdapter`                               | Langfuse        | Non — E5+                    |

**Règle** : ICOS construit les ports, adapte les runtimes, et garde la policy. Les runtimes
externes exécutent. Aucun runtime ne devient la source de vérité métier.

### Priorité d'introduction

1. **D3** : `AiGatewayPort` + `OmniRouteAdapter` — obligatoire avant premier appel modèle.
2. **E1** : `MemoryPort` avec `PostgresMemoryAdapter` — obligatoire pour contexte.
3. **E2** : `BrowserPort` + `BrowserUseAdapter` — seulement si besoin navigation démontré.
4. **E3** : `DevelopmentGateway` + `OpenHandsAdapter` — seulement si besoin coding démontré.
5. **E4** : `SandboxPort` + Docker/E2B — seulement si exécution code non fiable requise.
6. **E5** : `ObservabilityPort` + `LangfuseAdapter` — seulement si tracing IA en production.

## 4. Invariants non négociables

La liste canonique et unique des invariants architecturaux ICOS vit désormais dans
[00-executive-summary.md § Invariants finaux](./00-executive-summary.md#invariants-finaux) ; ce
document ne la duplique plus, pour éviter toute dérive entre deux formulations.

Résumé très court pour la lecture de ce chapitre : PostgreSQL authoritative, Memory jamais vérité
métier, EventBus ≠ Event Journal, Scheduler ≠ Temporal, MCP ≠ permission, Heartbeat ≠ autorité,
OmniRoute = routage technique / ICOS = policy métier, aucun contournement de Policy/Approval, aucune
auto-élévation de permission, identité humaine ≠ identité agent, aucun retry/fallback ne double un
effet externe.

## 5. Ce que ce document ne fait pas

- Il ne modifie aucun code applicatif, migration, dépendance ou configuration.
- Il ne tranche pas les décisions produit réservées à l'humain propriétaire (ex. priorisation entre
  Phase G "intégrations" et Phase H "Polivia/DigitalOS" au-delà de la dépendance technique) — ces
  points sont signalés explicitement là où ils apparaissent.
- Il ne remplace pas le Master Plan comme source de vérité produit ; il l'opérationnalise en lots
  implémentables.

## 6. Sommaire des livrables

| #   | Document                                                     | Contenu                                               |
| --- | ------------------------------------------------------------ | ----------------------------------------------------- |
| 1   | [01-overview.md](./01-overview.md)                           | Ce document                                           |
| 2   | [02-dependency-graph.md](./02-dependency-graph.md)           | Graphe de dépendances entre composants futurs         |
| 3   | [03-critical-path.md](./03-critical-path.md)                 | Chemin critique et parallélisation                    |
| 4   | [04-lot-sequence.md](./04-lot-sequence.md)                   | Séquence de lots recommandée                          |
| 5   | [05-lot-catalogue.md](./05-lot-catalogue.md)                 | Catalogue détaillé des lots futurs                    |
| 6   | [06-adr-backlog.md](./06-adr-backlog.md)                     | Backlog d'ADR                                         |
| 7   | [07-reuse-mapping.md](./07-reuse-mapping.md)                 | Cartographie de réutilisation Holding IA + OpenJarvis |
| 8   | [08-technology-timeline.md](./08-technology-timeline.md)     | Calendrier d'introduction technologique               |
| 9   | [09-risk-register.md](./09-risk-register.md)                 | Registre des risques architecturaux                   |
| 10  | [10-behavioral-tests.md](./10-behavioral-tests.md)           | Catalogue de tests comportementaux                    |
| 11  | [11-first-autonomous-icos.md](./11-first-autonomous-icos.md) | Jalon premier ICOS autonome                           |
| 12  | [12-parallelization.md](./12-parallelization.md)             | Opportunités de parallélisation                       |
| —   | [00-executive-summary.md](./00-executive-summary.md)         | Synthèse exécutive (dernier document produit)         |
