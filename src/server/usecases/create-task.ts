import type { Task } from "@/core/contracts";
import type { AgentLookup, CreateTaskInput, TaskService } from "@/server/services/ports";

export interface CreateTaskDeps {
  tasks: TaskService;
  agents: AgentLookup;
}

export type CreateTaskUseCaseResult =
  | { ok: true; task: Task }
  | {
      ok: false;
      reason: "invalid_input" | "agent_not_found" | "audit_failed";
      message: string;
    };

/**
 * Création d'une tâche. La résolution d'une référence croisée (existence de
 * l'agent assigné) relève du use case ; les invariants locaux (schéma, statut
 * initial, audit) relèvent du service.
 *
 * Sémantique de `assignedAgentId` :
 * - absent : tâche non assignée, autorisée ;
 * - présent : l'agent doit exister, sinon `agent_not_found`.
 */
export function createTask(deps: CreateTaskDeps, input: CreateTaskInput): CreateTaskUseCaseResult {
  if (input.assignedAgentId !== undefined && !deps.agents.getById(input.assignedAgentId)) {
    return {
      ok: false,
      reason: "agent_not_found",
      message: `agent assigné introuvable : ${input.assignedAgentId}`,
    };
  }

  return deps.tasks.create(input);
}
