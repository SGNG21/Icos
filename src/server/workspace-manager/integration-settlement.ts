import type {
  IntegrationSettlement,
  IntegrationSettlementPort,
} from "@/core/contracts/quality-control";

import type { Git } from "./git";
import type { WorkspaceManager } from "./manager";

/**
 * Answers "is this workflow's governed work integrated?" from DURABLE state (DEFECT 36).
 *
 * A review APPROVE is necessary but not sufficient: for governed work the dependency-satisfying
 * fact is the integration. Integrated is asked of git, the same exactly-once evidence the
 * IntegrationApplier uses (`ALREADY_INTEGRATED`): the gate accepted the workspace AND its
 * accepted commit is contained in the integration target. A registry flag alone would be wrong
 * in both directions — `accepted` also covers NEEDS_REBASE/RACE_LOST, and a release also
 * follows a REJECT.
 */
export class WorkspaceIntegrationSettlement implements IntegrationSettlementPort {
  constructor(
    private readonly manager: Pick<WorkspaceManager, "list">,
    private readonly git: Pick<Git, "isAncestor">,
    /** Whether the workflow's task may only run governed (`requiresGovernedWorkspace`). */
    private readonly requiresGovernance: (workflowId: string) => Promise<boolean> = async () =>
      false,
  ) {}

  async settlementOf(workflowId: string): Promise<IntegrationSettlement> {
    const workspaces = (await this.manager.list()).filter((w) => w.workflowId === workflowId);
    if (workspaces.length === 0) {
      /*
       * FAIL CLOSED (decision 0052). "No workspace" means ungoverned work only for a task that
       * never needed one. A WRITER without its workspace ran outside governance — nothing was
       * gated or integrated — so its approval completes nothing: it is refused, never
       * `succeeded`. Read as UNGOVERNED, it reported an un-integrated correction as done.
       */
      return (await this.requiresGovernance(workflowId)) ? "REJECTED" : "UNGOVERNED";
    }

    for (const ws of workspaces) {
      if (
        ws.status === "accepted" &&
        ws.sourceCommit &&
        (await this.git.isAncestor(ws.sourceCommit, ws.integrationTarget).catch(() => false))
      ) {
        return "INTEGRATED";
      }
    }

    /*
     * Not integrated. Still pending while any workspace is live, or while an accepted one
     * waits for its commit to reach the target. Only a workspace reaped WITHOUT acceptance is
     * a definitive refusal — never guess "rejected" from silence.
     */
    const refused = workspaces.every((w) => w.releasedAt !== null && w.status !== "accepted");
    return refused ? "REJECTED" : "PENDING";
  }
}
