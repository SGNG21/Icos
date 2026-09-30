import type { WorkerRegistryStore } from "@/server/repositories/worker-ports";
import { isMissionInScope, resolveOperationalScope } from "@/server/administration/mission-scope";
import type { OperationalAccessService } from "@/server/administration/operational-access-service";
import type { AuthGateway } from "@/server/auth/ports";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskRepository } from "@/server/repositories/ports";
import type { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";

import { ControlCommandBus } from "./command-bus";
import type { ControlEffects, ControlStore } from "./ports";
import { ReauthService } from "./reauth";
import { RuntimeControlGuard } from "./runtime-control";

/** The control plane as one container field (decision 0055). */
export interface ControlPlane {
  store: ControlStore;
  guard: RuntimeControlGuard;
  bus: ControlCommandBus;
  reauth: ReauthService;
}

export interface ControlEffectsDeps {
  missions: MissionRepository;
  tasks: TaskRepository;
  operationalAccess?: OperationalAccessService;
  workers: WorkerRegistryStore;
  registration: WorkerRegistrationService;
}

/**
 * Adapter from the bus to the EXISTING authorities: mission repository +
 * machine (via compare-and-set), operational scope, worker registration.
 */
export function createControlEffects(deps: ControlEffectsDeps): ControlEffects {
  return {
    readMission: (id) => deps.missions.findById(id),
    missionInScope: async (missionId, session) => {
      const scope = await resolveOperationalScope(
        { operationalAccess: deps.operationalAccess },
        session,
      );
      return isMissionInScope({ mission: deps.missions, tasks: deps.tasks }, missionId, scope);
    },
    cancelMission: async (id, from) =>
      // Without compare-and-set the cancel could overwrite a concurrent terminal
      // status: refuse (FAILED, nothing changed) rather than write blindly.
      deps.missions.transitionMissionStatusIf
        ? deps.missions.transitionMissionStatusIf(id, from, "cancelled")
        : false,
    readWorker: (id) => deps.workers.get(id),
    disableWorker: async (id) => {
      if (!(await deps.registration.deactivate(id))) throw new Error("WORKER_NOT_FOUND");
    },
    enableWorker: async (id) => {
      if (!(await deps.registration.reactivate(id))) throw new Error("WORKER_NOT_FOUND");
    },
  };
}

export function composeControlPlane(input: {
  store: ControlStore;
  guard?: RuntimeControlGuard;
  effects: ControlEffectsDeps;
  auth?: Pick<AuthGateway, "verifyPassword">;
}): ControlPlane {
  const guard = input.guard ?? new RuntimeControlGuard(input.store);
  return {
    store: input.store,
    guard,
    bus: new ControlCommandBus({
      store: input.store,
      effects: createControlEffects(input.effects),
    }),
    reauth: new ReauthService(input.store, {
      // No auth composed ⇒ no re-auth possible ⇒ HIGH/CRITICAL commands are unreachable (fail closed).
      verifyPassword: async (headers, password) =>
        input.auth?.verifyPassword ? input.auth.verifyPassword(headers, password) : false,
    }),
  };
}
