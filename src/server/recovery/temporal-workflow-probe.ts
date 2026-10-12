import { Client, Connection, WorkflowNotFoundError } from "@temporalio/client";

import type { WorkflowProbe, WorkflowStatus } from "@/core/contracts/recovery";

/**
 * Sonde d'état d'exécution Temporal (lecture seule : `describe`). Fail-closed : toute erreur autre que
 * « workflow introuvable » donne `unknown`, jamais une décision destructrice.
 */
export class TemporalWorkflowProbe implements WorkflowProbe {
  private clientPromise?: Promise<Client>;

  constructor(
    private readonly address = "localhost:7233",
    private readonly timeoutMs = 10_000,
    private readonly mockClient?: Pick<Client, "workflow">, // TEST ONLY
    /**
     * THE DISPATCHER'S NAMESPACE, or the probe describes the wrong Temporal. A probe left in
     * `default` while workflows run in TEMPORAL_NAMESPACE answers "not found" for every live
     * attempt, and recovery then supersedes work that is in fact running — the opposite of
     * recovery. Only ever read, never created here.
     */
    private readonly namespace = "default",
  ) {}

  private client(): Promise<Pick<Client, "workflow">> {
    if (this.mockClient) return Promise.resolve(this.mockClient);
    this.clientPromise ??= Connection.connect({
      address: this.address,
      connectTimeout: this.timeoutMs,
    })
      .then((connection) => new Client({ connection, namespace: this.namespace }))
      .catch((error: unknown) => {
        this.clientPromise = undefined; // an outage must not poison later sweeps
        throw error;
      });
    return this.clientPromise;
  }

  async status(workflowId: string): Promise<WorkflowStatus> {
    try {
      const client = await this.client();
      const description = await client.workflow.getHandle(workflowId).describe();
      switch (description.status.name) {
        // CONTINUED_AS_NEW: the execution carries on under the same workflowId.
        case "RUNNING":
        case "CONTINUED_AS_NEW":
          return "running";
        case "UNSPECIFIED":
        case "UNKNOWN":
          return "unknown";
        default:
          return "closed";
      }
    } catch (error) {
      return error instanceof WorkflowNotFoundError ? "not_found" : "unknown";
    }
  }
}
