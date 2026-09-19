import type { AuthenticatedSession } from "@/core/identity";
import type { MissionRepository } from "@/server/mission/ports";
import type { AgentScope, TaskRepository } from "@/server/repositories/ports";
import type { Container } from "@/server/container";

/** Minimum privilege: no linked agent, so only unassigned work is reachable. */
const NO_AGENTS: AgentScope = { kind: "linked", agentIds: new Set() };

/**
 * Operational scope of the caller, fail closed. Reuses `OperationalAccessService.resolveScope`
 * (no second permission system) and degrades to the minimum scope when the service is
 * absent or returns something that is not a valid scope. A resolution error propagates
 * (the route answers 500 and nothing is mutated).
 */
export async function resolveOperationalScope(
  container: Pick<Container, "operationalAccess">,
  session: AuthenticatedSession,
): Promise<AgentScope> {
  if (!container.operationalAccess) return NO_AGENTS;
  const scope = (await container.operationalAccess.resolveScope(session)) as AgentScope | null;
  if (scope?.kind === "global") return scope;
  if (scope?.kind === "linked" && scope.agentIds instanceof Set) return scope;
  return NO_AGENTS;
}

/**
 * A Mission has no owner of its own: it is in scope only if EVERY canonical Task behind
 * its MissionTasks is in scope (same rule as `TaskRepository.getByIdForScope`: unassigned
 * or assigned to a linked agent). A missing canonical Task is out of scope.
 */
export async function isMissionInScope(
  deps: { mission: Pick<MissionRepository, "listTasks">; tasks: Pick<TaskRepository, "getByIdForScope"> },
  missionId: string,
  scope: AgentScope,
): Promise<boolean> {
  if (scope.kind === "global") return true;
  for (const missionTask of await deps.mission.listTasks(missionId)) {
    if (!(await deps.tasks.getByIdForScope(missionTask.taskId, scope))) return false;
  }
  return true;
}
