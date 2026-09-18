import type { Mission, MissionTask } from "@/core/mission/contracts";

import type { MissionRepository } from "@/server/mission/ports";

import type { MissionPlan } from "@/server/mission/mission-plan";

import type {
  AutonomousMissionRuntime,
  AutonomousMissionRuntimeRepository,
} from "@/server/autonomy/runtime";

import { randomUUID } from "node:crypto";

export interface AutonomousMissionPlanner {
  plan(input: {
    mission: Mission;
    tasks: MissionTask[];
    reason: "initial" | "stagnation" | "deadlock";
    signal?: AbortSignal;
  }): Promise<MissionPlan>;
}

export interface AutonomousSupervisor {
  run(missionId: string, signal?: AbortSignal): Promise<unknown>;

  reconcilePreparedDispatches(missionId?: string, signal?: AbortSignal): Promise<void>;
}

export interface AutonomousMissionRunnerOptions {
  maxCycles: number;
  maxRuntimeMs: number;
  maxStagnationCycles: number;

  /*
   * Replanning is introduced in N2.7-5.
   * Persist the budget now so restart semantics are already stable.
   */
  maxReplans?: number;
  leaseMs?: number;
  leaseRenewalTimeoutMs?: number;
  leaseRenewalTimer?: LeaseRenewalTimer;
}

export type AutonomousMissionRunnerState =
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled"
  | "deadlock"
  | "escalated";

export interface AutonomousMissionRunnerResult {
  missionId: string;
  state: AutonomousMissionRunnerState;
  cycleCount: number;
  stagnationCount: number;
  startedAt: Date;
  finishedAt: Date;
  lastFingerprint: string;
  reason: string;
}

interface LeaseRenewalGuard {
  signal?: AbortSignal;

  assertOwned(): void;

  guard<T>(operation: () => Promise<T>): Promise<T>;

  stop(): Promise<void>;
}

interface LeaseRenewalTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;

  clearTimeout(handle: unknown): void;
}

const TERMINAL_MISSION_STATES = new Set<string>(["succeeded", "failed", "blocked", "cancelled"]);

const ACTIVE_TASK_STATES = new Set<string>([
  "queued",
  "running",
  "review_pending",
  "awaiting_approval",
]);

const DEFAULT_LEASE_MS = 5 * 60 * 1000;

const DEFAULT_LEASE_RENEWAL_TIMEOUT_MS = 30 * 1000;

const OWNERSHIP_LOST_REASON = "AUTONOMOUS_RUNTIME_OWNERSHIP_LOST";

const SYSTEM_LEASE_RENEWAL_TIMER: LeaseRenewalTimer = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function fingerprintTasks(mission: Mission, tasks: MissionTask[]): string {
  const normalized = [...tasks]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((task) => ({
      id: task.id,
      taskId: task.taskId,
      status: task.status,
      dependsOn: [...task.dependsOn].sort(),
    }));

  return JSON.stringify({
    missionStatus: mission.status,
    tasks: normalized,
  });
}

function hasActiveWork(tasks: MissionTask[]): boolean {
  return tasks.some((task) => ACTIVE_TASK_STATES.has(task.status));
}

function readyDraftTasks(tasks: MissionTask[]): MissionTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));

  return tasks.filter((task) => {
    if (task.status !== "draft") {
      return false;
    }

    return task.dependsOn.every((dependencyId) => byId.get(dependencyId)?.status === "succeeded");
  });
}

function hasDraftTasks(tasks: MissionTask[]): boolean {
  return tasks.some((task) => task.status === "draft");
}

export class AutonomousMissionRunner {
  constructor(
    private readonly missions: Pick<
      MissionRepository,
      "findById" | "listTasks" | "applyPlan" | "replacePlan"
    >,

    private readonly supervisor: AutonomousSupervisor,

    private readonly planner: AutonomousMissionPlanner,

    private readonly options: AutonomousMissionRunnerOptions = {
      maxCycles: 100,
      maxRuntimeMs: 60 * 60 * 1000,
      maxStagnationCycles: 3,
      maxReplans: 5,
    },

    private readonly now: () => Date = () => new Date(),

    /*
     * Optional for backward compatibility with the existing
     * unit-test surface.
     *
     * Production durable autonomy will inject PostgreSQL here.
     */
    private readonly runtimeRepository?: AutonomousMissionRuntimeRepository,
  ) {}

  async run(missionId: string): Promise<AutonomousMissionRunnerResult> {
    let runtime = await this.loadOrCreateRuntime(missionId);

    const ownerToken = this.runtimeRepository ? randomUUID() : null;

    const leaseMs = this.options.leaseMs ?? DEFAULT_LEASE_MS;

    const leaseRenewalTimeoutMs = this.runtimeRepository
      ? this.resolveLeaseRenewalTimeoutMs(leaseMs)
      : DEFAULT_LEASE_RENEWAL_TIMEOUT_MS;

    if (this.runtimeRepository && ownerToken) {
      const claimed = await this.runtimeRepository.claim(missionId, ownerToken, leaseMs);

      if (!claimed) {
        return this.result(runtime, "waiting", "AUTONOMY_RUNTIME_ALREADY_OWNED");
      }
    }

    const leaseRenewal = this.startLeaseRenewal(
      missionId,
      ownerToken,
      leaseMs,
      leaseRenewalTimeoutMs,
    );

    try {
      for (;;) {
        leaseRenewal.assertOwned();

        const heartbeat = this.now();

        runtime = {
          ...runtime,

          state: runtime.state === "replanning" ? "replanning" : "running",

          updatedAt: heartbeat,

          lastHeartbeatAt: heartbeat,
        };

        await leaseRenewal.guard(() => this.saveRuntime(runtime, ownerToken));

        leaseRenewal.assertOwned();

        if (heartbeat.getTime() - runtime.startedAt.getTime() >= runtime.maxRuntimeMs) {
          return await leaseRenewal.guard(() =>
            this.finish(runtime, "escalated", "AUTONOMY_RUNTIME_BUDGET_EXCEEDED", ownerToken),
          );
        }

        if (runtime.cycleCount >= runtime.maxCycles) {
          return await leaseRenewal.guard(() =>
            this.finish(runtime, "escalated", "AUTONOMY_CYCLE_BUDGET_EXCEEDED", ownerToken),
          );
        }

        const mission = await leaseRenewal.guard(() => this.missions.findById(missionId));

        if (!mission) {
          throw new Error(`MISSION_NOT_FOUND:${missionId}`);
        }

        let tasks = await leaseRenewal.guard(() => this.missions.listTasks(missionId));

        if (runtime.state === "replanning") {
          if (runtime.replanCount >= runtime.maxReplans) {
            return await leaseRenewal.guard(() =>
              this.finish(runtime, "escalated", "AUTONOMY_REPLAN_BUDGET_EXCEEDED", ownerToken),
            );
          }

          const reason = runtime.lastReason?.includes("DEADLOCK") ? "deadlock" : "stagnation";
          const plan = await leaseRenewal.guard(() =>
            this.planner.plan({
              mission,
              tasks,
              reason,
              signal: leaseRenewal.signal,
            }),
          );

          await leaseRenewal.guard(() =>
            tasks.length === 0
              ? this.missions.applyPlan(missionId, plan)
              : this.replaceMissionPlan(missionId, plan),
          );
          tasks = await leaseRenewal.guard(() => this.missions.listTasks(missionId));

          const replannedAt = this.now();
          runtime = {
            ...runtime,
            state: "running",
            replanCount: runtime.replanCount + 1,
            stagnationCount: 0,
            updatedAt: replannedAt,
            lastHeartbeatAt: replannedAt,
            lastProgressAt: replannedAt,
            lastReason: `AUTONOMY_REPLAN_APPLIED:${reason}`,
          };
          await leaseRenewal.guard(() => this.saveRuntime(runtime, ownerToken));
        }

        /*
         * Initial autonomous planning.
         *
         * N2.7-5 introduces durable replan semantics for
         * missions which already contain a graph.
         */
        if (tasks.length === 0) {
          const plan = await leaseRenewal.guard(() =>
            this.planner.plan({
              mission,
              tasks,
              reason: "initial",
              signal: leaseRenewal.signal,
            }),
          );

          await leaseRenewal.guard(() => this.missions.applyPlan(missionId, plan));

          tasks = await leaseRenewal.guard(() => this.missions.listTasks(missionId));
        }

        const beforeFingerprint = fingerprintTasks(mission, tasks);

        if (TERMINAL_MISSION_STATES.has(mission.status)) {
          return await leaseRenewal.guard(() =>
            this.finish(
              {
                ...runtime,
                lastFingerprint: beforeFingerprint,
              },
              mission.status as AutonomousMissionRunnerState,
              `MISSION_TERMINAL:${mission.status}`,
              ownerToken,
            ),
          );
        }

        /*
         * Resume durable PREPARED dispatch attempts before
         * looking for new ready work.
         */
        await leaseRenewal.guard(() =>
          this.supervisor.reconcilePreparedDispatches(missionId, leaseRenewal.signal),
        );

        await leaseRenewal.guard(() => this.supervisor.run(missionId, leaseRenewal.signal));

        const afterMission = await leaseRenewal.guard(() => this.missions.findById(missionId));

        if (!afterMission) {
          throw new Error(`MISSION_NOT_FOUND_AFTER_RUN:${missionId}`);
        }

        const afterTasks = await leaseRenewal.guard(() => this.missions.listTasks(missionId));

        const afterFingerprint = fingerprintTasks(afterMission, afterTasks);

        const cycleNow = this.now();

        const madeProgress = afterFingerprint !== beforeFingerprint;

        runtime = {
          ...runtime,

          cycleCount: runtime.cycleCount + 1,

          stagnationCount: madeProgress ? 0 : runtime.stagnationCount + 1,

          updatedAt: cycleNow,

          lastHeartbeatAt: cycleNow,

          lastProgressAt: madeProgress ? cycleNow : runtime.lastProgressAt,

          lastFingerprint: afterFingerprint,

          lastReason: madeProgress ? "AUTONOMY_PROGRESS" : "AUTONOMY_NO_PROGRESS",
        };

        await leaseRenewal.guard(() => this.saveRuntime(runtime, ownerToken));

        if (TERMINAL_MISSION_STATES.has(afterMission.status)) {
          return await leaseRenewal.guard(() =>
            this.finish(
              runtime,
              afterMission.status as AutonomousMissionRunnerState,
              `MISSION_TERMINAL:${afterMission.status}`,
              ownerToken,
            ),
          );
        }

        /*
         * A queued/running/approval task means external work
         * is genuinely pending.
         *
         * Persist waiting so a later fresh runner can resume.
         *
         * Waiting does not count as stagnation.
         */
        if (hasActiveWork(afterTasks)) {
          runtime = {
            ...runtime,

            state: "waiting",
            stagnationCount: 0,

            updatedAt: this.now(),

            lastReason: "AUTONOMY_EXTERNAL_WORK_PENDING",
          };

          await leaseRenewal.guard(() => this.saveRuntime(runtime, ownerToken));

          return this.result(runtime, "waiting", "AUTONOMY_EXTERNAL_WORK_PENDING");
        }

        const ready = readyDraftTasks(afterTasks);

        /*
         * Non-terminal + remaining draft work + no active
         * work + nothing ready => deterministic DAG deadlock.
         *
         * Runtime persists this as escalated because
         * "deadlock" is a diagnostic outcome, not currently
         * a durable runtime state.
         */
        if (hasDraftTasks(afterTasks) && ready.length === 0) {
          await leaseRenewal.guard(() =>
            this.persistTerminalRuntime(runtime, "escalated", "AUTONOMY_DAG_DEADLOCK", ownerToken),
          );

          return this.result(runtime, "deadlock", "AUTONOMY_DAG_DEADLOCK");
        }

        if (runtime.stagnationCount >= runtime.maxStagnationCycles) {
          return await leaseRenewal.guard(() =>
            this.finish(runtime, "escalated", "AUTONOMY_STAGNATION_LIMIT", ownerToken),
          );
        }

        /*
         * Ready drafts exist and there is no asynchronous
         * external work. Continue immediately.
         *
         * cycleCount and heartbeat are already durable.
         */
      }
    } finally {
      let leaseStopError: unknown;

      try {
        await leaseRenewal.stop();
      } catch (error) {
        leaseStopError = error;
      }

      try {
        if (this.runtimeRepository && ownerToken) {
          await this.runtimeRepository.release(missionId, ownerToken);
        }
      } catch (releaseError) {
        if (leaseStopError === undefined) {
          throw releaseError;
        }
      }

      if (leaseStopError !== undefined) {
        throw leaseStopError;
      }
    }
  }

  private startLeaseRenewal(
    missionId: string,
    ownerToken: string | null,
    leaseMs: number,
    renewalTimeoutMs: number,
  ): LeaseRenewalGuard {
    if (!this.runtimeRepository || !ownerToken) {
      return {
        signal: undefined,
        assertOwned: () => undefined,
        guard: (operation) => operation(),
        stop: async () => undefined,
      };
    }

    const intervalMs = Math.max(1, Math.floor(leaseMs / 3));

    const renewalTimer = this.options.leaseRenewalTimer ?? SYSTEM_LEASE_RENEWAL_TIMER;

    let stopped = false;

    let renewalScheduled: unknown;

    let renewalPromise: Promise<void> | null = null;

    let ownershipError: Error | null = null;

    const controller = new AbortController();

    let rejectOwnershipLost: (error: Error) => void = () => undefined;

    const ownershipLost = new Promise<never>((_resolve, reject) => {
      rejectOwnershipLost = reject;
    });

    ownershipLost.catch(() => undefined);

    const loseOwnership = (cause?: unknown) => {
      if (ownershipError) {
        return;
      }

      ownershipError = new Error(OWNERSHIP_LOST_REASON, {
        cause,
      });

      controller.abort(ownershipError);

      rejectOwnershipLost(ownershipError);
    };

    const renew = () => {
      if (stopped) {
        return;
      }

      let timeout: unknown;

      const renewalTimedOut = new Promise<never>((_resolve, reject) => {
        timeout = renewalTimer.setTimeout(() => {
          reject(new Error("AUTONOMOUS_RUNTIME_RENEWAL_TIMEOUT"));
        }, renewalTimeoutMs);
      });

      renewalPromise = Promise.race([
        this.runtimeRepository!.renewClaim(missionId, ownerToken, leaseMs),
        renewalTimedOut,
      ])
        .then((renewed) => {
          if (!renewed) {
            loseOwnership(new Error("AUTONOMOUS_RUNTIME_RENEWAL_REJECTED"));
          }
        })
        .catch((error: unknown) => {
          loseOwnership(error);
        })
        .finally(() => {
          if (timeout !== undefined) {
            renewalTimer.clearTimeout(timeout);
          }

          renewalPromise = null;

          if (!stopped && !ownershipError) {
            renewalScheduled = renewalTimer.setTimeout(renew, intervalMs);
          }
        });
    };

    renewalScheduled = renewalTimer.setTimeout(renew, intervalMs);

    const assertOwned = () => {
      if (ownershipError) {
        throw ownershipError;
      }
    };

    return {
      signal: controller.signal,
      assertOwned,

      guard: async <T>(operation: () => Promise<T>): Promise<T> => {
        assertOwned();

        return Promise.race([operation(), ownershipLost]);
      },

      stop: async () => {
        stopped = true;

        if (renewalScheduled !== undefined) {
          renewalTimer.clearTimeout(renewalScheduled);
        }

        if (renewalPromise) {
          await renewalPromise;
        }

        assertOwned();
      },
    };
  }

  private resolveLeaseRenewalTimeoutMs(leaseMs: number): number {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new Error("AUTONOMOUS_RUNTIME_INVALID_LEASE");
    }

    const configuredTimeoutMs =
      this.options.leaseRenewalTimeoutMs ?? DEFAULT_LEASE_RENEWAL_TIMEOUT_MS;

    if (!Number.isFinite(configuredTimeoutMs) || configuredTimeoutMs <= 0) {
      throw new Error("AUTONOMOUS_RUNTIME_INVALID_RENEWAL_TIMEOUT");
    }

    const intervalMs = Math.max(1, Math.floor(leaseMs / 3));

    return Math.max(1, Math.min(intervalMs, Math.floor(configuredTimeoutMs)));
  }

  private replaceMissionPlan(missionId: string, plan: MissionPlan): Promise<MissionTask[]> {
    if (!this.missions.replacePlan) {
      throw new Error("AUTONOMY_REPLAN_REPLACEMENT_UNSUPPORTED");
    }
    return this.missions.replacePlan(missionId, plan);
  }

  private async loadOrCreateRuntime(missionId: string): Promise<AutonomousMissionRuntime> {
    if (this.runtimeRepository) {
      const existing = await this.runtimeRepository.get(missionId);

      if (existing) {
        return existing;
      }
    }

    const now = this.now();

    const runtime: AutonomousMissionRuntime = {
      missionId,
      state: "running",
      startedAt: now,
      updatedAt: now,
      lastHeartbeatAt: now,
      lastProgressAt: now,
      cycleCount: 0,
      replanCount: 0,
      stagnationCount: 0,
      maxCycles: this.options.maxCycles,
      maxReplans: this.options.maxReplans ?? 5,
      maxRuntimeMs: this.options.maxRuntimeMs,
      maxStagnationCycles: this.options.maxStagnationCycles,
      lastReason: "AUTONOMY_STARTED",
      ownerToken: null,
      leaseUntil: null,
    };

    if (this.runtimeRepository) {
      const created = await this.runtimeRepository.createIfAbsent(runtime);

      if (!created) {
        const existing = await this.runtimeRepository.get(missionId);

        if (!existing) {
          throw new Error(`AUTONOMOUS_RUNTIME_BOOTSTRAP_RACE:${missionId}`);
        }

        return existing;
      }
    }

    return runtime;
  }

  private async saveRuntime(
    runtime: AutonomousMissionRuntime,
    ownerToken: string | null = null,
  ): Promise<void> {
    if (!this.runtimeRepository) {
      return;
    }

    if (ownerToken) {
      await this.runtimeRepository.saveOwned(runtime, ownerToken);

      return;
    }

    await this.runtimeRepository.save(runtime);
  }

  private async persistTerminalRuntime(
    runtime: AutonomousMissionRuntime,
    state: AutonomousMissionRuntime["state"],
    reason: string,
    ownerToken: string | null = null,
  ): Promise<void> {
    if (!this.runtimeRepository) {
      return;
    }

    const now = this.now();

    await this.saveRuntime(
      {
        ...runtime,

        state,

        updatedAt: now,
        lastHeartbeatAt: now,
        lastReason: reason,
      },
      ownerToken,
    );
  }

  private async finish(
    runtime: AutonomousMissionRuntime,
    state: AutonomousMissionRunnerState,
    reason: string,
    ownerToken: string | null = null,
  ): Promise<AutonomousMissionRunnerResult> {
    const durableState: AutonomousMissionRuntime["state"] =
      state === "deadlock" ? "escalated" : state;

    await this.persistTerminalRuntime(runtime, durableState, reason, ownerToken);

    return this.result(runtime, state, reason);
  }

  private result(
    runtime: AutonomousMissionRuntime,
    state: AutonomousMissionRunnerState,
    reason: string,
  ): AutonomousMissionRunnerResult {
    return {
      missionId: runtime.missionId,
      state,
      cycleCount: runtime.cycleCount,
      stagnationCount: runtime.stagnationCount,
      startedAt: runtime.startedAt,
      finishedAt: this.now(),
      lastFingerprint: runtime.lastFingerprint ?? "",
      reason,
    };
  }
}
