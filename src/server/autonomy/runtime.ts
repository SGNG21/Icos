export type AutonomousRuntimeState =
  | "running"
  | "waiting"
  | "replanning"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled"
  | "escalated";

export interface AutonomousMissionRuntime {
  missionId: string;

  state: AutonomousRuntimeState;

  startedAt: Date;
  updatedAt: Date;

  lastHeartbeatAt: Date;
  lastProgressAt: Date;

  cycleCount: number;
  replanCount: number;
  stagnationCount: number;

  maxCycles: number;
  maxReplans: number;
  maxRuntimeMs: number;
  maxStagnationCycles: number;

  lastFingerprint?: string;
  lastReason?: string;

  ownerToken?: string | null;
  leaseUntil?: Date | null;

  workerId?: string | null;
  workspaceId?: string | null;
  attemptId?: string | null;
  workflowId?: string | null;
}

export interface AutonomousMissionRuntimeRepository {
  create(
    runtime: AutonomousMissionRuntime,
  ): Promise<void>;

  createIfAbsent(
    runtime: AutonomousMissionRuntime,
  ): Promise<boolean>;

  get(
    missionId: string,
  ): Promise<AutonomousMissionRuntime | null>;

  /**
   * Returns non-terminal autonomous runtimes which are expected
   * to be actively executing but currently have no valid owner.
   *
   * Legitimate `waiting` runtimes are intentionally excluded:
   * they resume through event-driven callbacks.
   */
  listRecoverable(
    limit?: number,
  ): Promise<AutonomousMissionRuntime[]>;

  save(
    runtime: AutonomousMissionRuntime,
  ): Promise<void>;


  /**
   * Atomically claims this autonomous mission for one runner.
   *
   * Returns false when another unexpired owner holds it.
   */
  claim(
    missionId: string,
    ownerToken: string,
    leaseMs: number,
  ): Promise<boolean>;

  /**
   * Releases ownership only if ownerToken is still the owner.
   */
  release(
    missionId: string,
    ownerToken: string,
  ): Promise<void>;


  /**
     * Saves runtime state only while ownerToken still owns
     * a non-expired lease.
     *
     * Fails closed when ownership was lost or expired.
     */
    saveOwned(
      runtime: AutonomousMissionRuntime,
      ownerToken: string,
    ): Promise<void>;

    /**
     * Renews the lease for the mission if the ownerToken is still valid.
     * Returns true if renewed, false if ownership lost or lease invalid.
     */
    renewClaim(
      missionId: string,
      ownerToken: string,
      leaseMs: number,
    ): Promise<boolean>;
}
