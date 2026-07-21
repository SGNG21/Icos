import { agentSchema, agentActionSchema, taskSchema } from "@/core/contracts";
import type { Agent, AgentAction, Task } from "@/core/contracts";
import { InMemoryAuditLog, type AuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryActionDecisionStore } from "@/server/services/in-memory/action-decision-store";
import { InMemoryActionService } from "@/server/services/in-memory/action-service";
import { InMemoryAgentService } from "@/server/services/in-memory/agent-service";
import { InMemoryApprovalService } from "@/server/services/in-memory/approval-service";
import { InMemoryTaskService } from "@/server/services/in-memory/task-service";
import type {
  ActionDecisionUnitOfWork,
  ActionService,
  AgentService,
  ApprovalService,
  TaskService,
} from "@/server/services/ports";
import { InMemoryActionDecisionUnitOfWork } from "@/server/uow/in-memory-action-decision-uow";
import { demoActions } from "@/features/actions/data";
import { demoAgents } from "@/features/agents/data";
import { demoTasks } from "@/features/tasks/data";

import { assertReferentialIntegrity } from "./referential-integrity";

export interface Container {
  agents: AgentService;
  tasks: TaskService;
  actions: ActionService;
  approvals: ApprovalService;
  auditLog: AuditLog;
  decisionUow: ActionDecisionUnitOfWork;
}

export interface ContainerSeeds {
  agents: readonly Agent[];
  tasks: readonly Task[];
  actions: readonly AgentAction[];
}

const defaultSeeds: ContainerSeeds = {
  agents: demoAgents,
  tasks: demoTasks,
  actions: demoActions,
};

/**
 * Construit un container neuf. Les seeds sont validés puis contrôlés en
 * intégrité référentielle : une incohérence lève, faisant échouer explicitement
 * la composition plutôt que de laisser passer un état incohérent.
 */
export function buildContainer(seeds: ContainerSeeds = defaultSeeds): Container {
  const agents = seeds.agents.map((agent) => agentSchema.parse(agent));
  const tasks = seeds.tasks.map((task) => taskSchema.parse(task));
  const actions = seeds.actions.map((action) => agentActionSchema.parse(action));

  assertReferentialIntegrity({ agents, tasks, actions });

  const auditLog = new InMemoryAuditLog();
  const store = new InMemoryActionDecisionStore(actions);

  return {
    agents: new InMemoryAgentService(agents),
    tasks: new InMemoryTaskService(auditLog, tasks),
    actions: new InMemoryActionService(store),
    approvals: new InMemoryApprovalService(store),
    auditLog,
    decisionUow: new InMemoryActionDecisionUnitOfWork(store, auditLog),
  };
}

/**
 * Singleton mémoïsé sur `globalThis`.
 *
 * Comportement — état VOLATIL, jamais persistant :
 * - il peut survivre à certains rechargements de modules en développement (HMR),
 *   mais cette survie n'est PAS une garantie contractuelle ;
 * - un redémarrage du processus, un déploiement ou un démarrage à froid
 *   serverless le réinitialisent ;
 * - chaque instance serveur possède son propre état (aucune cohérence
 *   multi-instances) ;
 * - réservé au runtime Node.js ; ne pas utiliser depuis le runtime Edge.
 *
 * PostgreSQL remplacera ce stockage volatil par une persistance réelle.
 */
const CONTAINER_KEY = "__icosContainer__";

type GlobalWithContainer = typeof globalThis & { [CONTAINER_KEY]?: Container };

export function getContainer(): Container {
  const globalRef = globalThis as GlobalWithContainer;
  globalRef[CONTAINER_KEY] ??= buildContainer();
  return globalRef[CONTAINER_KEY];
}
