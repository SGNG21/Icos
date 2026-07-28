import type { SelfStateSnapshot } from "@/core/self-state";

import { loadSelfStateSnapshot } from "./load-self-state-snapshot";

/**
 * Read-only application use case for consumers such as the cockpit,
 * conversation layer, and governed self-improvement planning.
 *
 * Self-state is planning context only. It grants no permission, approval,
 * authority, capability authorization, or execution grant.
 */
export function getSelfStateSnapshot(): SelfStateSnapshot {
  return loadSelfStateSnapshot();
}
