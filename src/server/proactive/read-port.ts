import type { Database } from "@/server/database/client";

import { PostgresSupervisorStore } from "./postgres-supervisor-store";
import type { ProposalState, SupervisorDigest } from "./store";

/** Re-exported so a read-only consumer depends on this surface, not the whole store. */
export type { ProposalState };

/**
 * Read-only view of the Proactive Supervisor's durable rows (decision 0060).
 *
 * `SupervisorStore` also carries `transact`, the supervisor's whole write surface. A
 * read surface has no business holding that: this port binds the database once and hands
 * out `digest` and nothing else, so a caller that only renders situations cannot reach
 * ingest, proposal claiming or situation closing even by mistake.
 *
 * A composed container port owned by the supervisor lane would be better still; until
 * then this keeps the capability narrow at the one place that needs it.
 */
export interface SupervisorReadPort {
  digest(
    tenantId: string,
    window: { since: Date; until: Date; clientScope?: string },
  ): Promise<SupervisorDigest>;
}

export function supervisorReadPort(db: Database): SupervisorReadPort {
  const store = new PostgresSupervisorStore(db);
  return { digest: (tenantId, window) => store.digest(tenantId, window) };
}
