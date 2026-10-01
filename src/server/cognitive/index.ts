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
import { count as sqlCount } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { capabilities as capabilitiesTable, workers } from "@/server/database/schema";
import { toolConnectorHealth, toolGrants } from "@/server/database/tool-gateway-schema";

import {
  ContextAssembler,
  type OperationalMemorySource,
  type SelfModelSource,
} from "./context-assembler";
import { RuntimeSelfModel, type RuntimeProbes } from "./runtime-self-model";
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
  /** Live capability truth (decision 0062). `null` disables it; tests inject their own. */
  readonly selfModel?: SelfModelSource | null;
  readonly staleTurnMs?: number;
}

/**
 * The real measurements behind ICOS's self-description. Counts are per turn and
 * unfiltered by tenant on purpose: "is ANY connector installed, is ANY worker
 * registered" is what decides NOT_CONNECTED, and a count that cannot be taken
 * stays undefined so the self-model fails closed.
 */
function runtimeProbesFor(
  db: Database,
  engine: CognitionEngine,
  missionsConnected: boolean,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeProbes {
  const count = async (table: PgTable) => {
    const [row] = await db.select({ n: sqlCount() }).from(table);
    return Number(row?.n ?? 0);
  };
  return {
    countToolConnectors: () => count(toolConnectorHealth),
    countToolGrants: () => count(toolGrants),
    countWorkers: () => count(workers),
    countCapabilities: () => count(capabilitiesTable),
    cognitionConfigured: () => engine.label !== "not_connected",
    missionIntakeConnected: () => missionsConnected,
    // The sweepers that advance an approved mission only run in this mode
    // (startProductionServices); without them nothing continues after a disconnect.
    durableSchedulerRunning: () => env.NODE_ENV === "production" && env.PERSISTENCE === "postgres",
    speechToText: () =>
      Boolean(env.OMNIROUTE_BASE_URL && env.OMNIROUTE_API_KEY && env.ICOS_VOICE_STT_MODEL),
    textToSpeech: () =>
      Boolean(env.OMNIROUTE_BASE_URL && env.OMNIROUTE_API_KEY && env.ICOS_VOICE_TTS_MODEL),
  };
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
  const engine = options.engine ?? OmniRouteCognitionEngine.fromEnv();
  const missionsConnected = options.missions !== undefined && options.missions !== null;
  const selfModel =
    options.selfModel === undefined
      ? new RuntimeSelfModel(runtimeProbesFor(db, engine, missionsConnected))
      : (options.selfModel ?? undefined);
  return new CognitiveRuntime({
    conversations: new PostgresConversationStore(db, clock),
    memory,
    assembler: new ContextAssembler(memory, clock, operational, selfModel),
    engine,
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
