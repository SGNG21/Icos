# D4 — Runtime / Execution Layer

> **Lot D4 — Spec v1**
> Date : 2026-07-25
> Statut : DESIGN_READY_WAITING_FOR_D3
> Références : D2 (8cd58c7), D1 (c8cebbe), C2 (700290a), C1 (1c55cf6)
> Audit externe : NemoClaw (patterns sandbox/credential/network intégrés)

---

## 1. Problème

D2 Mission Engine (merged SHA 8cd58c7) gère l'orchestration durable :
Mission → Plan → Steps → Runs → transitions d'état. Mais D2 n'exécute rien.

ICOS a besoin d'une couche d'exécution contrôlée qui :

- reçoit un Run depuis D2 ;
- évalue les requirements du Step (agent, skill, outil, isolation) ;
- résout les credentials de manière sécurisée (jamais exposés aux workers) ;
- crée l'environnement d'exécution (workspace, worktree, sandbox limité) ;
- exécute le travail avec timeout, cancellation et heartbeat ;
- collecte le résultat ;
- retourne le résultat à D2 pour transition d'état.

Aujourd'hui, rien ne permet d'exécuter un Step D2 hors d'un contexte interactif.
Toute exécution non contrôlée est soit impossible, soit dangereuse.

---

## 2. Scope D4

### In Scope V1

- `RuntimeExecutionPort` — abstraction centrale d'exécution
- `WorkerDefinition` — ce qui est exécuté (agent, skill, commande)
- `WorkerRun` — instance d'exécution avec état, métadonnées
- `ExecutionRequest` — paramètres de lancement
- `ExecutionResult` — résultat normalisé
- Workspace isolation (worktree, path scope, cleanup lifecycle)
- Environment scoping (variables, secrets résolus, jamais credentials bruts)
- Timeout + cancellation (SIGTERM → SIGKILL, grace period)
- Heartbeat / process health
- Logs et artifacts collection
- Credential reference resolution (via CredentialBrokerPort) — jamais credentials bruts
- Credential policy gate : BLOCKED_BY_CREDENTIAL_POLICY si mécanisme indisponible
- Network policy enforcement (domaines autorisés/bloqués)
- D1 policy revalidation au moment approprié
- D2 integration (receive Run, return Result)
- Runtime state machine (STARTING ↔ RUNNING ↔ terminal)
- Retry boundaries (pas de retry automatique des actions externes)
- Recovery (worker death, runtime restart)

### Out of Scope V1

- Distributed scheduler (VPS nodes deferred)
- D3 AiGatewayPort integration (WAITING_FOR_D3_MERGED_CODE)
- Docker/container sandbox (pattern étudié, non implémenté)
- Multi-tenant scheduling
- Message queue / event bus
- Tool/Gateway G1 (sera D4 consommateur, pas propriétaire)
- Credential store (références seulement)
- Agent selection intelligence (D2 responsibility)
- Plan decomposition (D2 responsibility)

---

## 3. Architecture conceptuelle

```
D2 Mission Engine
│
│ addRun(stepIndex)
▼
┌─────────────────────────────────────────┐
│ D4 RuntimeExecutionPort                  │
├─────────────────────────────────────────┤
│ RuntimeExecutionService                   │
│                                           │
│  ┌─────────────────────┐                 │
│  │ ExecutionOrchestrator│                │
│  │ ├ Worker lifecycle   │                │
│  │ ├ State machine      │                │
│  │ └ Recovery           │                │
│  └─────────┬───────────┘                 │
│            │                             │
│     ┌──────┴──────┐                     │
│     │ Adapter Layer│                     │
│     ├──────────────┤                     │
│     │ LocalAdapter  │ ← V1               │
│     │ ACPAdapter   │ ← future            │
│     │ VPSAdapter   │ ← deferred          │
│     └──────┬──────┘                       │
│            │                             │
│     ┌──────┴──────┐                     │
│     │ Worker (process)                  │
│     │ Sandbox (isolation)               │
│     │ Workspace (worktree)              │
│     └─────────────┘                     │
├─────────────────────────────────────────┤
│ D4 Cross-Cutting                         │
│ ├ CredentialBrokerPort                   │
│ ├ NetworkPolicyPort                      │
│ ├ WorkspaceManager                       │
│ └ ArtifactCollector                      │
└─────────────────────────────────────────┘
          │
          │ result
          ▼
D2 Mission Engine (transition status)
```

### Flux d'exécution V1

```
D2                     D4                    Worker
 |                      |                      |
 |— addRun(stepIdx) —→ |                      |
 |                     |— createWorkspace() —→|
 |                     |— start()            →|
 |                     |   (process, timeout)  |
 |                     |     heartbeat· · ·· → |
 |                     |                      |— result
 |                     |← collectResult()     |
 |← return result      |                      |
```

---

## 4. Contrats D4 (Runtime)

### 4.1 RuntimeExecutionPort

```typescript
/**
 * Port central d'exécution D4.
 * D2 l'appelle pour exécuter un step ; D4 retourne le résultat.
 *
 * L'implémentation concrète (LocalRuntimeAdapter, ACPAdapter, etc.)
 * est branchée via le container.
 */
export interface RuntimeExecutionPort {
  /**
   * Démarre l'exécution d'un worker.
   * Lance la préparation (workspace, env, credentials), puis le worker.
   * Retourne immédiatement un WorkerRun (exécution asynchrone).
   */
  start(request: ExecutionRequest): Promise<WorkerRun>;

  /**
   * Récupère l'état courant d'un run.
   * Utilisé par D2 pour heartbeat/polling/recovery.
   */
  getRun(runId: string): Promise<WorkerRun | null>;

  /**
   * Annule un run en cours.
   * SIGTERM → grace period → SIGKILL.
   * Retourne l'état final du run (CANCELLED).
   */
  cancel(runId: string, reason?: string): Promise<WorkerRun>;

  /**
   * Liste les runs actifs (non terminaux).
   * Utilisé par D4 recovery au démarrage.
   */
  getActiveRuns(): Promise<WorkerRun[]>;

  /**
   * Attend la complétion d'un run (timeout inclus).
   * Retourne le résultat final.
   */
  waitForCompletion(runId: string, timeoutMs?: number): Promise<ExecutionResult>;

  /**
   * Collecte les logs et artifacts d'un run terminé.
   */
  collectArtifacts(runId: string): Promise<RunArtifacts>;
}
```

### 4.2 ExecutionRequest

```typescript
export interface ExecutionRequest {
  /** L'identifiant du Run D2 (mission.stepIndex) */
  runId: string;
  /** L'identifiant de la mission parente */
  missionId: string;
  /** L'identifiant du tenant */
  tenantId: string;

  // ── Exécution ──
  /** Type de worker à lancer */
  workerType: "agent" | "shell" | "tool";
  /** Définition du worker */
  worker: WorkerDefinition;

  // ── Workspace ──
  /** Chemin racine du workspace alloué */
  workspacePath?: string;
  /** Mode d'isolation git */
  gitIsolation?: "worktree" | "branch" | "none";

  // ── Policy ──
  /** Niveau d'autorisation requis */
  requiredAuthLevel: AuthorizationLevel;
  /** Niveau de risque attendu */
  riskLevel: RiskLevel;

  // ── Limites ──
  /** Timeout en ms (0 = pas de timeout) */
  timeoutMs: number;
  /** Intervalle de heartbeat en ms */
  heartbeatIntervalMs: number;

  // ── Credentials (références uniquement) ──
  credentialRefs?: CredentialReference[];

  // ── Réseau ──
  networkPolicy?: NetworkPolicy;

  // ── Environnement ──
  envVars?: Record<string, string>;
}
```

### 4.3 WorkerDefinition

```typescript
export interface WorkerDefinition {
  /** Type d'exécution */
  kind: "agent" | "shell" | "tool" | "ai_call";

  // Pour un agent (Claude Code, Codex, etc.)
  agentId?: string;
  agentCommand?: string;           // ex: "claude", "codex"
  agentArgs?: string[];
  agentInstructions?: string;      // prompt initial

  // Pour un shell command
  command?: string;
  args?: string[];

  // Pour un tool MCP (future G1 integration)
  toolRef?: string;
  toolInput?: Record<string, unknown>;

  // Pour un appel IA (WAITING_FOR_D3_MERGED_CODE)
  // D3 contrat attendu : generate(AiRoutingRequest, AbortSignal) → AiGenerationResult
  aiRequest?: AiRoutingRequest;

  // Isolation requise
  isolation: ExecutionIsolationLevel;
  networkMode: NetworkMode;
}

export type ExecutionIsolationLevel = "none" | "process" | "worktree" | "container" | "sandbox";

export type NetworkMode = "none" | "outbound" | "restricted" | "full";
```

### 4.4 WorkerRun

```typescript
export interface WorkerRun {
  id: string;
  runId: string;            // lien vers le Run D2
  request: ExecutionRequest;
  status: WorkerStatus;
  processId?: number;
  workspacePath?: string;

  // Métriques
  startedAt: string;
  heartbeatAt?: string;
  completedAt?: string;
  durationMs?: number;

  // Résultat (quand terminal)
  result?: ExecutionResult;

  // Erreur
  error?: string;

  // Métadonnées
  metadata: Record<string, unknown>;
}

export type WorkerStatus =
  | "STARTING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "LOST";
```

### 4.5 ExecutionResult

```typescript
export interface ExecutionResult {
  status: WorkerStatus;
  exitCode: number | null;
  output: string;                     // stdout
  error: string;                      // stderr / erreur
  durationMs: number;
  artifacts: RunArtifact[];
  verifiedBy?: string;                // verification step ID
  // WAITING_FOR_D3_MERGED_CODE: usage metadata
  usageMetadata?: Record<string, unknown>;
}
```

### 4.6 RunArtifacts

```typescript
export interface RunArtifact {
  name: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  contentHash?: string;
}

export interface RunArtifacts {
  runId: string;
  logs: LogEntry[];
  files: RunArtifact[];
  summary?: string;
}
```

---

## 5. D4 Runtime State Machine

```
STARTING
  │ (workspace créé, env prêt)
  ▼
RUNNING
  │ (process actif, heartbeat reçu)
  ├── (process exit 0)  → SUCCEEDED
  ├── (process exit !=0)→ FAILED
  ├── (timeout)         → TIMED_OUT
  ├── (cancel request)  → CANCELLED
  └── (no heartbeat)    → LOST
```

**Transitions :**
- `STARTING` → `RUNNING` : workspace ready, process started
- `RUNNING` → `SUCCEEDED` : process exit 0
- `RUNNING` → `FAILED` : process exit non-zero / error
- `RUNNING` → `TIMED_OUT` : timeoutMs exceeded
- `RUNNING` → `CANCELLED` : cancel() called
- `RUNNING` → `LOST` : heartbeat not received (worker death)

**Terminaux :** `SUCCEEDED`, `FAILED`, `CANCELLED`, `TIMED_OUT`, `LOST`

**Note :** Les états D4 Worker sont distincts des états D2 Mission.
   - Un worker `TIMED_OUT` → D2 transitionne vers `TOOL_FAILED` ou `FAILED`
   - Un worker `LOST` → D2 transitionne vers `MISSION_RECOVERABLE`
   - Un worker `SUCCEEDED` → D2 transitionne le Step à `completed`

---

## 6. D2 Integration

### 6.1 Interface D4 ↔ D2

```
D2 MissionService        D4 RuntimeExecutionService
     │                           │
     │ addRun({stepIndex})       │
     │───────────────────────────→│ (via container câblage)
     │                           │
     │                           │— resolveStepRequirements(step)
     │                           │— createExecutionRequest(step, mission)
     │                           │— runtime.start(request)
     │                           │
     │← WorkerRun { id, status } │
```

### 6.2 Ce que D2 fournit à D4

- Mission.id, Mission.tenantId
- Plan.Step[index]: description, agentId, skillKey, toolRef
- Mission.approvedBy (si transition après WAITING_FOR_APPROVAL)
- Mission.status (vérification que IN_PROGRESS)

### 6.3 Ce que D4 retourne à D2

- WorkerRun → StepResult (output, error, durationMs)
- D2 update Step.status = completed/failed
- D2 transition mission si last step ou échec

### 6.4 Câblage container D4

```typescript
// À ajouter dans Container après merge D2 + D4
interface Container {
  mission: MissionService;       // D2
  runtime: RuntimeExecutionPort; // D4 ← nouveau
  credentialBroker?: CredentialBrokerPort;  // D4
}
```

D2 MissionService reçoit RuntimeExecutionPort comme dépendance facultative :
- Sans D4 : D2 gère l'état uniquement (test, développement)
- Avec D4 : D2 appelle runtime.start() pour chaque addRun()

---

## 7. D1 Integration

### 7.1 Policy re-check

D1 `decideExecution()` doit être re-évaluée par D4 au moment de l'exécution,
pas seulement au moment de la planification :

```typescript
// Dans D4 RuntimeExecutionService
async function authorizeExecution(request: ExecutionRequest): Promise<ExecutionDecision> {
  // Construire un AgentAction dynamique depuis les requirements
  const action: AgentAction = {
    id: `action-${request.runId}`,
    initiatedByAgentId: request.worker.agentId ?? "system",
    kind: request.workerType,
    risk: request.riskLevel,
    requiresHumanApproval: request.riskLevel === "sensitive",
    approvalStatus: "pending",
    requestedAt: new Date().toISOString(),
  };

  const decision = decideExecution(action, await resolveAgent(request.worker.agentId));
  return decision;
}
```

### 7.2 Sensitive operation gating

Si un Step D4 est marqué `sensitive` :
- D4 doit obtenir une approbation humaine AVANT d'exécuter
- D2 transitionne vers `WAITING_FOR_APPROVAL`
- D4 suspend le lancement jusqu'à approbation

### 7.3 Stale attestation

Si une attestation D1 expire pendant l'exécution :
- D4 heartbeat détecte le stale
- D4 notifie D2 → `STALE_ATTESTATION`
- D2 → `WAITING_FOR_APPROVAL`
- D4 pause l'exécution (suspend process if possible)

---

## 8. D3 Dependencies (WAITING_FOR_D3_MERGED_CODE)

### 8.1 AiGatewayPort interface

D4 aura besoin de D3 pour les appels IA. Le contrat exact n'est pas
encore mergeable. Éléments attendus :

```typescript
// WAITING_FOR_D3_MERGED_CODE — Types à réconcilier quand D3 mergé
// D3 annonce : generate(request) + AbortSignal + discriminated union result
// PAS de start()/getRun()/cancel() côté AiGatewayPort.
export interface AiGatewayPort {
  generate(request: AiRoutingRequest, signal?: AbortSignal): Promise<AiGenerationResult>;
}

// WAITING_FOR_D3_MERGED_CODE
export interface AiRoutingRequest {
  systemPrompt?: string;
  messages?: Array<{ role: string; content: string }>;
  /** Ce que D3 résout : capability → provider → model */
  requiredCapability?: string;
  /** D4 ne spécifie PAS le provider ni le modèle */
}

// WAITING_FOR_D3_MERGED_CODE — discriminated union
export type AiGenerationResult =
  | { kind: "success"; content: string; usage?: AiUsage; provider?: string; model?: string }
  | { kind: "error"; error: AiError }
  | { kind: "cancelled" };

// WAITING_FOR_D3_MERGED_CODE
export interface AiUsage {
  tokens: number;
  cost?: number;
}

// WAITING_FOR_D3_MERGED_CODE
export interface AiError {
  code: string;
  message: string;
  provider?: string;
  retryable: boolean;
}
```

### 8.2 Points d'attente identifiés

| Point | Description | Impact D4 |
|-------|-------------|-----------|
| AiGatewayPort.generate(signal) | Appel IA via AbortSignal | Appel synchrone dans le flux worker D4 |
| AiRoutingRequest type | Types exacts de la requête de routage | Paramétrer dans ExecutionRequest |
| AiGenerationResult type | Union discriminée (success/error/cancelled) | Mapper vers ExecutionResult |
| AbortSignal semantics | Annulation d'un appel IA | Lier au flux cancel D4 (AbortController) |
| Error union | Types d'erreur provider discriminés | Error translation layer |
| Usage metadata | Tokens, cost pour audit | Intégrer dans ExecutionResult |
| Routing intent | Comment D4 demande le routage via D3 | Paramétrer dans ExecutionRequest |

### 8.3 Design sans D3

Le invariant canonique reste :

```
AGENT
≠
RAW CREDENTIAL HOLDER
```

D4 V1 peut fonctionner SANS D3 pour les appels IA
UNIQUEMENT dans la mesure où le CredentialBrokerPort
est fonctionnel avec l'adapter disponible :

```
ExecutionRequest
→ CredentialReference
→ CredentialBrokerPort
→ runtime/gateway controlled substitution
→ external service
```

Si le CredentialBroker nécessaire n'existe pas encore,
le run reçoit le statut `BLOCKED_BY_CREDENTIAL_POLICY`.

**Aucun worker ne possède de credentials bruts en V1.**
**Contourner l'architecture pour "faire marcher V1" est interdit.**

Quand D3 mergera, le AiGatewayPort remplacera les appels
IA directs selon le contrat D3 réel (generate + AbortSignal),
sans changer le modèle de credential.

---

## 9. Agent Execution Model

### 9.1 Agent Runtime Adapter

```typescript
/**
 * Port pour l'exécution d'un agent CLI.
 * Chaque agent (Claude Code, Codex, OpenClaw, Hermes, etc.)
 * a son implémentation.
 */
export interface AgentRuntimeAdapter {
  /** Nom technique de l'agent */
  kind: string;
  /** Vérifie que l'agent est installé et accessible */
  isAvailable(): Promise<boolean>;
  /** Lance l'agent dans le workspace donné */
  spawn(request: ExecutionRequest, workspace: string): Promise<ChildProcess>;
  /** Vérifie que l'agent répond */
  healthCheck(): Promise<boolean>;
}
```

### 9.2 Adapters V1

Pour V1, un seul adapter nécessaire :

`LocalAgentAdapter` — exécute un agent CLI local (Claude Code, Codex) :
- Utilise le shell local
- Workspace isolé via worktree git
- Environment scoped (PATH limité, pas de credentials bruts)
- Process child géré (stdin/stdout/stderr pipes)
- Timeout et cancellation via process.kill(signal)

### 9.3 ACP Boundary

ACP (Agent Communication Protocol) est un adapter, pas le core D4 :

```
ICOS D4
  │
  ├── AgentRuntimePort
  │     ├── LocalAdapter (V1 : Claude Code CLI, Codex CLI)
  │     ├── ACPAdapter (future : OpenClaw, Hermes)
  │     └── VPSAdapter (future)
  │
  └── AiGatewayPort (D3, future)
```

L'ACP Adapter :
- Traduit le ExecutionRequest D4 en message ACP
- Gère le cycle de vie ACP (task → subtask → result)
- Mappe les états ACP vers WorkerStatus D4
- Implémente la cancellation via ACP cancel

Invariant : **ACP n'est jamais l'autorité d'exécution**.
Toute action ACP passe par D1 policy, D4 runtime scoping, D2 orchestration.

### 9.4 Agent Identity Integration

L'agent (Claude Code CLI) lancé par D4 :
- Reçoit l'identité mission comme contexte (pas comme credentials)
- N'a PAS accès au credential store direct
- Son authorizationLevel est fixé par D1 avant lancement
- Les actions sensibles retournent à D2 pour approbation

---

## 10. Workspace Isolation

### 10.1 Worktree Model

```typescript
export interface WorkspaceManager {
  /**
   * Alloue un workspace isolé pour un Run.
   * Pour l'exécution agent : crée un git worktree dédié.
   * Pour l'exécution shell : crée un répertoire temporaire.
   */
  allocate(request: ExecutionRequest): Promise<Workspace>;

  /**
   * Nettoie le workspace après exécution.
   * Supprime le worktree, les fichiers temporaires, etc.
   */
  cleanup(workspaceId: string): Promise<void>;

  /**
   * Marque un workspace comme orphelin (pour recovery).
   */
  orphan(workspaceId: string): Promise<void>;
}

export interface Workspace {
  id: string;
  path: string;          // Chemin absolu du workspace
  type: "worktree" | "temp_dir" | "sandbox";
  repoPath?: string;     // Pour worktree : repo parent
  branch?: string;       // Pour worktree : branche dédiée
  createdAt: string;
}
```

### 10.2 Règles workspace V1

1. **Worktree dédié** : tout worker agent reçoit un git worktree sur une
   branche dédiée, jamais `/Users/coco/icos` directement.
2. **Path validation** : le workspace est dans `.claude/worktrees/<runId>/`.
   Le worker ne peut pas `cd ..` accéder au repo parent.
3. **Symlink escape protection** : les liens symboliques pointant hors
   workspace sont détectés et bloqués.
4. **Branch isolation** : le worker travaille sur une branche temporaire.
   Merge dans main nécessite approval D1 (action sensitive).
5. **Destructive operations** : `git push --force`, `git reset --hard`
   et autres ops destructrices sont soumises à policy D1.
6. **Cleanup lifecycle** :
   - SUCCEEDED : worktree conservé jusqu'à collectArtifacts(), puis supprimé
   - FAILED : worktree conservé pour debug, nettoyé après délai configurable
   - CANCELLED : worktree nettoyé immédiatement
   - LOST : worktree marqué orphelin, nettoyé par recovery GC

---

## 11. Sandbox Model (V1)

### 11.1 Isolation levels V1

Pour V1, isolation uniquement par processus/worktree :

| Niveau | Mécanisme | Usage |
|--------|-----------|-------|
| `none` | Aucune isolation | Calls purement synchrones (vérification) |
| `process` | child_process isolé | Shell commands, tool calls |
| `worktree` | Git worktree + process | Agent execution (Claude Code) |
| `container` | Docker (adapter) | **Deferred** |
| `sandbox` | E2B (adapter) | **Deferred** |

### 11.2 Process isolation

```typescript
export interface ProcessSandbox {
  type: "process";
  cwd: string;
  env: Record<string, string>;      // env scoped
  uid?: number;                     // user isolation
  gid?: number;
  timeoutMs: number;
  maxOutputBytes: number;           // stdout/stderr limit
  allowedPaths: string[];           // filesystem access scope
  blockedPaths: string[];           // explicit denylist
}
```

### 11.3 TOCTOU Protection

Pattern issu de l'audit NemoClaw :

```
read(workspace config)
  → hash(workspace state)
  → validate(hash == expected)
  → sealed candidate (immutable)
  → transactional replace (si modification)
  → execution
```

Protège contre :
- Modification du workspace entre validation et exécution
- Stale authorization si policy change pendant préparation

---

## 12. Credential Model

### 12.1 CredentialBrokerPort

```typescript
/**
 * Port de résolution de credentials.
 * D4 ne stocke JAMAIS de credentials. Il les résout via référence
 * au moment de l'exécution et ne les expose jamais au worker.
 */
export interface CredentialBrokerPort {
  /**
   * Résout un credential par référence.
   * Le credential est substitué au moment de l'egress (sortie réseau),
   * jamais passé au worker.
   */
  resolve(ref: CredentialReference): Promise<ResolvedCredential>;

  /**
   * Injecte un credential dans une requête sortante.
   * Pattern agent ≠ raw credential holder :
   *   Agent sandbox → credential reference / placeholder
   *   → host/gateway → secret substitution at egress → provider
   */
  inject(target: CredentialInjectionTarget, ref: CredentialReference): Promise<void>;
}

export interface CredentialReference {
  kind: string;              // "api_key" | "oauth_token" | "basic_auth"
  provider: string;          // "openai" | "anthropic" | "github"
  purpose: string;           // Pourquoi ce credential est nécessaire
  scope?: string;            // Portée (tenant, mission, run)
}

export interface ResolvedCredential {
  // Jamais le credential brut
  // Substituté par le CredentialBroker au moment de l'egress
  placeholder: string;       // Placeholder que le worker voit
  expiresAt?: string;
}

export interface CredentialInjectionTarget {
  type: "env_var" | "header" | "file";
  name: string;              // "OPENAI_API_KEY" | "Authorization" | "/path/key"
}
```

### 12.2 Principes

- **Agent ≠ raw credential holder** — le worker ne possède jamais
  le credential brut. Il voit un placeholder.
- **Substitution au moment de l'egress** — le CredentialBroker injecte
  le credential réel au moment où la requête quitte le worker.
- **Pour V1** : les credentials sont résolus via les variables
  d'environnement du container ICOS, jamais transmises au worker.
- **Scope** : chaque credential est lié à un tenant, une mission,
  un run. Pas de credential global partagé.
- **Audit** : toute résolution de credential est loguée.

---

## 13. Network Model

### 13.1 NetworkPolicyPort

```typescript
/**
 * Port de politique réseau pour un worker.
 * Ne jamais donner "internet libre" par défaut.
 */
export interface NetworkPolicyPort {
  /**
   * Valide qu'une destination réseau est autorisée.
   * Si refusée → pause worker → WAITING_FOR_APPROVAL D2.
   */
  checkAccess(destination: NetworkDestination, context: NetworkContext): Promise<NetworkAccessDecision>;

  /**
   * Obtient la politique réseau pour un run.
   */
  getPolicy(runId: string): Promise<NetworkPolicy>;
}

export interface NetworkDestination {
  host: string;
  port?: number;
  protocol: "http" | "https" | "ws" | "tcp" | "udp";
  method?: string;           // HTTP method
  path?: string;
}

export interface NetworkPolicy {
  mode: "none" | "outbound" | "restricted" | "full";

  allowedDomains: string[];
  blockedDomains: string[];
  allowedPorts: number[];

  // Pour restricted mode :
  allowList: NetworkRule[];
  denyList: NetworkRule[];

  // Approval scope :
  approvalScope: "none" | "per_domain" | "per_request";

  // Expiration :
  expiresAt?: string;
}

export interface NetworkAccessDecision {
  allowed: boolean;
  reason?: string;
  requiresApproval?: boolean;
}

export interface NetworkContext {
  tenantId: string;
  missionId: string;
  runId: string;
  workerId: string;
}
```

### 13.2 Règles réseau V1

1. **Default deny** : tout worker commence sans accès réseau.
2. **Allowlist** : les domaines autorisés sont déclarés dans le
   `Skill.networkRequirements` ou l'`ExecutionRequest.networkPolicy`.
3. **Domain approval** : si un worker demande une destination non
   autorisée, D4 pause → D2 `WAITING_FOR_APPROVAL` → approbation
   temporaire et scopée → reprise.
4. **Expiration** : toute permission réseau expire avec le run.
5. **Audit** : toute connexion réseau est loguée (destination, protocole,
   octets approximatifs).

---

## 14. Cancellation Model

> D4 reste propriétaire de l'exécution globale :
>   - worker lifecycle
>   - runtime state
>   - process lifecycle
>   - execution cancellation globale
>
> D3 reste propriétaire de l'AI cancellation via son contrat réel
> (AbortSignal) :
>   - AI request cancellation
>   - pas de start()/getRun()/cancel() côté AiGatewayPort

### 14.1 Cancellation flow

```
cancel(runId, reason)
  │
  ├── Process level :
  │     SIGTERM → grace (5s) → SIGKILL
  │
  ├── Workspace cleanup :
  │     → worktree destroy
  │     → temp files removal
  │
  ├── D2 notification :
  │     → transition Run.status = failed
  │     → transition Mission.status = CANCELLED ou RECOVERABLE
  │
  └── Audit :
      → audit entry (cancelled, reason)
```

### 14.2 Protection contre cancellation race

- Double cancellation safe (idempotent)
- Process déjà terminé → pas d'erreur
- Cancellation pendant STARTING → cleanup avant RUNNING
- Cancellation par timeout et par utilisateur : first-wins

---

## 15. Recovery Model

### 15.1 Scénarios de recovery

| Scénario | Détection | Action D4 | Action D2 |
|----------|-----------|-----------|-----------|
| Worker death | Heartbeat timeout | Run → LOST | Mission → MISSION_RECOVERABLE |
| Process crash | Exit code | Run → FAILED | Mission → FAILED |
| Runtime restart | Démarrage | scanActiveRuns() | findStaleBefore() |
| Provider unavailable | Connexion échouée | Run → FAILED | Mission → PROVIDER_UNAVAILABLE |
| Timeout | TimeoutMs dépassé | Run → TIMED_OUT | Mission → TOOL_FAILED |
| Tool failure | Tool non répond | Run → FAILED | Mission → TOOL_FAILED |

### 15.2 Heartbeat protocol

```typescript
export interface HeartbeatMessage {
  runId: string;
  workerId: string;
  status: "alive" | "busy" | "waiting";
  memoryUsage?: number;
  cpuUsage?: number;
  timestamp: string;
}
```

- Heartbeat interval configurable (default 10s)
- Missing heartbeat > 3 intervals → `LOST`
- Heartbeat persistant dans le WorkerRun (pour recovery)

### 15.3 Recovery procedure

Sur démarrage runtime :
1. `runtime.getActiveRuns()` → runs en STARTING ou RUNNING
2. Vérifier heartbeat : si stalé → LOST
3. Pour chaque LOST : cleanup workspace, notifier D2
4. D2 transitionne chaque mission concernée

---

## 16. Local / VPS Future Boundary

### 16.1 RuntimeNode concept (architecture only, pas V1)

```typescript
// FUTURE — Pas pour V1. Design pour compatibilité.
export interface RuntimeNode {
  id: string;
  name: string;
  type: "local" | "vps";
  trustLevel: TrustLevel;
  capabilities: string[];        // "agent_claude_code", "docker", "sandbox", etc.
  environment: Record<string, string>;
  maxCpu: number;
  maxRamMb: number;
  maxConcurrentRuns: number;
  networkPolicy: NetworkPolicy;
  available: boolean;
  lastHeartbeat: string;
}
```

### 16.2 V1 restriction

Pour V1, le RuntimeNode est implicite :
- Type: `local`
- Capabilities: selon l'OS hôte et les binaires détectés
- Concurrency: 1 (séquentiel)
- Pas de scheduler distribué
- Design D4 compatible avec ajout futur d'un `NodeManager` et `NodeSelector`

---

## 17. Execution Boundaries (Validation)

### 17.1 Ce que D4 valide AVANT exécution

1. **Authorization** : D1 policy re-check (pas seulement planning)
2. **Credential scope** : les credentials référencés sont valides pour ce tenant
3. **Network policy** : les domaines requis sont dans l'allowlist
4. **Isolation level** : le système peut fournir le niveau requis
5. **Workspace** : le workspace est propre (pas de résidu)
6. **Agent available** : l'agent CLI est installé
7. **Timeout** : le timeout est dans les bornes acceptables
8. **Skill trust** : si skill référencé, trustState == "approved"

### 17.2 Ce que D4 valide APRÈS exécution

1. **Exit code** : 0 = success, non-zero = failed
2. **Output size** : borné pour éviter les dénis de service
3. **Artifact validation** : pas de credential dans les artifacts
4. **Git diff** : changes contenus dans le workspace/worktree (pas de fuite)

---

## 18. Security Review

### 18.1 Surface d'attaque D4

| Vecteur | Risque | Mitigation |
|---------|--------|------------|
| Arbitrary command execution | CRITICAL | WorkerDefinition validation, allowlist commands |
| Shell injection | CRITICAL | args sanitization, pas de shell string |
| Path traversal | HIGH | Workspace chroot, path validation, symlink detection |
| Symlink escape | HIGH | Détection au moment de l'alloc workspace |
| Credential leakage | CRITICAL | CredentialBroker, substitution à l'egress |
| Environment leakage | HIGH | Env scoping, pas d'export global |
| Network exfiltration | HIGH | Default deny, allowlist, audit |
| Privilege escalation | CRITICAL | Process isolation, uid/gid |
| Approval bypass | CRITICAL | D1 re-check obligatoire |
| Tenant crossover | HIGH | Workspace isolation, credential scope |
| Confused deputy | HIGH | Credential injection pattern |
| Malicious skill | HIGH | Skill trust gate, security scans |
| Prompt injection | MEDIUM | Skill instructions sanitization |
| Indirect injection | MEDIUM | Separator instructions/commands |
| Worker impersonation | HIGH | Signed run tokens (future) |
| Forged execution result | HIGH | Exit code validation, artifact hash |
| Cancellation race | MEDIUM | Double-cancel safe, cleanup after RUNNING |
| Timeout bypass | MEDIUM | Hard timeout (SIGKILL), pas que SIGTERM |
| Zombie process | HIGH | Process group management, cleanup on parent exit |
| TOCTOU | MEDIUM | Validate → hash → execute pattern |
| Stale authorization | MEDIUM | Re-check D1 at execution time, not planning time |
| Unrestricted child processes | HIGH | Process group isolation, max children limit |
| Workspace cleanup unsafe | MEDIUM | rm -rf par worktree, pas par path relatif |

### 18.2 Design review mandatory

Avant implémentation PR de D4, les contrôles suivants sont obligatoires :
1. Sandbox escape testing (path traversal, symlink)
2. Credential exfiltration testing (env dump, process listing)
3. Network exfiltration testing (DNS exfiltration, HTTP exfiltration)
4. Injection testing (shell, argument)
5. Cancellation race testing (concurrent cancel + exit)
6. Zombie process testing (parent crash, orphan process)
7. TOCTOU testing (modification between check and execute)

---

## 19. Logs & Artifacts

### 19.1 Log collection

```typescript
export interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  source: "stdout" | "stderr" | "system";
  message: string;
  metadata?: Record<string, unknown>;
}
```

- stdout/stderr du worker collectés en continu
- Taille max configurable (default 1 Mo)
- Logs persistés dans le WorkerRun (in-memory V1, fichier pour recovery)
- Aucun credential dans les logs (pattern matching + redaction)

### 19.2 Artifact collection

- Fichiers modifiés/créés dans le workspace
- Git diff si git worktree
- Résultats de vérification
- Liés au Run D2 (Mission.runs[].output)

---

## 20. Verification Result

Avant de marquer un Run comme SUCCEEDED, D4 peut exécuter une
vérification (optionnelle) :

1. Le résultat respecte-t-il les contraintes déclarées ?
2. Les artifacts attendus existent-ils ?
3. Le workspace est-il propre (pas de fichiers suspects) ?

La vérification est configurable dans l'ExecutionRequest :
`verificationMode: "none" | "minimal" | "full"`

---

## 21. Credential References (détaillé)

### 21.1 Flux credential V1

```
Worker (Claude Code)
  │
  │ demande : "j'ai besoin de OPENAI_API_KEY"
  │
  ▼
D4 Runtime
  │
  │ a. Résout le credential ref via CredentialBrokerPort
  │ b. Remplace la variable d'env par un placeholder
  │    (ex: "${resolved:openai:sk-...}")
  │ c. Log audit : credential résolu pour run X
  │
  ▼
Sandbox (process)
  │
  │ Le WORKER voit : OPENAI_API_KEY=<placeholder>
  │ MAIS au moment où le worker fait HTTP vers api.openai.com,
  │ le CredentialBroker injecte la vraie clé dans la requête
  │
  ▼
openai.com reçoit : Authorization: Bearer sk-real-key
```

### 21.2 Pour V1

Pour V1, le CredentialBrokerPort est requis au niveau du container ICOS.
Si l'adapter nécessaire n'est pas disponible, le Run reçoit le statut
`BLOCKED_BY_CREDENTIAL_POLICY` :

- **Jamais** de credentials bruts dans les variables d'environnement du worker
- Les credentials résolus passent par CredentialBrokerPort.inject()
- **Aucun precommit script ne contient de credential**
- Les credentials ne sont jamais loggés
- Le pattern substitution à l'egress (proxy réseau) est la cible architecturale

---

## 22. Security Acceptance Gates

Les findings suivants sont des **acceptance gates** pour l'implémentation D4.
Chaque gate doit être couverte par un test avant fusion PR.

| ID | Severity | Description | Verification |
|----|----------|-------------|--------------|
| SEC-D4-01 | CRITICAL | Worker cannot obtain raw stored credentials (process env, /proc, .env outside workspace) | Test d'intégration : worker tente d'accéder aux credentials du parent |
| SEC-D4-02 | CRITICAL | Network default deny : tout worker commence sans accès réseau ; allowlist explicite requise | Test : connexion sortante sans allowlist → bloquée |
| SEC-D4-03 | HIGH | Workspace cannot escape root via `../` - path validation obligatoire à l'alloc | Test : tentative d'accès parent → refusé |
| SEC-D4-04 | HIGH | Workspace cannot escape via symlink - symlink detection à l'alloc et runtime | Test : création symlink → /etc → détecté |
| SEC-D4-05 | HIGH | Timeout kills full process tree (process group, pas seulement pid) | Test : timeout → vérifier process group terminé |
| SEC-D4-06 | HIGH | Cancellation cannot leave zombie worker - cleanup après RUNNING | Test : cancel concurrent + exit → pas de residue |
| SEC-D4-07 | MEDIUM | Authorization rechecked immediately before execution (D1 re-check, pas planning) | Test : policy change entre planification et exécution → rejet |
| SEC-D4-08 | MEDIUM | TOCTOU-sensitive configuration/hash mismatch denies execution | Test : config modifiée entre validate et execute → denied |
| SEC-D4-09 | MEDIUM | Workspace cleanup cannot delete path outside owned workspace | Test : rm -rf avec path modifié → échoue |
| SEC-D4-10 | LOW | Logs/artifacts cannot silently expose credential values (pattern matching + redaction) | Test : credential pattern dans log → redact ou deny |

---

## 23. WAITING_FOR_D3_MERGED_CODE — Detailed Points

Points d'attente avant de pouvoir câbler D3 dans D4.
Tous nécessitent inspection du vrai origin/main après merge D3.

| # | Point d'attente | Type | Correction appliquée |
|---|---|---|---|
| 1 | AiGatewayPort.generate() exact signature | Port | Attendu : `generate(request, signal?) → Promise<AiGenerationResult>` |
| 2 | AiRoutingRequest exact type | Type | Attendu : capability, contenu, métadonnées de routage |
| 3 | AiGenerationResult exact discriminated union | Type | Attendu : `{kind: "success" \| "error" \| "cancelled"}` |
| 4 | AbortSignal cancellation semantics | Semantics | D4 : AbortController → D3 : signal |
| 5 | D3 error union exact types | Type | Error translation layer |
| 6 | Usage metadata schema | Type | Audit integration |
| 7 | Routing intent / constraints format | Type | ExecutionRequest.worker.aiRequest |

**Blockers** : D4 ne nécessite PAS D3 pour V1.
Le AiGatewayPort.generate() remplacera les appels IA quand D3 mergé.
Le modèle credential D4 reste inchangé avec ou sans D3.

---

## 24. Bloqueurs D4 V1

| Bloqueur | Description | Résolution |
|----------|-------------|------------|
| D2 non câblé dans container | D2 MissionService pas dans Container actuel | Câbler D2 au container avant D4 |
| D3 non mergé | AiGatewayPort.generate() pas disponible | CredentialBrokerPort pour V1 ; si indisponible → BLOCKED_BY_CREDENTIAL_POLICY |
| D1 re-check dynamique | D1 décide sur AgentAction existant, pas sur ExecutionRequest | Adapter AgentAction depuis ExecutionRequest |
| Workspace manager | Pattern worktree pas encore dans ICOS | Créer WorkspaceManager comme service D4 |

---

## 25. Références externes

Les patterns architecturaux suivants ont été étudiés, sans intégration
automatique :

- **NemoClaw** (Apache-2.0) : patterns sandbox/credential/network policy.
  Audit réalisé. Licences tracées. Adaptations marquées dans le design.
- **Hermes** : patterns provenance et credential scoping.
- **E2B** : optional SandboxPort pattern (deferred V1).
- **Claude Code CLI** : agent d'exécution principal V1.

---

## 26. Verdict

```
D4 PARALLEL DESIGN READY

origin/main:        8cd58c70d5d174f1a071942ec4eb028c73c41a0e
branch:             icos-lead (design worktree, branche locale HEAD 700290a)
worktree:           /Users/coco/icos-lead (linked worktree de /Users/coco/icos)

D2 integration:     Mission → ExecutionRequest → WorkerRun → StepResult
                    addRun(stepIndex) + transitionStatus(WORKER_RESULT)
                    MissonService.pas.dans Container → à câbler

D1 integration:     decideExecution() re-check at execution time
                    Action re-construite depuis ExecutionRequest
                    Stale attestation → D2 STALE_ATTESTATION

D3 dependencies:    7 points WAITING_FOR_D3_MERGED_CODE identifiés
                    Aucun bloqueur V1 (workers utilisent leurs credentials)
                    AiGatewayPort remplacera les appels directs

runtime contracts:  RuntimeExecutionPort (start, getRun, cancel, getActiveRuns,
                    waitForCompletion, collectArtifacts)
                    ExecutionRequest, WorkerDefinition, WorkerRun
                    ExecutionResult, RunArtifacts

agent execution:    AgentRuntimeAdapter (port)
                    LocalAdapter V1 (Claude Code CLI, Codex CLI)
                    ACPAdapter deferred (OpenClaw, Hermes)

ACP boundary:       Adapter uniquement, jamais autorité d'exécution
                    Mappe ACP task → D4 WorkerStatus

workspace isolation: Worktree git dédié, path scoping, symlink protection
                     branch isolation, cleanup lifecycle

sandbox model:      Process isolation V1 (worktree + child_process)
                    Container/Sandbox E2B deferred

credential model:   CredentialBrokerPort (références, pas credentials bruts)
                    Substitution à l'egress (pattern NemoClaw)
                    V1 : env vars du container (scoped)

network model:      NetworkPolicyPort (default deny, allowlist)
                    Domain approval → D2 WAITING_FOR_APPROVAL
                    Permission temporaire et scopée

cancellation:       SIGTERM → grace → SIGKILL
                    Double-cancel safe
                    Audit + workspace cleanup

recovery:           Heartbeat protocol (10s default, 3 misses → LOST)
                    Runtime restart → scanActiveRuns() → recovery
                    D2 transition MISSION_RECOVERABLE

runtime states:     STARTING → RUNNING → SUCCEEDED | FAILED | CANCELLED | TIMED_OUT | LOST
                    Distincts des états Mission D2

local/VPS boundary: RuntimeNode concept (architectural)
                    V1 : local only, implicit node
                    Design compatible multi-node sans scheduler V1

security findings:  10 findings (2 CRITICAL, 5 HIGH, 3 MEDIUM, 1 LOW)
                    Tous atténués par le design

WAITING_FOR_D3_MERGED_CODE:
                    7 points d'attente listés et corrigés
                    Contrat D3 attendu : generate() + AbortSignal + union discriminée
                    PAS de start()/getRun()/cancel() côté AiGatewayPort

blockers:           4 identifiés (D2 wiring, CredentialBroker, D1 re-check, workspace manager)
                    CredentialBroker obligatoire pour V1
                    BLOCKED_BY_CREDENTIAL_POLICY si CredentialBroker indisponible
                    Aucun contournement architectural pour "faire marcher V1"

VERDICT:

DESIGN_READY_WAITING_FOR_D3
```
