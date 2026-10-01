import type { CognitiveScope } from "@/core/cognitive/contracts";
import type { ContextCandidate } from "@/core/cognitive/context-selection";
import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity";
import type { Container } from "@/server/container";
import type { Database } from "@/server/database/client";
import {
  MemoryService,
  PostgresBusinessMemoryStore,
  PostgresMissionMemoryStore,
  PostgresProceduralMemoryStore,
  PostgresRetrievalLogStore,
} from "@/server/memory";

import { OmniRouteCognitionEngine, type CognitionEngine } from "./cognition";
import { CognitiveRuntime } from "./cognitive-runtime";
import { ContextAssembler, type OperationalMemorySource } from "./context-assembler";
import { ContextResolver } from "./context-resolver";
import { PostgresConversationStore, systemClock, type Clock } from "./conversation-store";
import {
  LaunchedMissionStateSource,
  type CurrentStateSource,
  type MissionStatusReader,
} from "./current-state-source";
import { PostgresCognitiveMemoryStore } from "./memory-store";
import { CanonicalGoalLauncher, type MissionGateway } from "./mission-gateway";

export {
  CognitiveRuntime,
  ConversationNotFoundError,
  type CognitiveActor,
} from "./cognitive-runtime";
export { TurnInProgressError } from "./conversation-store";

/**
 * Reuse of Phase 7B operational memory: validated procedures and human-approved business
 * facts, read through MemoryService (each read traced in memory_retrieval_log).
 * Business memory has no client dimension: it is holding-level knowledge by design.
 */
export class MemoryServiceOperationalSource implements OperationalMemorySource {
  constructor(private readonly service: MemoryService) {}

  async candidates(scope: CognitiveScope): Promise<ContextCandidate[]> {
    const reader = {
      tenantId: scope.tenantId,
      kind: "human" as const,
      id: scope.userId,
      permissions: [],
    };
    const purpose = "cognitive-context";
    const [procedures, business] = await Promise.all([
      this.service.retrieveProcedural(reader, { statuses: ["validated"], purpose, limit: 10 }),
      this.service.retrieveBusiness(reader, { purpose, limit: 10 }),
    ]);
    return [
      ...procedures.entries.map(({ entry }): ContextCandidate => ({
        stage: "procedures",
        kind: "procedure",
        ref: `procedural:${entry.id}`,
        text: `${entry.title}: ${entry.summary}`,
        anchored: false,
        entityIds: [],
        occurredAt: entry.lastObservedAt,
        confidence: entry.confidence,
        epistemic: "SYSTEM_OBSERVED",
        trust: "trusted",
      })),
      ...business.entries.map(({ entry }): ContextCandidate => ({
        stage: "semantic",
        kind: "business_fact",
        ref: `business:${entry.id}`,
        text: `${entry.subjectKey}: ${entry.summary}`,
        anchored: false,
        entityIds: [],
        occurredAt: entry.occurredAt,
        confidence: entry.confidence,
        epistemic: "USER_ASSERTED",
        trust: "trusted",
      })),
    ];
  }
}

export interface CognitiveRuntimeOptions {
  readonly clock?: Clock;
  readonly engine?: CognitionEngine;
  readonly missions?: MissionGateway | null;
  readonly operational?: OperationalMemorySource | null;
  /** CORE3 mission status reader for the live-state stage. `null` ⇒ launch state only. */
  readonly missionStatus?: MissionStatusReader | null;
  /** Explicit override; `null` disables the live-state stage entirely. */
  readonly currentState?: CurrentStateSource | null;
  /** `null` freezes the conversation's scope (no client/project resolution). */
  readonly resolveContext?: boolean;
  readonly staleTurnMs?: number;
}

export function buildCognitiveRuntime(
  db: Database,
  options: CognitiveRuntimeOptions = {},
): CognitiveRuntime {
  const clock = options.clock ?? systemClock;
  const memory = new PostgresCognitiveMemoryStore(db, clock);
  const operational =
    options.operational === undefined
      ? new MemoryServiceOperationalSource(
          new MemoryService({
            mission: new PostgresMissionMemoryStore(db),
            procedural: new PostgresProceduralMemoryStore(db),
            business: new PostgresBusinessMemoryStore(db),
            log: new PostgresRetrievalLogStore(db),
          }),
        )
      : (options.operational ?? undefined);
  const conversations = new PostgresConversationStore(db, clock);
  const currentState =
    options.currentState === undefined
      ? new LaunchedMissionStateSource(conversations, options.missionStatus ?? null, clock)
      : (options.currentState ?? undefined);
  return new CognitiveRuntime({
    conversations,
    memory,
    assembler: new ContextAssembler(memory, clock, operational, currentState),
    resolver:
      options.resolveContext === false ? undefined : new ContextResolver(memory, conversations),
    engine: options.engine ?? OmniRouteCognitionEngine.fromEnv(),
    missions: options.missions === undefined ? null : options.missions,
    staleTurnMs: options.staleTurnMs,
  });
}

const cache = new WeakMap<Container, { runtime: CognitiveRuntime; lastRecovery: number }>();
const RECOVERY_INTERVAL_MS = 60_000;

/**
 * The runtime for a container. PostgreSQL only: in memory mode it returns null and the
 * API answers 503 (fail closed — conversations are never kept in RAM).
 *
 * Launch recovery: approved proposals whose launch was interrupted (restart) or hit a
 * transient error are relaunched idempotently when the runtime is composed and then at
 * most once a minute while the API is in use, without anyone reopening the conversation.
 */
export function cognitiveRuntimeFor(container: Container): CognitiveRuntime | null {
  if (!container.db) return null;
  let entry = cache.get(container);
  if (!entry) {
    entry = {
      runtime: buildCognitiveRuntime(container.db, {
        missions: new CanonicalGoalLauncher(container),
        // Live mission state for the CURRENT stage: read-only use of CORE3's repository.
        missionStatus: container.mission ?? null,
      }),
      lastRecovery: 0,
    };
    cache.set(container, entry);
  }
  const now = Date.now();
  if (now - entry.lastRecovery >= RECOVERY_INTERVAL_MS) {
    entry.lastRecovery = now;
    void entry.runtime.recoverLaunches(CURRENT_SINGLE_TENANT_ID).catch((error: unknown) => {
      console.error(
        `[cognitive] launch recovery failed: ${error instanceof Error ? error.name : "unknown"}`,
      );
    });
  }
  return entry.runtime;
}
