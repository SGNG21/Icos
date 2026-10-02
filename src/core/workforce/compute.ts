import type { ComputeRequirement, TaskComplexity } from "@/core/workers/compute-routing";
import type { WorkerRequirement } from "@/core/workers/worker-eligibility";

import type { AgentRole, ComputeNeed, SkillDefinition } from "./contracts";

/**
 * The workforce ↔ OmniRoute seam (decision 0057). Digital Workforce REQUESTS compute by
 * capability and difficulty; the canonical CapabilityRouter (decisions 0031–0054, lane A)
 * CHOOSES the worker and model. Nothing here names or selects a model.
 */
export interface WorkforceComputeRequest {
  /** → WorkerRequirement.requiredCapabilities */
  workerCapabilities: string[];
  /** → ComputeRequirement.complexity */
  complexity: TaskComplexity;
  risk?: ComputeRequirement["risk"];
  /** Recorded for evidence; never a gate, never identity. */
  modelHints: string[];
}

const COMPLEXITY_BY_RISK = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "high",
} as const;
const REASONING_FLOOR = { shallow: "low", standard: "medium", deep: "high" } as const;
const ORDER: readonly TaskComplexity[] = ["low", "medium", "high"];
const higher = (a: TaskComplexity, b: TaskComplexity) =>
  ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;

/**
 * The STRICTER of two difficulties; a missing second one never lowers the first. Used where a
 * brain assignment and a canonical Task both state a difficulty: the bar may only go up.
 */
export function higherComplexity(a: TaskComplexity, b?: TaskComplexity): TaskComplexity {
  return b ? higher(a, b) : a;
}

export function computeRequestFor(input: {
  skill: SkillDefinition;
  role?: Pick<AgentRole, "roleId">;
  agentCompute?: ComputeNeed;
  taskRisk?: ComputeRequirement["risk"];
}): WorkforceComputeRequest {
  const { skill, agentCompute, taskRisk } = input;
  const needs = [skill.compute, ...(agentCompute ? [agentCompute] : [])];
  const complexity = needs.reduce<TaskComplexity>(
    (acc, n) => higher(acc, REASONING_FLOOR[n.reasoning]),
    COMPLEXITY_BY_RISK[skill.risk],
  );
  return {
    workerCapabilities: [...new Set(needs.flatMap((n) => n.workerCapabilities))].sort(),
    complexity,
    ...(taskRisk ? { risk: taskRisk } : {}),
    modelHints: [...new Set(needs.flatMap((n) => n.modelHints))],
  };
}

/** The canonical matcher's input. Dispatch itself is lane A (NOT_CONNECTED here). */
export function toWorkerRequirement(
  req: WorkforceComputeRequest,
): Pick<WorkerRequirement, "requiredCapabilities"> {
  return { requiredCapabilities: req.workerCapabilities };
}
