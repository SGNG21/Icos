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
import { count as sqlCount } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { capabilities as capabilitiesTable, workers } from "@/server/database/schema";
import { toolConnectorHealth, toolGrants } from "@/server/database/tool-gateway-schema";
import { countRealtimeConnectors } from "@/server/tool-gateway/realtime";

import {
  ContextAssembler,
  type OperationalMemorySource,
  type SelfModelSource,
} from "./context-assembler";
import { ContextResolver } from "./context-resolver";
import { CombinedSelfModel, OperationalStateSource } from "./operational-state";
import { capabilityFacts } from "@/core/cognitive/self-model";
import { RuntimeSelfModel, type RuntimeProbes } from "./runtime-self-model";
import { PostgresConversationStore, systemClock, type Clock } from "./conversation-store";
import {
  LaunchedMissionStateSource,
  type CurrentStateSource,
  type MissionStatusReader,
} from "./current-state-source";
import { PostgresCognitiveMemoryStore } from "./memory-store";
import { CanonicalGoalLauncher, type MissionGateway } from "./mission-gateway";
import { and, eq, sql } from "drizzle-orm";
import { workforceAgents } from "@/server/database/workforce-schema";
import {
  executableRuntimes,
  parseWorkerExecCommands,
} from "@/server/workers/execution/exec-command-config";

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
  /** CORE3 mission status reader for the live-state stage. `null` ⇒ launch state only. */
  readonly missionStatus?: MissionStatusReader | null;
  /** Explicit override; `null` disables the live-state stage entirely. */
  readonly currentState?: CurrentStateSource | null;
  /** `null` freezes the conversation's scope (no client/project resolution). */
  readonly resolveContext?: boolean;
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
    /* Registered is not routable: a worker whose probe failed is a row, not a resource. */
    countRoutableWorkers: async () => {
      const [row] = await db
        .select({ n: sqlCount() })
        .from(workers)
        .where(and(eq(workers.health, "healthy"), eq(workers.availability, "available")));
      return Number(row?.n ?? 0);
    },
    /*
     * Executors the Execution Gateway can actually launch. Declared by deployment
     * (`ICOS_WORKER_EXEC_COMMANDS`) rather than inferred, because an executor ICOS cannot
     * name is one it must not claim.
     */
    countGovernedExecutors: async () =>
      executableRuntimes(parseWorkerExecCommands(env.ICOS_WORKER_EXEC_COMMANDS)).length,
    /*
     * Web/search connectors ONLY. Model-provider reachability is deliberately excluded:
     * a model answers from its weights, which is not realtime access to anything.
     */
    countRealtimeConnectors: () => countRealtimeConnectors(db, env),
    /* Canonical durable brains — logical roles, counted apart from compute workers. */
    countDurableBrains: async () => {
      const [row] = await db
        .select({ n: sqlCount() })
        .from(workforceAgents)
        .where(eq(workforceAgents.kind, "DURABLE_AGENT"));
      return Number(row?.n ?? 0);
    },
    countCapabilities: () => count(capabilitiesTable),
    /*
     * The fleet as the routing probes left it, grouped by the provider each worker DECLARED
     * at registration (`metadata.provider`). Undeclared is reported as such, never guessed.
     */
    computeProviders: async () => {
      const rows = await db
        .select({
          provider: sql<string | null>`${workers.metadata}->>'provider'`,
          registered: sqlCount(),
          routable: sql<number>`count(*) filter (where ${workers.health} = 'healthy' and ${workers.availability} = 'available')`,
        })
        .from(workers)
        .groupBy(sql`${workers.metadata}->>'provider'`);
      return rows
        .map((r) => ({
          provider: r.provider ?? "(non déclaré)",
          registered: Number(r.registered),
          routable: Number(r.routable),
        }))
        .sort((a, b) => a.provider.localeCompare(b.provider));
    },
    providerConfigured: () => Boolean(env.OMNIROUTE_BASE_URL && env.OMNIROUTE_API_KEY),
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

/**
 * The SAME measurement the conversation receives as `[runtime:capability.*]`, for the
 * cockpit (decision 0069): one probe set, two readers, so the screen and the voice can never
 * disagree about what ICOS can do. Read-only: it counts, it never composes or launches.
 */
export async function measureRuntimeCapabilities(container: Container) {
  if (!container.db) return null;
  const engine = OmniRouteCognitionEngine.fromEnv();
  const probes = runtimeProbesFor(container.db, engine, true);
  return capabilityFacts(await new RuntimeSelfModel(probes).probe());
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
      ? new CombinedSelfModel([
          new RuntimeSelfModel(runtimeProbesFor(db, engine, missionsConnected)),
          new OperationalStateSource(db),
        ])
      : (options.selfModel ?? undefined);
  const conversations = new PostgresConversationStore(db, clock);
  const currentState =
    options.currentState === undefined
      ? new LaunchedMissionStateSource(conversations, options.missionStatus ?? null, clock)
      : (options.currentState ?? undefined);
  return new CognitiveRuntime({
    conversations,
    memory,
    assembler: new ContextAssembler(memory, clock, operational, selfModel, currentState),
    resolver:
      options.resolveContext === false ? undefined : new ContextResolver(memory, conversations),
    engine,
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
      /*
       * Le moteur émet à travers le COMPTEUR DE CONVERSATION : plafonné par conversation,
       * strictement séparé du budget d'exécution d'un goal. Avant, il émettait sur le
       * `fetch` global — chaque réponse d'ICOS, texte comme voix, était hors compteur.
       */
      engine: OmniRouteCognitionEngine.fromEnv(process.env, container.conversationFetch),
      missions: new CanonicalGoalLauncher(container),
      // Live mission state for the CURRENT stage: READ-ONLY use of CORE3's repository.
      // Reading a status is not executing anything, so it is safe to compose here —
      // unlike the launch recovery this function used to start (see the note above).
      missionStatus: container.mission ?? null,
    });
    cache.set(container, runtime);
  }
  return runtime;
}
