import type { CognitiveScope } from "@/core/cognitive/contracts";
import type { ContextCandidate } from "@/core/cognitive/context-selection";
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
import { PostgresConversationStore, systemClock, type Clock } from "./conversation-store";
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
  return new CognitiveRuntime({
    conversations: new PostgresConversationStore(db, clock),
    memory,
    assembler: new ContextAssembler(memory, clock, operational),
    engine: options.engine ?? OmniRouteCognitionEngine.fromEnv(),
    missions: options.missions === undefined ? null : options.missions,
    staleTurnMs: options.staleTurnMs,
  });
}

const cache = new WeakMap<Container, CognitiveRuntime>();

/**
 * The runtime for a container. PostgreSQL only: in memory mode it returns null and the
 * API answers 503 (fail closed — conversations are never kept in RAM).
 *
 * COMPOSITION IS SIDE-EFFECT FREE. It used to kick off `recoverLaunches(tenant)` here, so
 * ANY request that composed the runtime — including a plain `GET /api/cognitive/conversations`
 * or a page render — could relaunch an approved proposal and enqueue `start_mission`. A read
 * must never start a mission. Launch recovery now runs ONLY on the explicit production timer
 * (`cognitiveLaunchRecoverySweeper`, wired into the canonical recovery sweep) — the same
 * `recoverLaunches` authority, reached from the one path that is allowed to execute.
 */
export function cognitiveRuntimeFor(container: Container): CognitiveRuntime | null {
  if (!container.db) return null;
  let runtime = cache.get(container);
  if (!runtime) {
    runtime = buildCognitiveRuntime(container.db, {
      missions: new CanonicalGoalLauncher(container),
    });
    cache.set(container, runtime);
  }
  return runtime;
}
