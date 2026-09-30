import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity/tenant";
import { DEFAULT_INITIATIVE_POLICY, DEFAULT_RELEVANCE_RULES } from "@/core/proactive/defaults";
import type { Container } from "@/server/container";

import { CanonicalGoalIntake, MissionSubjectStatus } from "./adapters";
import {
  ComputeHealthObservation,
  type ObservationSchedule,
  type ObservationSource,
} from "./observations";
import { PostgresSupervisorStore } from "./postgres-supervisor-store";
import { ProactiveSupervisor } from "./proactive-supervisor";

/** Observed every 15 min: well above the 60 s floor, and a digest-friendly grain. */
export const COMPUTE_HEALTH_OBSERVATION: ObservationSchedule = Object.freeze({
  observationKey: "compute-health",
  tenantId: CURRENT_SINGLE_TENANT_ID,
  intervalMs: 15 * 60_000,
});

/**
 * Production composition (decision 0060). PostgreSQL only: without a database there is
 * no supervisor at all — never a silent in-memory one whose history vanishes.
 *
 * Tool Gateway, attention delivery and episode publishing are left at their
 * NOT_CONNECTED defaults until those lanes integrate; their pending rows are kept,
 * settled as `not_connected`, and visible in the digest.
 */
export function composeProactiveSupervisor(
  container: Pick<
    Container,
    "db" | "goalNormalizer" | "goalPlanner" | "goalPreviewStore" | "goalRepository" | "mission"
  >,
): { supervisor: ProactiveSupervisor; sources: Record<string, ObservationSource> } | null {
  if (!container.db) return null;
  const supervisor = new ProactiveSupervisor({
    store: new PostgresSupervisorStore(container.db),
    rules: DEFAULT_RELEVANCE_RULES,
    policy: DEFAULT_INITIATIVE_POLICY,
    goalIntake: new CanonicalGoalIntake({
      normalizer: container.goalNormalizer,
      planner: container.goalPlanner,
      previews: container.goalPreviewStore,
      goals: container.goalRepository,
    }),
    subjects: new MissionSubjectStatus(container.mission),
  });
  return {
    supervisor,
    sources: {
      [COMPUTE_HEALTH_OBSERVATION.observationKey]: new ComputeHealthObservation(container.db),
    },
  };
}
