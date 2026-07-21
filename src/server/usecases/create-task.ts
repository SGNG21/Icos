import type { Task } from "@/core/contracts";
import type { AgentLookup, CreateTaskInput, TaskRepository } from "@/server/repositories/ports";

export interface CreateTaskDeps {
  tasks: TaskRepository;
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
export async function createTask(
  deps: CreateTaskDeps,
  input: CreateTaskInput,
): Promise<CreateTaskUseCaseResult> {
  if (input.assignedAgentId !== undefined && !(await deps.agents.getById(input.assignedAgentId))) {
    return {
      ok: false,
      reason: "agent_not_found",
      message: `agent assigné introuvable : ${input.assignedAgentId}`,
    };
  }

  return deps.tasks.create(input);
}
