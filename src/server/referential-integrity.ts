import type { Agent, AgentAction, Task } from "@/core/contracts";

/**
 * Vérifie la cohérence référentielle des données seedées. Toute incohérence
 * lève une erreur afin de faire échouer explicitement la composition du
 * container plutôt que de laisser passer un état incohérent silencieux.
 *
 * Règles bidirectionnelles action ↔ tâche :
 * - si `action.taskId` est défini, la tâche doit exister et contenir l'action
 *   dans `task.actionIds` ;
 * - tout identifiant listé dans `task.actionIds` doit référencer une action
 *   dont `taskId` désigne cette tâche.
 * Règle agent :
 * - un `assignedAgentId` de tâche, s'il est présent, doit référencer un agent
 *   existant.
 */
export function assertReferentialIntegrity(input: {
  agents: readonly Agent[];
  tasks: readonly Task[];
  actions: readonly AgentAction[];
}): void {
  const { agents, tasks, actions } = input;
  const agentIds = new Set(agents.map((agent) => agent.id));
  const taskById = new Map(tasks.map((task) => [task.id, task] as const));
  const actionById = new Map(actions.map((action) => [action.id, action] as const));

  for (const task of tasks) {
    if (task.assignedAgentId !== undefined && !agentIds.has(task.assignedAgentId)) {
      throw new Error(
        `intégrité seed : tâche ${task.id} assignée à un agent inexistant ${task.assignedAgentId}`,
      );
    }
    for (const actionId of task.actionIds) {
      const action = actionById.get(actionId);
      if (!action) {
        throw new Error(
          `intégrité seed : tâche ${task.id} référence une action inexistante ${actionId}`,
        );
      }
      if (action.taskId !== task.id) {
        throw new Error(
          `intégrité seed : action ${actionId} listée par ${task.id} mais son taskId est ${String(action.taskId)}`,
        );
      }
    }
  }

  for (const action of actions) {
    if (!agentIds.has(action.initiatedByAgentId)) {
      throw new Error(
        `intégrité seed : action ${action.id} initiée par un agent inexistant ${action.initiatedByAgentId}`,
      );
    }
    if (action.taskId !== undefined) {
      const task = taskById.get(action.taskId);
      if (!task) {
        throw new Error(
          `intégrité seed : action ${action.id} référence une tâche inexistante ${action.taskId}`,
        );
      }
      if (!task.actionIds.includes(action.id)) {
        throw new Error(
          `intégrité seed : action ${action.id} pointe vers ${action.taskId} qui ne la liste pas`,
        );
      }
    }
  }
}
