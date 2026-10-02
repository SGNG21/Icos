import type { TaskComplexity } from "@/core/workers/compute-routing";
import { higherComplexity } from "@/core/workforce/compute";
import type { WorkAssignment } from "@/core/workforce/contracts";
import type { Principal } from "@/core/workforce/governance";

import type { WorkforceComputePort } from "./compute-port";
import type { WorkforceStore } from "./ports";

/**
 * THE CORE3 CALL SITE OF `WorkforceComputePort.requestFor` (decisions 0057 §integration, 0066).
 *
 * Plane 4 (CORE3) ASKS, plane 5 (Workforce) ANSWERS, plane 6 (OmniRoute) CHOOSES. This is the
 * adapter in between: the supervisor knows a mission task, the compute port knows a brain
 * assignment, and the answer is expressed in the ONLY vocabulary the canonical matcher accepts
 * — worker capabilities and difficulty. No model, no provider, no model hint crosses it.
 *
 * It creates NO authority of its own: it reads the assignment the workforce already recorded
 * and delegates every derivation to `requestFor`. Nothing here decides who may do anything.
 *
 * WHAT A BRAIN CAN DO TO A DISPATCH, PLAINLY:
 *  - RAISE the difficulty (`complexity`), never lower it (the caller takes the stricter);
 *  - ADD worker capabilities the brain's skill declares, never remove the task's own;
 *  - HOLD the dispatch while a required human approval is missing.
 * That is the whole contract. A brain cannot name a model and cannot widen a requirement.
 */

/** An assignment waiting to run. `executing`/`accepted` are already past dispatch. */
const AWAITING_DISPATCH: ReadonlySet<WorkAssignment["status"]> = new Set([
  "assigned",
  "changes_requested",
]);

export interface BrainComputeNeed {
  /**
   * TOUTES les affectations vivantes de cette tâche, pas une seule.
   *
   * Le défaut (verrou C6) : `find()` prenait la PREMIÈRE de la liste, donc la première par
   * ordre d'id. Deux affectations vivantes sur la même tâche — une reprise, un changement de
   * cerveau, une double écriture — et la plus STRICTE pouvait être ignorée : sa capacité
   * supplémentaire disparaissait, et surtout son approbation humaine requise cessait de
   * retenir le dispatch. Un contournement d'approbation par ordre lexicographique.
   */
  assignmentIds: readonly string[];
  /** Les identités durables à qui ce travail est affecté, pour la provenance. */
  agentIds: readonly string[];
  /**
   * Worker capabilities, in the canonical matcher's vocabulary — `toWorkerRequirement`, not the
   * assignment's own role/skill capability keys (those select the AGENT, not the worker).
   */
  workerCapabilities: readonly string[];
  complexity: TaskComplexity;
  /** A required approval that is not given means CORE3 must not dispatch. */
  approvalPending: boolean;
}

export interface WorkforceTaskCompute {
  /** `null` when no brain assignment is waiting for this mission task. */
  forTask(missionId: string, taskId: string): Promise<BrainComputeNeed | null>;
}

export function workforceTaskCompute(deps: {
  compute: Pick<WorkforceComputePort, "requestFor">;
  store: Pick<WorkforceStore, "listAssignments">;
  /**
   * Issued by the composition root for `core3-dispatch`. It CARRIES the tenant (the
   * single-tenant shim of `principals.ts`): nothing here hardcodes or guesses one, and no
   * tenant context would mean no tenant operation.
   */
  system: Principal;
}): WorkforceTaskCompute {
  return {
    async forTask(missionId, taskId) {
      /*
       * ponytail: linear scan of the tenant's assignments. The store exposes no by-task read
       * and the seam is new; add one (`workforce_assignments_mission_idx` already exists) if
       * assignment volume ever makes this measurable.
       */
      const assignments = await deps.store.listAssignments(deps.system.tenantId);
      const live = assignments.filter(
        (a) => a.missionId === missionId && a.taskId === taskId && AWAITING_DISPATCH.has(a.status),
      );
      if (live.length === 0) return null;

      /*
       * LA PLUS STRICTE GAGNE, SUR CHAQUE AXE INDÉPENDAMMENT (verrou C6).
       *
       * Prendre la première affectation laissait la plus stricte être ignorée. Refuser tout
       * net quand il y en a plusieurs bloquerait un dispatch légitime sur une incohérence de
       * données. On applique donc la contrainte la plus forte de chacune : c'est exactement
       * le contrat déjà annoncé de ce seam — un cerveau ne peut que RESSERRER — et la seule
       * composition qui ne puisse jamais relâcher ce qu'une affectation exigeait.
       *
       *   difficulté   -> la PLUS HAUTE
       *   capacités    -> l'UNION (ajouter est permis, retirer ne l'est pas)
       *   approbation  -> EN ATTENTE dès qu'UNE SEULE l'exige sans l'avoir
       */
      const requests = await Promise.all(
        live.map((a) => deps.compute.requestFor(deps.system, a.assignmentId)),
      );

      const workerCapabilities = new Set<string>();
      let complexity: TaskComplexity | undefined;
      let approvalPending = false;
      for (const request of requests) {
        // Absent means the brain's skill declares NO worker capability — nothing to add to the
        // task's own requirement. It is never a wildcard, so it never widens anything.
        for (const capability of request.workerRequirement.requiredCapabilities ?? []) {
          workerCapabilities.add(capability);
        }
        complexity = higherComplexity(request.compute.complexity, complexity);
        approvalPending ||= request.approval.required && !request.approval.satisfied;
      }

      return {
        assignmentIds: requests.map((r) => r.assignmentId),
        agentIds: requests.map((r) => r.agent.agentId),
        workerCapabilities: [...workerCapabilities],
        /* `requests` n'est jamais vide ici : `live.length === 0` est déjà sorti plus haut. */
        complexity: complexity as TaskComplexity,
        approvalPending,
      };
    },
  };
}
