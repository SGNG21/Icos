# Context Engine Architecture

## Overview

The Context Engine enables ICoS to work long-running missions without sending 40k-50k tokens of history to each LLM request. It provides three memory layers with different lifecycles and access patterns.

## Three Memory Layers

### 1. Mission Context (Hot - In-Memory)

**Lifecycle**: Mission duration
**Scope**: Single mission execution
**Size target**: < 2,000 tokens

Contains:

- Current mission state (status, objective, title)
- Active task graph (ready/running/completed tasks)
- Recent decisions (last 5-10)
- Current working artifacts/evidence
- Error state and recovery info

**Access**: Synchronous, zero-latency, mutable during execution

### 2. Working Memory (Warm - In-Memory + Optional Persistence)

**Lifecycle**: Session/agent lifetime (survives mission boundaries)
**Scope**: Agent/operator session
**Size target**: < 8,000 tokens

Contains:

- Cross-mission learnings (patterns, anti-patterns)
- Agent preferences and calibrated behaviors
- Frequent context items (reusable snippets, templates)
- Session-level decisions and policies
- Tool calibration data

**Access**: Synchronous read, async write (periodic flush)

### 3. Durable Memory (Cold - Persistent Storage)

**Lifecycle**: Permanent (survives restarts, deployments)
**Scope**: Organization/project
**Size target**: Unbounded (queried on demand)

Contains:

- All checkpoints (mission state snapshots)
- All decisions with rationale
- All execution results and evidence
- Audit trail
- Learned patterns (success/failure signatures)
- Skill evaluations and trust scores

**Access**: Async, query-based, indexed by mission/task/topic

---

## Core Components

### ContextEngine (Orchestrator)

```typescript
class ContextEngine {
  missionContext: MissionContext; // Hot
  workingMemory: WorkingMemory; // Warm
  durableMemory: DurableMemory; // Cold

  // Operations
  async checkpoint(missionId: string, label?: string): Promise<Checkpoint>;
  async restore(missionId: string, checkpointId?: string): Promise<MissionContext>;
  async compact(missionId: string): Promise<CompactionResult>;
  async selectRelevant(query: ContextQuery): Promise<ContextItem[]>;
  async handoff(fromAgent: string, toAgent: string, missionId: string): Promise<HandoffPackage>;
}
```

### MissionContext (Hot Layer)

```typescript
interface MissionContext {
  mission: Mission;
  tasks: Map<string, MissionTask>; // By taskId
  taskGraph: TaskGraph; // Computed dependencies
  readyTasks: MissionTask[]; // Currently runnable
  runningTasks: MissionTask[]; // In progress
  completedTasks: MissionTask[]; // Done
  failedTasks: MissionTask[]; // Failed
  recentDecisions: Decision[]; // Last N
  currentArtifacts: Artifact[]; // Active artifacts
  evidence: Evidence[]; // Active evidence
  errors: ExecutionError[]; // Recent errors
  checkpoints: CheckpointRef[]; // Available restore points
  tokenEstimate: number; // Current context size
}
```

### WorkingMemory (Warm Layer)

```typescript
interface WorkingMemory {
  agentId: string;
  sessionId: string;
  patterns: LearnedPattern[];                // Success/failure signatures
  preferences: AgentPreferences;             // Calibrated behaviors
  templates: ContextTemplate[];              // Reusable snippets
  crossMissionDecisions: Decision[];         // Policy-level decisions
  toolCalibration: ToolCalibration[];        // Tool performance data
  tokenEstimate: number;

  // Periodic persistence
  async flush(): Promise<void>;
  async load(): Promise<void>;
}
```

### DurableMemory (Cold Layer)

```typescript
interface DurableMemory {
  // Checkpoints
  async saveCheckpoint(checkpoint: Checkpoint): Promise<void>;
  async getCheckpoints(missionId: string): Promise<Checkpoint[]>;
  async getLatestCheckpoint(missionId: string): Promise<Checkpoint | null>;

  // Decisions
  async saveDecision(decision: DecisionRecord): Promise<void>;
  async getDecisions(query: DecisionQuery): Promise<DecisionRecord[]>;

  // Execution results
  async saveExecutionResult(result: TaskExecutionResult): Promise<void>;
  async getExecutionResults(query: ExecutionQuery): Promise<TaskExecutionResult[]>;

  // Patterns (learned)
  async savePattern(pattern: LearnedPattern): Promise<void>;
  async getPatterns(query: PatternQuery): Promise<LearnedPattern[]>;

  // Context items (for retrieval)
  async saveContextItem(item: ContextItem): Promise<void>;
  async queryContextItems(query: ContextQuery): Promise<ContextItem[]>;
}
```

---

## Checkpoint Strategy

### When to Checkpoint

1. **Automatic**: After each task completion (configurable)
2. **Automatic**: On mission status change (running → blocked, awaiting_approval, etc.)
3. **Automatic**: Every N minutes during long-running missions (default: 5 min)
4. **Manual**: On explicit request (human approval, context handoff)

### Checkpoint Content

```typescript
interface Checkpoint {
  id: string;
  missionId: string;
  label?: string;
  createdAt: Date;
  // Minimal state to reconstruct
  mission: Mission;
  tasks: MissionTask[]; // All tasks with current status
  taskResults: Map<string, TaskExecutionResult>; // Completed task results
  decisions: DecisionRecord[]; // All decisions so far
  artifacts: Artifact[]; // All artifacts
  evidence: Evidence[]; // All evidence
  errors: ExecutionError[]; // All errors
  // Metadata
  tokenCount: number; // Estimated tokens if fully loaded
  version: number; // Schema version
}
```

### Checkpoint Storage

- **In-memory backend**: Serialized to JSON in `DurableMemory` (Map-based for tests)
- **PostgreSQL backend**: Stored in `checkpoints` table with JSONB state column
- **Compression**: gzip for large states (>10KB)

---

## Context Reconstruction (Restart Recovery)

### Cold Start (No Checkpoint)

1. Load mission from repository
2. Load all tasks from repository
3. Load all execution results for mission tasks
4. Load all decisions for mission
5. Rebuild MissionContext from scratch
6. Compute ready tasks

### Warm Start (From Checkpoint)

1. Load latest checkpoint for mission
2. Deserialize mission state
3. Load any execution results after checkpoint timestamp
4. Load any decisions after checkpoint timestamp
5. Rebuild MissionContext
6. Verify consistency (task statuses match results)
7. Compute ready tasks

### Consistency Verification

```typescript
async function verifyConsistency(
  checkpoint: Checkpoint,
  repos: Repositories,
): Promise<ConsistencyReport> {
  // Check each completed task has execution result
  // Check each decision is recorded
  // Check artifacts/evidence exist
  // Report discrepancies
}
```

---

## Compaction Strategy

### Goal

Reduce context sent to LLM from ~40k tokens to ~2-4k tokens while preserving decision-critical information.

### Compaction Rules (Priority Order)

1. **ALWAYS INCLUDE** (Critical - never compact):
   - Current mission objective & status
   - Active task (running/ready) titles & descriptions
   - Blocking errors
   - Pending approvals

2. **INCLUDE IF SPACE** (High - compact last):
   - Last 3 decisions with rationale
   - Recent evidence summaries (not full content)
   - Key artifacts (preview URLs, config)

3. **SUMMARIZE** (Medium - replace with summary):
   - Completed task outcomes (→ "Task A: success, produced preview URL")
   - Old evidence (→ "5 gate reports: all PASS")
   - Old errors (→ "2 retries on Task B, then success")

4. **DROP** (Low - remove first):
   - Verbose logs
   - Full artifact content (keep references)
   - Duplicate information
   - Expired context items

### Compaction Algorithm

```typescript
function compactContext(context: MissionContext, maxTokens: number = 3000): CompactedContext {
  // 1. Start with critical items (always included)
  // 2. Add high-priority items until budget
  // 3. Summarize medium-priority items
  // 4. Drop low-priority items
  // 5. Return compacted + metadata (what was dropped)
}
```

### Token Estimation

- Use `tokenEstimate` on ContextItem
- For raw text: ~4 chars = 1 token (conservative)
- Track actual vs estimated for calibration

---

## Context Selection (Relevance Scoring)

### Query-Based Selection

When agent needs context for a specific action:

```typescript
interface ContextQuery {
  missionId: string;
  taskId?: string; // Focus on specific task
  capability?: string; // Relevant capability
  keywords?: string[]; // Semantic search
  maxTokens?: number; // Budget
  includeHistory?: boolean; // Include past decisions
}
```

### Scoring Factors

| Factor           | Weight | Description                  |
| ---------------- | ------ | ---------------------------- |
| Recency          | 0.30   | Newer items more relevant    |
| Task proximity   | 0.25   | Same task or dependent tasks |
| Capability match | 0.20   | Same workerKind/capability   |
| Keyword match    | 0.15   | Semantic keyword overlap     |
| Decision impact  | 0.10   | BLOCK/ESCALATE decisions     |

### Selection Output

```typescript
interface SelectionResult {
  items: ContextItem[]; // Selected items (within token budget)
  totalTokens: number;
  dropped: ContextItem[]; // Items not included (with reason)
  summary: string; // Human-readable summary of what's included
}
```

---

## Handoff (Worker A → Worker B)

### Handoff Package

```typescript
interface HandoffPackage {
  missionId: string;
  fromAgent: string;
  toAgent: string;
  timestamp: Date;
  // Mission state
  missionContext: MissionContext; // Full hot context
  // Working memory slice relevant to mission
  workingMemorySlice: {
    patterns: LearnedPattern[];
    templates: ContextTemplate[];
    calibration: ToolCalibration[];
  };
  // Durable memory references (not full content)
  durableRefs: {
    checkpointId: string;
    decisionIds: string[];
    resultIds: string[];
  };
  // Handoff metadata
  reason: "specialization" | "failure" | "human_request" | "load_balance";
  instructions?: string; // From Agent A to Agent B
}
```

### Handoff Protocol

1. Agent A requests handoff with reason
2. ContextEngine creates HandoffPackage
3. Package stored in DurableMemory
4. Agent B loads package via `restoreHandoff(packageId)`
5. Agent B receives full MissionContext + relevant WorkingMemory
6. Agent B continues from exact state

---

## Integration Points

### With Supervisor

- Supervisor calls `contextEngine.checkpoint(missionId)` after each `run()` cycle
- Supervisor calls `contextEngine.compact(missionId)` before dispatching to LLM worker

### With CEO Service

- CEO uses `contextEngine.selectRelevant(query)` to get context for user messages
- CEO decisions automatically saved to DurableMemory

### With Reviewer

- Reviewer gets compacted context via `selectRelevant`
- Review decisions saved to DurableMemory

### With DigitalOS Facade

- Facade execution results → DurableMemory
- Facade evidence/artifacts → MissionContext (hot) + DurableMemory

---

## API Surface

### ContextEngine (Main Entry)

```typescript
// Create/get engine for a mission
const engine = await ContextEngine.forMission(missionId);

// Checkpoint
await engine.checkpoint("after-task-B");

// Get compacted context for LLM
const compacted = await engine.getContextForLLM(taskId, 3000);

// Handoff
const pkg = await engine.createHandoff(fromAgent, toAgent, "specialization");
await engine.applyHandoff(pkg);

// Restart recovery
const restored = await engine.restoreMission(missionId);
```

### Configuration

```typescript
interface ContextEngineConfig {
  // Checkpointing
  autoCheckpointIntervalMs: number; // Default: 5 min
  checkpointOnTaskComplete: boolean; // Default: true
  checkpointOnStatusChange: boolean; // Default: true

  // Compaction
  llmTokenBudget: number; // Default: 3000
  alwaysIncludeCritical: boolean; // Default: true

  // Working memory
  workingMemoryMaxTokens: number; // Default: 8000
  flushIntervalMs: number; // Default: 30 sec

  // Durable memory
  checkpointCompressionThreshold: number; // Default: 10KB
  checkpointRetentionDays: number; // Default: 90
}
```

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
                        AGENT / LLM REQUEST
└─────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────┐
                      CONTEXT ENGINE (Orchestrator)
└─────────────────────────────────────────────────────────────────┘
           │                    │                    │
           ▼                    ▼                    ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  Mission Context │  │ Working Memory   │  │ Durable Memory   │
│     (Hot)        │  │    (Warm)        │  │    (Cold)        │
│                  │  │                  │  │                  │
│ - Mission        │  │ - Patterns       │  │ - Checkpoints    │
│ - Task Graph     │  │ - Preferences    │  │ - Decisions      │
│ - Ready Tasks    │  │ - Templates      │  │ - Results        │
│ - Recent Decisions│ │ - Calibration   │  │ - Evidence       │
│ - Active Errors  │  │                  │  │ - Patterns       │
└────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
         │                     │                     │
         └─────────────────────┼─────────────────────┘
                               ▼
              ┌────────────────────────────────┐
              │      COMPILE / COMPACT         │
              │  (Select + Summarize + Budget) │
              └──────────────┬─────────────────┘
                             ▼
              ┌────────────────────────────────┐
              │      COMPACTED CONTEXT         │
              │   (~2-4k tokens for LLM)       │
              └────────────────────────────────┘
```

---

## Implementation Priority

1. **Phase 1**: MissionContext + Checkpoint save/load (in-memory backend)
2. **Phase 2**: Compaction + Context Selection
3. **Phase 3**: WorkingMemory + DurableMemory (PostgreSQL backend)
4. **Phase 4**: Handoff + Restart Recovery
5. **Phase 5**: Tests + Metrics + Documentation

---

## Risks & Mitigations

| Risk                           | Likelihood | Impact | Mitigation                             |
| ------------------------------ | ---------- | ------ | -------------------------------------- |
| Checkpoint inconsistency       | Medium     | High   | Verify on restore, auto-repair         |
| Compaction loses critical info | Low        | High   | Critical items never compacted, tests  |
| Token estimation inaccurate    | Medium     | Medium | Calibrate with actual usage            |
| Handoff package too large      | Low        | Medium | Compress, reference don't embed        |
| Cold start slow                | Medium     | Low    | Lazy load, background warmup           |
| Schema migration               | Low        | High   | Version checkpoints, migration scripts |
