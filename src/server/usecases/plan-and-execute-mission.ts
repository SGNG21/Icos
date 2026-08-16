import { z } from "zod";

import type { BridgeResult, SupervisorEnrichedContext } from "@/core/context";
import { resolveSupervisorContext } from "@/core/context";
import { idSchema } from "@/core/contracts/common";
import { tenantIdSchema } from "@/core/contracts/tenant";
import type { Mission, MissionResult, MissionStatus, Plan } from "@/core/mission";
import { SYSTEM_ACTIONS } from "@/core/policy";
import { createBoundedMissionPlan } from "@/core/planning/create-bounded-mission-plan";
import { selfStateSnapshotSchema, type SelfStateSnapshot } from "@/core/self-state";
import type { TaskDag, TaskNode } from "@/core/supervisor";
import { validateDag } from "@/core/supervisor";
import { createTaskDagFromPlan } from "@/core/supervisor/create-task-dag-from-plan";
import type { MissionContextRepository } from "@/server/context/ports";
import type { MissionService } from "@/server/mission/mission-service";
import { getSelfStateSnapshot } from "@/server/self-state/get-self-state-snapshot";
import type {
  CapabilityPermissionState,
  CapabilitySnapshotItem,
  GetCapabilitySnapshotDeps,
  GetCapabilitySnapshotInput,
} from "@/server/usecases/get-capability-snapshot";
import { getCapabilitySnapshot } from "@/server/usecases/get-capability-snapshot";
import type {
  SupervisorExecutionResult,
  SupervisorService,
} from "@/server/supervisor/supervisor-service";
import type { SupervisorRepository } from "@/server/supervisor/ports";

export const planAndExecuteMissionInputSchema = z
  .object({
    missionId: idSchema,
  })
  .strict();

export type PlanAndExecuteMissionInput = z.infer<typeof planAndExecuteMissionInputSchema>;

export const trustedMissionSupervisionContextSchema = z
  .object({
    tenantId: tenantIdSchema,
    actorId: z.string().min(1).max(128),
  })
  .strict();

export type TrustedMissionSupervisionContext = z.infer<
  typeof trustedMissionSupervisionContextSchema
>;

export const REQUIRED_MISSION_CAPABILITY_KEYS = [SYSTEM_ACTIONS.SUPERVISOR_WORKER_EXECUTE] as const;

type MissionServiceBoundary = Pick<MissionService, "getMission" | "transitionStatus" | "setPlan">;

type CapabilitySnapshotReader = (
  deps: GetCapabilitySnapshotDeps,
  input: GetCapabilitySnapshotInput,
) => Promise<CapabilitySnapshotItem[]>;

export interface PlanAndExecuteMissionDeps {
  missionService: MissionServiceBoundary;
  missionContexts: Pick<MissionContextRepository, "findLatest">;
  capabilitySnapshotDeps: GetCapabilitySnapshotDeps;
  supervisor: Pick<SupervisorService, "execute" | "getExecutionIdentity">;
  supervisorRepository: Pick<SupervisorRepository, "findDagById">;
  clock: () => Date;
  getSelfState?: () => SelfStateSnapshot;
  getCapabilities?: CapabilitySnapshotReader;
  resolveContext?: (
    context: Parameters<typeof resolveSupervisorContext>[0],
    mission?: Mission,
  ) => BridgeResult;
  createPlan?: (mission: Mission) => Plan;
  createDag?: (input: { mission: Mission; plan: Plan; now: string }) => TaskDag;
  validateTaskDag?: (nodes: TaskNode[]) => string[];
}

export interface CapabilityBlocker {
  capabilityKey: (typeof REQUIRED_MISSION_CAPABILITY_KEYS)[number];
  permissionState: Exclude<CapabilityPermissionState, "ALLOWED">;
  reason: string;
}

type SafeResultFields = {
  missionId: string;
  mission: Mission;
  plan: Plan;
  mergePerformed: false;
  productionPerformed: false;
};

export type PlanAndExecuteMissionResult =
  | (SafeResultFields & {
      ok: true;
      outcome: "EXECUTED";
      dag: TaskDag;
      executionResult: SupervisorExecutionResult;
    })
  | (SafeResultFields & {
      ok: true;
      outcome: "WAITING_FOR_APPROVAL" | "BLOCKED_BY_POLICY" | "PROVIDER_UNAVAILABLE";
      blockers: CapabilityBlocker[];
    })
  | {
      ok: false;
      reason:
        | "invalid_input"
        | "invalid_trusted_context"
        | "mission_unavailable"
        | "mission_state_incompatible"
        | "mission_context_unavailable"
        | "mission_context_mismatch"
        | "self_state_unavailable"
        | "self_state_invalid"
        | "capability_preflight_failed"
        | "context_bridge_failed"
        | "plan_creation_failed"
        | "mission_transition_failed"
        | "plan_persistence_failed"
        | "dag_creation_failed"
        | "dag_validation_failed"
        | "supervisor_execution_failed"
        | "supervisor_state_inconsistent";
      message: string;
      missionId?: string;
      mission?: Mission;
      plan?: Plan;
      dag?: TaskDag;
      executionResult?: SupervisorExecutionResult;
      mergePerformed?: false;
      productionPerformed?: false;
    };

const failure = (
  reason: Extract<PlanAndExecuteMissionResult, { ok: false }>["reason"],
  message: string,
  observableState?: Omit<
    Extract<PlanAndExecuteMissionResult, { ok: false }>,
    "ok" | "reason" | "message"
  >,
): PlanAndExecuteMissionResult => ({ ok: false, reason, message, ...observableState });

function selfStateAllowsBoundedLocalWork(snapshot: SelfStateSnapshot): boolean {
  const mode = snapshot.operatingMode;
  return (
    mode.LOCAL_DEV_ONLY === true &&
    mode.CLIENT_SYSTEM_ACCESS === false &&
    mode.PRODUCTION_ACCESS === false &&
    mode.CLIENT_CREDENTIALS === "forbidden" &&
    mode.EXTERNAL_IRREVERSIBLE_ACTIONS === "forbidden"
  );
}

function capabilityBlockers(snapshot: readonly CapabilitySnapshotItem[]): CapabilityBlocker[] {
  return REQUIRED_MISSION_CAPABILITY_KEYS.flatMap((capabilityKey) => {
    const matchingItems = snapshot.filter(
      (candidate) => candidate.source.capability.key === capabilityKey,
    );
    if (matchingItems.length !== 1) {
      return [
        {
          capabilityKey,
          permissionState: "UNAVAILABLE" as const,
          reason:
            matchingItems.length === 0
              ? "Required canonical capability evidence is missing"
              : "Required canonical capability evidence is ambiguous",
        },
      ];
    }
    const item = matchingItems[0]!;
    if (item.permissionState === "ALLOWED") {
      return [];
    }
    return [
      {
        capabilityKey,
        permissionState: item.permissionState,
        reason: item.reason,
      },
    ];
  });
}

function preflightOutcome(blockers: readonly CapabilityBlocker[]): {
  outcome: "WAITING_FOR_APPROVAL" | "BLOCKED_BY_POLICY" | "PROVIDER_UNAVAILABLE";
  missionStatus: "WAITING_FOR_APPROVAL" | "BLOCKED_BY_POLICY" | "PROVIDER_UNAVAILABLE";
} | null {
  if (blockers.some((blocker) => blocker.permissionState === "DENIED")) {
    return { outcome: "BLOCKED_BY_POLICY", missionStatus: "BLOCKED_BY_POLICY" };
  }
  if (blockers.some((blocker) => blocker.permissionState === "APPROVAL_REQUIRED")) {
    return {
      outcome: "WAITING_FOR_APPROVAL",
      missionStatus: "WAITING_FOR_APPROVAL",
    };
  }
  if (blockers.some((blocker) => blocker.permissionState === "UNAVAILABLE")) {
    return {
      outcome: "PROVIDER_UNAVAILABLE",
      missionStatus: "PROVIDER_UNAVAILABLE",
    };
  }
  return null;
}

async function transitionMission(
  missionService: MissionServiceBoundary,
  missionId: string,
  targetStatus: MissionStatus,
  actorId: string,
): Promise<MissionResult<Mission>> {
  return missionService.transitionStatus({
    missionId,
    targetStatus,
    actorLabel: actorId,
  });
}

async function failAfterSupervisorFailure(input: {
  deps: PlanAndExecuteMissionDeps;
  missionId: string;
  actorId: string;
  inProgressMission: Mission;
  plan: Plan;
  dagId: string;
  executionResult?: SupervisorExecutionResult;
}): Promise<PlanAndExecuteMissionResult> {
  let transitioned: MissionResult<Mission>;
  try {
    transitioned = await transitionMission(
      input.deps.missionService,
      input.missionId,
      "FAILED",
      input.actorId,
    );
  } catch {
    transitioned = {
      ok: false,
      reason: "transition_threw",
      message: "La transition canonique vers FAILED a levé une erreur.",
    };
  }

  let persistedDag: TaskDag | null = null;
  try {
    persistedDag = await input.deps.supervisorRepository.findDagById(input.dagId);
  } catch {
    // The original Supervisor failure remains authoritative. Repository read
    // failure must not turn it into success or fabricate compensation.
  }

  return failure(
    "supervisor_execution_failed",
    transitioned.ok
      ? "L'exécution du Supervisor a échoué."
      : "L'exécution du Supervisor a échoué et la transition canonique de la Mission vers FAILED a également échoué.",
    {
      missionId: input.missionId,
      mission: transitioned.ok ? transitioned.data : input.inProgressMission,
      plan: input.plan,
      dag: persistedDag ?? input.executionResult?.dag,
      executionResult: input.executionResult,
      mergePerformed: false,
      productionPerformed: false,
    },
  );
}

/**
 * Bounded application bridge from an existing canonical Mission to the
 * unchanged SupervisorService. It creates one descriptive task only.
 *
 * Partial persistence is intentional and honest: no cross-repository
 * transaction or rollback exists. Once planning begins, the Mission, Plan,
 * lifecycle transitions, DAG/node state, and Supervisor side effects may
 * remain persisted after a later failure. This use case never deletes or
 * fabricates compensation for that retained canonical state.
 */
export async function planAndExecuteMission(
  deps: PlanAndExecuteMissionDeps,
  input: unknown,
  trustedContext: unknown,
): Promise<PlanAndExecuteMissionResult> {
  const parsedInput = planAndExecuteMissionInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return failure("invalid_input", "La demande de supervision est invalide.");
  }
  const parsedTrusted = trustedMissionSupervisionContextSchema.safeParse(trustedContext);
  if (!parsedTrusted.success) {
    return failure("invalid_trusted_context", "Le contexte serveur de supervision est invalide.");
  }

  const { missionId } = parsedInput.data;
  const { tenantId, actorId } = parsedTrusted.data;

  let mission: Mission | null;
  try {
    mission = await deps.missionService.getMission(missionId);
  } catch {
    return failure("mission_unavailable", "La mission n'est pas disponible.");
  }
  if (!mission || mission.tenantId !== tenantId) {
    return failure("mission_unavailable", "La mission n'est pas disponible.");
  }
  if (mission.status !== "CREATED") {
    return failure(
      "mission_state_incompatible",
      "La mission n'est pas dans un état compatible avec la planification.",
    );
  }

  let missionContext;
  try {
    missionContext = await deps.missionContexts.findLatest(tenantId, missionId);
  } catch {
    return failure(
      "mission_context_unavailable",
      "Le contexte canonique de la mission n'est pas disponible.",
    );
  }
  if (!missionContext) {
    return failure(
      "mission_context_unavailable",
      "Le contexte canonique de la mission n'est pas disponible.",
    );
  }
  if (missionContext.tenantId !== tenantId || missionContext.missionId !== missionId) {
    return failure(
      "mission_context_mismatch",
      "Le contexte canonique de la mission est incohérent.",
    );
  }

  let selfState: SelfStateSnapshot;
  try {
    const rawSelfState = (deps.getSelfState ?? getSelfStateSnapshot)();
    const parsedSelfState = selfStateSnapshotSchema.safeParse(rawSelfState);
    if (!parsedSelfState.success) {
      return failure("self_state_invalid", "L'état propre canonique est invalide.");
    }
    selfState = parsedSelfState.data;
  } catch {
    return failure("self_state_unavailable", "L'état propre canonique n'est pas disponible.");
  }
  if (!selfStateAllowsBoundedLocalWork(selfState)) {
    return failure(
      "self_state_invalid",
      "L'état propre canonique interdit cette exécution locale bornée.",
    );
  }

  const resolveContext = deps.resolveContext ?? resolveSupervisorContext;
  let bridged: BridgeResult;
  try {
    bridged = resolveContext(missionContext, mission);
  } catch {
    return failure(
      "context_bridge_failed",
      "Le contexte de la mission ne peut pas être livré au Supervisor.",
    );
  }
  if (!bridged.ok) {
    return failure(
      "context_bridge_failed",
      "Le contexte de la mission ne peut pas être livré au Supervisor.",
    );
  }
  const supervisorContext: SupervisorEnrichedContext = bridged.envelope;

  const executorIdentity = deps.supervisor.getExecutionIdentity();
  if (!executorIdentity || executorIdentity.tenantId !== tenantId) {
    return failure(
      "capability_preflight_failed",
      "L'identité d'exécution système du Supervisor n'est pas disponible pour ce tenant.",
    );
  }

  let capabilitySnapshot: CapabilitySnapshotItem[];
  try {
    capabilitySnapshot = await (deps.getCapabilities ?? getCapabilitySnapshot)(
      deps.capabilitySnapshotDeps,
      {
        policyRequest: {
          actor: {
            kind: "system",
            id: executorIdentity.id,
            tenantId: executorIdentity.tenantId,
            roles: [...executorIdentity.roles],
            authorizationLevel: executorIdentity.authorizationLevel,
          },
          tenant: { tenantId },
          action: SYSTEM_ACTIONS.SUPERVISOR_WORKER_EXECUTE,
          resource: {
            type: "worker-execution",
            id: missionId,
            ownerTenantId: tenantId,
          },
          risk: "reversible",
          hasExternalEffect: false,
        },
      },
    );
  } catch {
    return failure(
      "capability_preflight_failed",
      "Le préflight des capacités n'a pas pu être établi.",
    );
  }
  const blockers = capabilityBlockers(capabilitySnapshot);

  let plan: Plan;
  try {
    plan = (deps.createPlan ?? createBoundedMissionPlan)(mission);
  } catch {
    return failure("plan_creation_failed", "Le plan borné n'a pas pu être créé.");
  }

  let planning: MissionResult<Mission>;
  try {
    planning = await transitionMission(deps.missionService, missionId, "PLANNING", actorId);
  } catch {
    return failure("mission_transition_failed", "La transition canonique vers PLANNING a échoué.");
  }
  if (!planning.ok) {
    return failure("mission_transition_failed", "La transition canonique vers PLANNING a échoué.");
  }

  let planned: MissionResult<Mission>;
  try {
    planned = await deps.missionService.setPlan({
      missionId,
      plan,
      actorLabel: actorId,
    });
  } catch {
    return failure("plan_persistence_failed", "Le plan borné n'a pas pu être persisté.");
  }
  if (!planned.ok) {
    return failure("plan_persistence_failed", "Le plan borné n'a pas pu être persisté.");
  }

  let inProgress: MissionResult<Mission>;
  try {
    inProgress = await transitionMission(deps.missionService, missionId, "IN_PROGRESS", actorId);
  } catch {
    return failure(
      "mission_transition_failed",
      "La transition canonique vers IN_PROGRESS a échoué.",
    );
  }
  if (!inProgress.ok) {
    return failure(
      "mission_transition_failed",
      "La transition canonique vers IN_PROGRESS a échoué.",
    );
  }

  const blocked = preflightOutcome(blockers);
  if (blocked) {
    let transitioned: MissionResult<Mission>;
    try {
      transitioned = await transitionMission(
        deps.missionService,
        missionId,
        blocked.missionStatus,
        actorId,
      );
    } catch {
      return failure(
        "mission_transition_failed",
        `La transition canonique vers ${blocked.missionStatus} a échoué.`,
      );
    }
    if (!transitioned.ok) {
      return failure(
        "mission_transition_failed",
        `La transition canonique vers ${blocked.missionStatus} a échoué.`,
      );
    }
    return {
      ok: true,
      outcome: blocked.outcome,
      missionId,
      mission: transitioned.data,
      plan,
      blockers,
      mergePerformed: false,
      productionPerformed: false,
    };
  }

  let dag: TaskDag;
  try {
    dag = (deps.createDag ?? createTaskDagFromPlan)({
      mission: inProgress.data,
      plan,
      now: deps.clock().toISOString(),
    });
  } catch {
    return failure("dag_creation_failed", "Le DAG canonique borné n'a pas pu être créé.");
  }

  let validationErrors: string[];
  try {
    validationErrors = (deps.validateTaskDag ?? validateDag)(Object.values(dag.nodes));
  } catch {
    return failure("dag_validation_failed", "Le DAG canonique borné est invalide.");
  }
  if (validationErrors.length > 0) {
    return failure("dag_validation_failed", "Le DAG canonique borné est invalide.");
  }

  let executionResult: SupervisorExecutionResult;
  try {
    executionResult = await deps.supervisor.execute(dag, supervisorContext);
  } catch {
    return failAfterSupervisorFailure({
      deps,
      missionId,
      actorId,
      inProgressMission: inProgress.data,
      plan,
      dagId: dag.id,
    });
  }
  if (executionResult.status !== "SUCCEEDED") {
    return failAfterSupervisorFailure({
      deps,
      missionId,
      actorId,
      inProgressMission: inProgress.data,
      plan,
      dagId: dag.id,
      executionResult,
    });
  }

  let persistedDag: TaskDag | null;
  try {
    persistedDag = await deps.supervisorRepository.findDagById(dag.id);
  } catch {
    return failure(
      "supervisor_state_inconsistent",
      "L'état canonique persisté du Supervisor est indisponible.",
      {
        missionId,
        mission: inProgress.data,
        plan,
        dag: executionResult.dag,
        executionResult,
        mergePerformed: false,
        productionPerformed: false,
      },
    );
  }
  if (!persistedDag) {
    return failure(
      "supervisor_state_inconsistent",
      "Le succès retourné par le Supervisor contredit son état canonique persisté.",
      {
        missionId,
        mission: inProgress.data,
        plan,
        dag: executionResult.dag,
        executionResult,
        mergePerformed: false,
        productionPerformed: false,
      },
    );
  }
  const persistedNodes = Object.values(persistedDag.nodes);
  const returnedNodes = Object.values(executionResult.dag.nodes);
  const canonicalSuccess =
    persistedDag.status === "COMPLETED" &&
    persistedNodes.length > 0 &&
    persistedNodes.every((node) => node.status === "SUCCEEDED");
  const returnedStateConsistent =
    executionResult.dag.id === persistedDag.id &&
    executionResult.dag.status === persistedDag.status &&
    returnedNodes.length === persistedNodes.length &&
    returnedNodes.every((node) => persistedDag.nodes[node.id]?.status === node.status);
  if (!canonicalSuccess || !returnedStateConsistent) {
    return failure(
      "supervisor_state_inconsistent",
      "Le succès retourné par le Supervisor contredit son état canonique persisté.",
      {
        missionId,
        mission: inProgress.data,
        plan,
        dag: persistedDag,
        executionResult,
        mergePerformed: false,
        productionPerformed: false,
      },
    );
  }

  let completed: MissionResult<Mission>;
  try {
    completed = await transitionMission(deps.missionService, missionId, "COMPLETED", actorId);
  } catch {
    return failure(
      "mission_transition_failed",
      "Le DAG est terminé mais la transition canonique de la Mission vers COMPLETED a échoué.",
      {
        missionId,
        mission: inProgress.data,
        plan,
        dag: persistedDag,
        executionResult,
        mergePerformed: false,
        productionPerformed: false,
      },
    );
  }
  if (!completed.ok) {
    return failure(
      "mission_transition_failed",
      "Le DAG est terminé mais la transition canonique de la Mission vers COMPLETED a échoué.",
      {
        missionId,
        mission: inProgress.data,
        plan,
        dag: persistedDag,
        executionResult,
        mergePerformed: false,
        productionPerformed: false,
      },
    );
  }

  return {
    ok: true,
    outcome: "EXECUTED",
    missionId,
    mission: completed.data,
    plan,
    dag: persistedDag,
    executionResult,
    mergePerformed: false,
    productionPerformed: false,
  };
}
