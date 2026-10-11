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

import { capabilities as capabilitiesTable } from "@/server/database/schema";
import { countRealtimeConnectors } from "@/server/tool-gateway/realtime";
import { getToolGatewayRuntime } from "@/server/tool-gateway/app";
import { scheduledJobs } from "@/server/database/schema";
import { readFleetReadiness } from "@/server/workers/fleet-readiness";
import { sandboxBackend } from "@/server/workers/process/sandbox-backend";
import type { KnowledgeSourcesProbe } from "@/core/cognitive/self-model";
import {
  countDispatchableConnectors,
  countLaunchableExecutors,
  countLiveToolGrants,
  measureRealtime,
} from "./honest-probes";
import {
  buildRealtimeContextSource,
  clientDomainsFromEntities,
  realtimeInstancesFromConfig,
  type RealtimeContextSource,
} from "./realtime-context-source";
import { memoryEntities } from "./schema";
import { composedRiskGate } from "@/server/supervisor/risk-gate-registry";

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
import { and, eq, gt, or } from "drizzle-orm";
import { workforceAgents } from "@/server/database/workforce-schema";

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
  /** Governed web/search context (decision 0059). `null`/absent ⇒ not composed. */
  readonly realtime?: RealtimeContextSource | null;
  /**
   * The supervisor's pre-dispatch risk gate, read LIVE at probe time from what the dispatching
   * supervisor actually composed (P0 autonomy unblock). Absent ⇒ never claimed.
   */
  readonly executionRiskGate?: (() => { enforced: boolean; policyVersion: string } | undefined) | null;
}

/** What THIS composition wired, so the self-model describes the runtime it is part of. */
export interface CognitiveComposition {
  readonly resolverWired: boolean;
  readonly knowledgeSources: KnowledgeSourcesProbe;
  readonly executionRiskGate?: () => { enforced: boolean; policyVersion: string } | undefined;
}

/** Horizon of scheduler liveness: the worker probe job completes every 30 s in production. */
export const SCHEDULER_LIVENESS_HORIZON_MS = 3 * 60_000;

/**
 * The real measurements behind ICOS's self-description. Counts are per turn and
 * unfiltered by tenant on purpose: "is ANY connector installed, is ANY worker
 * registered" is what decides NOT_CONNECTED, and a count that cannot be taken
 * stays undefined so the self-model fails closed.
 */
export function runtimeProbesFor(
  db: Database,
  engine: CognitionEngine,
  missionsConnected: boolean,
  env: NodeJS.ProcessEnv = process.env,
  composition?: CognitiveComposition,
): RuntimeProbes {
  const count = async (table: PgTable) => {
    const [row] = await db.select({ n: sqlCount() }).from(table);
    return Number(row?.n ?? 0);
  };
  /*
   * THE FLEET, ONCE PER TURN, by the canonical eligibility rules (`measureFleet`): active
   * workers only, routable = what the router would actually pick (status, runtime support,
   * evidence younger than its horizon), and a credential-less provider counted apart from
   * an outage. Workers, routable workers and per-provider health are three readers of this
   * one measurement, so they can never disagree.
   */
  let fleet: ReturnType<typeof readFleetReadiness> | undefined;
  const fleetOnce = () => {
    fleet ??= readFleetReadiness(db, new Date());
    const current = fleet;
    setTimeout(() => {
      if (fleet === current) fleet = undefined;
    }, 1_000).unref?.();
    return current;
  };
  return {
    /* LIVE only: dispatchable, unexpired health — a DISABLED or AUTH_FAILED row is no tool. */
    countToolConnectors: () => countDispatchableConnectors(db),
    /* LIVE only: unrevoked, unexpired grants — a revoked grant authorises nothing. */
    countToolGrants: () => countLiveToolGrants(db),
    countWorkers: async () => (await fleetOnce()).total.active,
    countRoutableWorkers: async () => (await fleetOnce()).total.routable,
    /*
     * Executors the Execution Gateway can actually launch. Declared by deployment
     * (`ICOS_WORKER_EXEC_COMMANDS`) rather than inferred, because an executor ICOS cannot
     * name is one it must not claim.
     */
    /* The policy is loaded LAZILY: importing it freezes its allowlist (see honest-probes). */
    countGovernedExecutors: async () =>
      countLaunchableExecutors(
        env,
        sandboxBackend(),
        (await import("@/core/execution/executable-policy")).decideExecutable,
      ),
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
    computeProviders: async () =>
      (await fleetOnce()).providers.map((p) => ({
        provider: p.provider,
        registered: p.active,
        routable: p.routable,
        notConfigured: p.notConfigured,
      })),
    providerConfigured: () => Boolean(env.OMNIROUTE_BASE_URL && env.OMNIROUTE_API_KEY),
    cognitionConfigured: () => engine.label !== "not_connected",
    missionIntakeConnected: () => missionsConnected,
    /*
     * MEASURED, not inferred from NODE_ENV: a job completed within the horizon (the worker
     * probe job alone completes every 30 s in production) or one held under a live lease.
     * A production-configured process whose sweepers never started answers false.
     */
    durableSchedulerRunning: async () => {
      const now = new Date();
      const since = new Date(now.getTime() - SCHEDULER_LIVENESS_HORIZON_MS);
      const [row] = await db
        .select({ n: sqlCount() })
        .from(scheduledJobs)
        .where(
          or(
            and(eq(scheduledJobs.state, "succeeded"), gt(scheduledJobs.completedAt, since)),
            and(eq(scheduledJobs.state, "running"), gt(scheduledJobs.leaseUntil, now)),
          ),
        );
      return Number(row?.n ?? 0) > 0;
    },
    measureRealtime: () => measureRealtime(db, env),
    contextResolverWired: () => composition?.resolverWired ?? false,
    countClientDirectory: async () => {
      const [row] = await db
        .select({ n: sqlCount() })
        .from(memoryEntities)
        .where(eq(memoryEntities.kind, "client"));
      return Number(row?.n ?? 0);
    },
    ...(composition ? { knowledgeSources: () => composition.knowledgeSources } : {}),
    ...(composition?.executionRiskGate ? { executionRiskGate: composition.executionRiskGate } : {}),
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
  /* Composition is side-effect free; composing here makes the screen read the SAME wiring. */
  cognitiveRuntimeFor(container);
  const engine = OmniRouteCognitionEngine.fromEnv();
  const probes = runtimeProbesFor(
    container.db,
    engine,
    true,
    process.env,
    compositions.get(container),
  );
  return capabilityFacts(await new RuntimeSelfModel(probes).probe());
}

/** The composition each container's runtime was built with (read by the cockpit probe). */
const compositions = new WeakMap<Container, CognitiveComposition>();

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
  const conversations = new PostgresConversationStore(db, clock);
  const currentState =
    options.currentState === undefined
      ? new LaunchedMissionStateSource(conversations, options.missionStatus ?? null, clock)
      : (options.currentState ?? undefined);
  const realtime = options.realtime ?? undefined;
  const composition: CognitiveComposition = {
    resolverWired: options.resolveContext !== false,
    knowledgeSources: {
      durableMemory: true,
      /* `memory-store` filters by client/project in SQL before any limit (decision 0063). */
      scopeFiltered: true,
      operational: operational !== undefined,
      currentState: currentState !== undefined,
      realtime: realtime !== undefined,
    },
    ...(options.executionRiskGate ? { executionRiskGate: options.executionRiskGate } : {}),
  };
  const selfModel =
    options.selfModel === undefined
      ? new CombinedSelfModel([
          new RuntimeSelfModel(
            runtimeProbesFor(db, engine, missionsConnected, process.env, composition),
          ),
          new OperationalStateSource(db),
        ])
      : (options.selfModel ?? undefined);
  const runtime = new CognitiveRuntime({
    conversations,
    memory,
    assembler: new ContextAssembler(memory, clock, operational, selfModel, currentState, realtime),
    resolver:
      options.resolveContext === false ? undefined : new ContextResolver(memory, conversations),
    engine,
    missions: options.missions === undefined ? null : options.missions,
    staleTurnMs: options.staleTurnMs,
  });
  runtimeCompositions.set(runtime, composition);
  return runtime;
}

/** What each runtime was composed with: the self-model of THIS runtime, not of a guess. */
const runtimeCompositions = new WeakMap<CognitiveRuntime, CognitiveComposition>();

const cache = new WeakMap<Container, CognitiveRuntime>();

/**
 * Governed web/search for conversation turns — THROUGH the process's single Tool Gateway
 * runtime (the one the admin routes and boot reconciliation share), never a parallel route.
 * Composed only when a web or search instance is declared; whether it may run is the
 * gateway's decision per call (live owner grant, health, rate limit), not this function's.
 */
function realtimeSourceFor(container: Container): RealtimeContextSource | null {
  const instances = realtimeInstancesFromConfig(process.env.ICOS_TOOL_GATEWAY_CONFIG);
  if (!instances.search && !instances.fetch) return null;
  const memory = container.db ? new PostgresCognitiveMemoryStore(container.db, systemClock) : null;
  return buildRealtimeContextSource({
    gateway: {
      execute: async (...args) => (await getToolGatewayRuntime(container)).gateway.execute(...args),
    },
    instances,
    env: process.env,
    clientDomains: async (scope) =>
      memory && scope.clientId
        ? clientDomainsFromEntities(
            await memory.clientDirectory(scope.tenantId, "normal"),
            scope.clientId,
          )
        : [],
  });
}

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
      realtime: realtimeSourceFor(container),
      executionRiskGate: () => composedRiskGate(container),
    });
    cache.set(container, runtime);
    const composition = runtimeCompositions.get(runtime);
    if (composition) compositions.set(container, composition);
  }
  return runtime;
}
