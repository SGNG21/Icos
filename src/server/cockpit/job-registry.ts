import { createHash, randomUUID } from "node:crypto";

export const COCKPIT_JOB_CAPACITY = 100;
export const COCKPIT_TERMINAL_TTL_MS = 60 * 60 * 1_000;
export const COCKPIT_MAX_TEXT_LENGTH = 512;
export const COCKPIT_MAX_OBJECTIVE_LENGTH = 2_000;
export const COCKPIT_MAX_ITEMS = 100;

export type CockpitJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "BLOCKED";

export interface CockpitTaskProjection {
  taskId: string;
  label: string;
  status: CockpitJobStatus;
}

export interface CockpitJobFailure {
  code: string;
  message: string;
}

export interface CockpitJobProjection {
  jobId: string;
  missionId?: string;
  objective: string;
  status: CockpitJobStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  missionState?: string;
  planLabel?: string;
  tasks: CockpitTaskProjection[];
  workers: string[];
  blockers: string[];
  evidence: string[];
  sanitizedError?: CockpitJobFailure;
  finalResult?: string;
  mergePerformed: boolean;
  productionDeploymentPerformed: false;
}

export interface CreateCockpitJobInput {
  tenantId: string;
  idempotencyKey: string;
  objective: string;
  requester: {
    kind: "human";
    id: string;
  };
}

export interface CockpitRuntime {
  submitJob(input: CreateCockpitJobInput): Promise<CockpitJobProjection>;
  getJob(tenantId: string, jobId: string): CockpitJobProjection | null;
}

export interface CockpitJobRecord {
  readonly jobId: string;
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly objective: string;
  readonly requester: CreateCockpitJobInput["requester"];
  status: CockpitJobStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  missionId?: string;
  missionState?: string;
  planLabel?: string;
  tasks: CockpitTaskProjection[];
  workers: string[];
  blockers: string[];
  evidence: string[];
  sanitizedError?: CockpitJobFailure;
  finalResult?: string;
  mergePerformed: boolean;
}

export type CockpitJobUpdate = Partial<
  Pick<
    CockpitJobRecord,
    | "missionId"
    | "missionState"
    | "planLabel"
    | "tasks"
    | "workers"
    | "blockers"
    | "evidence"
    | "sanitizedError"
    | "finalResult"
    | "mergePerformed"
  >
>;

export class CockpitJobConflictError extends Error {
  constructor() {
    super("The idempotency key is already associated with a different objective.");
    this.name = "CockpitJobConflictError";
  }
}

export class CockpitJobCapacityError extends Error {
  constructor() {
    super("The process-local Cockpit job registry is at active-job capacity.");
    this.name = "CockpitJobCapacityError";
  }
}

export interface CockpitJobRegistryOptions {
  clock?: () => Date;
  createId?: () => string;
  capacity?: number;
  terminalTtlMs?: number;
}

const TERMINAL_STATUSES = new Set<CockpitJobStatus>(["SUCCEEDED", "FAILED", "BLOCKED"]);

function boundedText(value: string, maximum = COCKPIT_MAX_TEXT_LENGTH): string {
  return value.slice(0, maximum);
}

function boundedItems(values: readonly string[]): string[] {
  return values.slice(0, COCKPIT_MAX_ITEMS).map((value) => boundedText(value));
}

function boundedTasks(values: readonly CockpitTaskProjection[]): CockpitTaskProjection[] {
  return values.slice(0, COCKPIT_MAX_ITEMS).map((task) => ({
    taskId: boundedText(task.taskId, 128),
    label: boundedText(task.label),
    status: task.status,
  }));
}

function cloneRecord(record: CockpitJobRecord): CockpitJobRecord {
  return structuredClone(record);
}

/**
 * Volatile registry scoped to the current Node.js process. It provides no
 * persistence or cross-instance consistency guarantee.
 */
export class CockpitJobRegistry {
  private readonly records = new Map<string, CockpitJobRecord>();
  private readonly idempotency = new Map<string, string>();
  private readonly objectiveFingerprints = new Map<string, string>();
  private readonly clock: () => Date;
  private readonly createId: () => string;
  private readonly capacity: number;
  private readonly terminalTtlMs: number;

  constructor(options: CockpitJobRegistryOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.createId = options.createId ?? (() => `cockpit-job-${randomUUID()}`);
    this.capacity = Math.min(
      COCKPIT_JOB_CAPACITY,
      Math.max(1, options.capacity ?? COCKPIT_JOB_CAPACITY),
    );
    this.terminalTtlMs = options.terminalTtlMs ?? COCKPIT_TERMINAL_TTL_MS;
  }

  createOrGet(input: CreateCockpitJobInput): { record: CockpitJobRecord; created: boolean } {
    this.purgeExpiredTerminalJobs();
    const idempotencyId = this.idempotencyId(input.tenantId, input.idempotencyKey);
    const existingId = this.idempotency.get(idempotencyId);
    if (existingId) {
      const existing = this.records.get(existingId);
      if (existing) {
        if (this.objectiveFingerprints.get(existingId) !== this.fingerprint(input.objective)) {
          throw new CockpitJobConflictError();
        }
        return { record: cloneRecord(existing), created: false };
      }
      this.idempotency.delete(idempotencyId);
    }

    this.makeCapacity();
    const now = this.clock().toISOString();
    const record: CockpitJobRecord = {
      jobId: this.createId(),
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
      objective: boundedText(input.objective, COCKPIT_MAX_OBJECTIVE_LENGTH),
      requester: { ...input.requester },
      status: "QUEUED",
      createdAt: now,
      updatedAt: now,
      tasks: [],
      workers: [],
      blockers: [],
      evidence: [],
      mergePerformed: false,
    };
    this.records.set(record.jobId, record);
    this.idempotency.set(idempotencyId, record.jobId);
    this.objectiveFingerprints.set(record.jobId, this.fingerprint(input.objective));
    return { record: cloneRecord(record), created: true };
  }

  get(tenantId: string, jobId: string): CockpitJobRecord | null {
    this.purgeExpiredTerminalJobs();
    const record = this.records.get(jobId);
    return record?.tenantId === tenantId ? cloneRecord(record) : null;
  }

  markRunning(tenantId: string, jobId: string, update: CockpitJobUpdate = {}): CockpitJobRecord {
    return this.transition(tenantId, jobId, "RUNNING", update);
  }

  markSucceeded(tenantId: string, jobId: string, update: CockpitJobUpdate = {}): CockpitJobRecord {
    return this.transition(tenantId, jobId, "SUCCEEDED", update);
  }

  markFailed(
    tenantId: string,
    jobId: string,
    failure: CockpitJobFailure,
    update: CockpitJobUpdate = {},
  ): CockpitJobRecord {
    return this.transition(tenantId, jobId, "FAILED", {
      ...update,
      sanitizedError: {
        code: boundedText(failure.code, 64),
        message: boundedText(failure.message),
      },
    });
  }

  markBlocked(tenantId: string, jobId: string, update: CockpitJobUpdate = {}): CockpitJobRecord {
    return this.transition(tenantId, jobId, "BLOCKED", update);
  }

  private transition(
    tenantId: string,
    jobId: string,
    status: CockpitJobStatus,
    update: CockpitJobUpdate,
  ): CockpitJobRecord {
    const record = this.records.get(jobId);
    if (!record || record.tenantId !== tenantId) {
      throw new Error("Cockpit job not found.");
    }
    if (TERMINAL_STATUSES.has(record.status)) {
      throw new Error("Cockpit job is already terminal.");
    }
    const transitionAllowed =
      (record.status === "QUEUED" &&
        (status === "RUNNING" || status === "FAILED" || status === "BLOCKED")) ||
      (record.status === "RUNNING" &&
        (status === "SUCCEEDED" || status === "FAILED" || status === "BLOCKED"));
    if (!transitionAllowed) {
      throw new Error(`Invalid Cockpit job transition: ${record.status} -> ${status}.`);
    }
    const now = this.clock().toISOString();
    Object.assign(record, this.sanitizeUpdate(update), {
      status,
      updatedAt: now,
      completedAt: TERMINAL_STATUSES.has(status) ? now : undefined,
    });
    return cloneRecord(record);
  }

  private sanitizeUpdate(update: CockpitJobUpdate): CockpitJobUpdate {
    return {
      ...(update.missionId === undefined
        ? {}
        : { missionId: boundedText(update.missionId, 128) }),
      ...(update.missionState === undefined
        ? {}
        : { missionState: boundedText(update.missionState, 64) }),
      ...(update.planLabel === undefined ? {} : { planLabel: boundedText(update.planLabel) }),
      ...(update.tasks === undefined ? {} : { tasks: boundedTasks(update.tasks) }),
      ...(update.workers === undefined ? {} : { workers: boundedItems(update.workers) }),
      ...(update.blockers === undefined ? {} : { blockers: boundedItems(update.blockers) }),
      ...(update.evidence === undefined ? {} : { evidence: boundedItems(update.evidence) }),
      ...(update.finalResult === undefined
        ? {}
        : { finalResult: boundedText(update.finalResult) }),
      ...(update.sanitizedError === undefined
        ? {}
        : {
            sanitizedError: {
              code: boundedText(update.sanitizedError.code, 64),
              message: boundedText(update.sanitizedError.message),
            },
          }),
      mergePerformed: update.mergePerformed === true,
    };
  }

  private purgeExpiredTerminalJobs(): void {
    const cutoff = this.clock().getTime() - this.terminalTtlMs;
    for (const record of this.records.values()) {
      if (
        TERMINAL_STATUSES.has(record.status) &&
        record.completedAt !== undefined &&
        Date.parse(record.completedAt) <= cutoff
      ) {
        this.deleteRecord(record);
      }
    }
  }

  private makeCapacity(): void {
    if (this.records.size < this.capacity) return;
    const terminal = [...this.records.values()]
      .filter((record) => TERMINAL_STATUSES.has(record.status))
      .sort(
        (left, right) =>
          Date.parse(left.completedAt ?? left.updatedAt) -
          Date.parse(right.completedAt ?? right.updatedAt),
      );
    for (const record of terminal) {
      if (this.records.size < this.capacity) break;
      this.deleteRecord(record);
    }
    if (this.records.size >= this.capacity) {
      throw new CockpitJobCapacityError();
    }
  }

  private deleteRecord(record: CockpitJobRecord): void {
    this.records.delete(record.jobId);
    this.objectiveFingerprints.delete(record.jobId);
    this.idempotency.delete(this.idempotencyId(record.tenantId, record.idempotencyKey));
  }

  private idempotencyId(tenantId: string, idempotencyKey: string): string {
    return `${tenantId.length}:${tenantId}:${idempotencyKey}`;
  }

  private fingerprint(objective: string): string {
    return createHash("sha256").update(objective).digest("hex");
  }
}
