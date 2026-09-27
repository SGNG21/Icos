import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import type { WorkerRegistryStore } from "@/server/repositories/worker-ports";
import {
  evaluateWorkerPool,
  selectWorker,
  type WorkerEligibilityVerdict,
  type WorkerRequirement,
} from "@/core/workers/worker-eligibility";

/**
 * Capability routing (M4, mission N15, decision 0031).
 *
 * Turns `tasks.required_capabilities` — durable since migration 0041 but until
 * now consumed by nothing — into an actual worker selection.
 *
 * It owns NO matching logic of its own. Eligibility is entirely delegated to
 * the canonical authority in src/core/workers/worker-eligibility.ts, which is
 * also what IndependentReviewerSelector and BoundedRepairController use. One
 * question, one answer.
 *
 * M5: the router reads the DURABLE STORE directly, not a boot-time snapshot.
 * In M4 it consumed the hydrated `WorkerRegistryPort` read model, so a worker
 * registered or re-probed mid-process kept its stale eligibility until the next
 * container build — which meant a worker that had just gone unhealthy kept
 * receiving work. Reading the authority is both simpler and correct.
 *
 * THE ONE PERMISSIVE PATH, STATED PLAINLY
 * An EMPTY registry yields ROUTING_UNCONFIGURED and the caller dispatches as it
 * did before M4. This is not a fail-open matcher — it is the honest
 * "no routing table exists yet" state, and it is what keeps M4 reversible while
 * no deployment has registered workers. The moment ONE worker is registered the
 * registry becomes authoritative and routing fails closed: a task whose
 * capabilities nobody satisfies is refused, never dispatched to an arbitrary
 * worker.
 */
export type CapabilityRoutingDecision = "ROUTED" | "NO_ELIGIBLE_WORKER" | "ROUTING_UNCONFIGURED";

export interface CapabilityRoutingResult {
  decision: CapabilityRoutingDecision;
  /** Non-null only for ROUTED. */
  worker: WorkerRegistryEntry | null;
  requirement: WorkerRequirement;
  /**
   * Verdict for every candidate considered, ordered by worker id. This is the
   * durable "why" behind a refusal; a routing decision that cannot explain
   * itself is not evidence.
   */
  candidates: WorkerEligibilityVerdict[];
  reason: string;
}

export class CapabilityRouter {
  constructor(private readonly workers: WorkerRegistryStore) {}

  async route(requirement: WorkerRequirement): Promise<CapabilityRoutingResult> {
    const pool = await this.workers.list();

    if (pool.length === 0) {
      return {
        decision: "ROUTING_UNCONFIGURED",
        worker: null,
        requirement,
        candidates: [],
        reason: "Worker registry is empty: no routing table is configured.",
      };
    }

    const candidates = evaluateWorkerPool(pool, requirement);
    const worker = selectWorker(pool, requirement);

    if (!worker) {
      return {
        decision: "NO_ELIGIBLE_WORKER",
        worker: null,
        requirement,
        candidates,
        reason: `No eligible worker among ${pool.length} registered for capabilities [${
          (requirement.requiredCapabilities ?? []).join(", ") || "none"
        }]${requirement.workerKind ? ` and workerKind ${requirement.workerKind}` : ""}.`,
      };
    }

    return {
      decision: "ROUTED",
      worker,
      requirement,
      candidates,
      reason: `Routed to worker ${worker.id} (${worker.workerKind}).`,
    };
  }
}
