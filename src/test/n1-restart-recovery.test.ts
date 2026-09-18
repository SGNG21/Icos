import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { recordMissionTaskExecution } from '@/server/usecases/record-mission-task-execution';

import { SupervisorService } from '@/server/supervisor/supervisor-service';

import type { MissionRepository } from "@/server/mission/ports";

import type { TaskRepository } from "@/server/repositories/ports";

import type { DurableMemory } from "@/core/context/durable-memory";

import type { TaskExecutionDispatcher } from "@/server/execution/ports";

import type { TaskExecutionResultRepository } from "@/server/repositories/ports";

import type { ReviewDecisionRepository } from "@/server/review/ports";

import type { ReviewerService } from "@/server/review/ports";

import type { Mission, MissionTask } from '@/core/mission/contracts';

import type { Task } from '@/core/contracts';

import type { CreateTaskInput, CreateTaskResult } from "@/server/repositories/ports";

import type { TransitionTaskResult } from "@/server/repositories/ports";

import type { ReviewInput } from "@/server/review/ports";

import type { MissionStatus } from "@/core/mission/contracts";

import type { TaskStatus } from "@/core/contracts";



// Mock implementations that match the interfaces
class MockMissionRepository implements MissionRepository {

  async applyPlan(
    _missionId: string,
    _plan: import("@/server/mission/mission-plan").MissionPlan,
  ): Promise<
    import("@/core/mission/contracts").MissionTask[]
  > {
    return [];
  }

  private missions = new Map<string, Mission>();
  private missionTasks = new Map<string, MissionTask>();
  private canonicalTaskIdToMissionTaskId = new Map<string, string>();

  async create(input: {
    title: string;
    objective: string;
    tasks: Omit<MissionTask, "id" | "missionId" | "status" | "taskId">[];
  }): Promise<Mission> {
    const timestamp = Date.now();
    const missionId = `mission-${timestamp}`;
    const mission: Mission = {
      id: missionId,
      title: input.title,
      objective: input.objective,
      status: "draft",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.missions.set(missionId, mission);
    input.tasks.forEach((taskInput, index) => {
      const missionTaskId = `missionTask-${timestamp}-${index}`;
      const canonicalTaskId = `canonical-task-${timestamp}-${index}`;
      const missionTask: MissionTask = {
        id: missionTaskId,
        missionId: missionId,
        taskId: canonicalTaskId,
        title: taskInput.title,
        dependsOn: [],
        status: "draft",
        workerKind: taskInput.workerKind,
        capability: taskInput.capability,
        description: taskInput.description,
      };
      this.missionTasks.set(missionTaskId, missionTask);
      this.canonicalTaskIdToMissionTaskId.set(canonicalTaskId, missionTaskId);
    });
    return mission;
  }

  async findById(id: string) {
    return this.missions.get(id) ?? null;
  }

  async list(filter?: { status?: Mission["status"] }) {
    const missions = Array.from(this.missions.values());
    if (filter?.status) {
      return missions.filter(m => m.status === filter.status);
    }
    return missions;
  }

  async listTasks(missionId: string) {
    const missionTasks: MissionTask[] = [];
    for (const [id, task] of this.missionTasks.entries()) {
      if (task.missionId === missionId) {
        missionTasks.push(task);
      }
    }
    return missionTasks;
  }

  async getMissionIdByTaskId(taskId: string): Promise<string | null> {
    const missionTaskId = this.canonicalTaskIdToMissionTaskId.get(taskId);
    if (!missionTaskId) return null;
    const task = this.missionTasks.get(missionTaskId);
    if (!task) return null;
    return task.missionId;
  }

  async getMissionTaskById(taskId: string): Promise<MissionTask | null> {
    // Note: the interface expects taskId to be the missionTaskId? Actually the method is getMissionTaskById(taskId: string)
    // and the MissionTask has an id field. We'll assume the argument is the missionTaskId.
    return this.missionTasks.get(taskId) ?? null;
  }

  async getMissionTaskByCanonicalTaskId(taskId: string): Promise<MissionTask | null> {
    const missionTaskId = this.canonicalTaskIdToMissionTaskId.get(taskId);
    if (!missionTaskId) return null;
    return this.missionTasks.get(missionTaskId) ?? null;
  }

  async updateMissionTaskStatus(
    missionId: string,
    taskId: string,
    status: MissionTask["status"]
  ): Promise<void> {
    const missionTaskId = this.missionTasks.has(taskId)
      ? taskId
      : this.canonicalTaskIdToMissionTaskId.get(taskId);

    if (!missionTaskId) return;

    const task = this.missionTasks.get(missionTaskId);

    if (task && task.missionId === missionId) {
      task.status = status;
    }
  }

  async updateMissionStatus(missionId: string, status: Mission["status"]): Promise<void> {
    const mission = this.missions.get(missionId);
    if (mission) {
      mission.status = status;
    }
  }

  async deleteMission(missionId: string): Promise<void> {
    this.missions.delete(missionId);
    for (const [id, task] of this.missionTasks.entries()) {
      if (task.missionId === missionId) {
        this.missionTasks.delete(id);
        this.canonicalTaskIdToMissionTaskId.delete(task.taskId);
      }
    }
  }

  async updateMission(missionId: string, mission: Mission): Promise<void> {
    this.missions.set(missionId, mission);
  }

  async updateMissionTaskDependsOn(taskId: string, dependsOn: string[]): Promise<void> {
    const missionTaskId = this.missionTasks.has(taskId)
      ? taskId
      : this.canonicalTaskIdToMissionTaskId.get(taskId);

    if (!missionTaskId) return;

    const task = this.missionTasks.get(missionTaskId);

    if (task) {
      task.dependsOn = dependsOn;
    }
  }
}

class MockTaskRepository implements TaskRepository {
  private tasks = new Map<string, Task>();

  seed(task: Task): void {
    this.tasks.set(task.id, task);
  }

  async list() {
    return Array.from(this.tasks.values());
  }

  async listForScope(scope: any) {
    return Array.from(this.tasks.values());
  }


  async getById(id: string) {
    return this.tasks.get(id) ?? null;
  }

  async getByIdForScope(id: string, scope: any) {
    return this.tasks.get(id) ?? null;
  }

  async create(input: CreateTaskInput): Promise<CreateTaskResult> {
    const task = { id: `task-${Date.now()}`, ...input } as Task;
    this.tasks.set(task.id, task);
    return { ok: true, task };
  }

  async transition(taskId: string, to: TaskStatus): Promise<TransitionTaskResult> {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = to;
    }
    // Return a successful transition result (assuming TransitionResult has an ok: true case)
    return { ok: true } as TransitionTaskResult;
  }
}

class MockDurableMemory implements DurableMemory {
  private checkpoints: Map<string, any> = new Map();
  private decisions: Map<string, any> = new Map();
  private executionResults: Map<string, any> = new Map();
  // For loadCheckpoint, we'll return the first checkpoint for the mission if any
  async loadCheckpoint(missionId: string): Promise<any | null> {
    const checkpoints = await this.getCheckpoints(missionId);
    return checkpoints[0] || null;
   }
  private patterns: Map<string, any> = new Map();
  private contextItems: Map<string, any> = new Map();
  private handoffPackages: Map<string, any> = new Map();

  // Checkpoints
  async saveCheckpoint(checkpoint: any): Promise<void> {
    this.checkpoints.set(checkpoint.id, checkpoint);
  }

  async getCheckpoints(missionId: string): Promise<any[]> {
    return Array.from(this.checkpoints.values())
      .filter((c) => c.missionId === missionId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async getLatestCheckpoint(missionId: string): Promise<any | null> {
    const checkpoints = await this.getCheckpoints(missionId);
    return checkpoints[0] || null;
  }

  async getCheckpointById(id: string): Promise<any | null> {
    return this.checkpoints.get(id) || null;
  }

  // Decisions
  async saveDecision(decision: any): Promise<void> {
    this.decisions.set(decision.id, decision);
  }

  async getDecisions(query: {
    missionId?: string;
    taskId?: string;
    limit?: number;
  }): Promise<any[]> {
    let results = Array.from(this.decisions.values());
    if (query.missionId) {
      results = results.filter((d) => d.missionId === query.missionId);
    }
    if (query.taskId) {
      results = results.filter((d) => d.taskId === query.taskId);
    }
    results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    if (query.limit) {
      results = results.slice(0, query.limit);
    }
    return results;
  }

  // Execution Results
  async saveExecutionResult(result: any): Promise<void> {
    this.executionResults.set(result.id, result);
  }

  async getExecutionResults(query: {
    missionId?: string;
    taskId?: string;
    workflowId?: string;
    limit?: number;
  }): Promise<any[]> {
    let results = Array.from(this.executionResults.values());
    if (query.missionId) {
      // We'd need to filter by missionId, but TaskExecutionResult doesn't have it directly
      // This would require a join or storing missionId in the result
      // For now, we'll just return all and let the caller filter? But we don't have missionId.
      // We'll skip this filter for the mock.
    }
    if (query.taskId) {
      results = results.filter((r) => r.taskId === query.taskId);
    }
    if (query.workflowId) {
      results = results.filter((r) => r.workflowId === query.workflowId);
    }
    results.sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime());
    if (query.limit) {
      results = results.slice(0, query.limit);
    }
    return results;
  }

  // Patterns
  async savePattern(pattern: any): Promise<void> {
    const existing = this.patterns.get(pattern.id);
    if (existing) {
      // Update existing pattern
      pattern.occurrenceCount = existing.occurrenceCount + 1;
      pattern.lastSeenAt = new Date().toISOString();
    }
    this.patterns.set(pattern.id, pattern);
  }

  async getPatterns(query: {
    capability?: string;
    workerKind?: string;
    outcome?: string;
    limit?: number;
  }): Promise<any[]> {
    let results = Array.from(this.patterns.values());
    if (query.capability) {
      results = results.filter((p) => p.signature.capability === query.capability);
    }
    if (query.workerKind) {
      results = results.filter((p) => p.signature.workerKind === query.workerKind);
    }
    if (query.outcome) {
      results = results.filter((p) => p.outcome === query.outcome);
    }
    results.sort((a, b) => b.confidence - a.confidence);
    if (query.limit) {
      results = results.slice(0, query.limit);
    }
    return results;
  }

  // Context Items
  async saveContextItem(item: any): Promise<void> {
    this.contextItems.set(item.id, item);
  }

  async queryContextItems(query: any): Promise<any[]> {
    // Simplified: return all context items
    return Array.from(this.contextItems.values());
  }

  // Handoff
  async saveHandoffPackage(pkg: any): Promise<void> {
    this.handoffPackages.set(pkg.id, pkg);
  }

  async getHandoffPackage(id: string): Promise<any | null> {
    return this.handoffPackages.get(id) || null;
  }

  // Maintenance
  async cleanup(olderThanDays: number = 90): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    let deleted = 0;
    for (const [id, checkpoint] of this.checkpoints) {
      if (new Date(checkpoint.createdAt) < cutoff) {
        this.checkpoints.delete(id);
        deleted++;
      }
    }
    return deleted;
  }
}

class MockTaskExecutionDispatcher implements TaskExecutionDispatcher {
  dispatch: any;
  constructor() {
    this.dispatch = async (input: any) => {
      // Return a mock TaskExecutionResult
      return {
        id: `execution-${Date.now()}`,
        taskId: input.taskId,
        workflowId: `workflow-${Date.now()}`,
        outcome: 'success',
        result: 'success',
        completedAt: new Date().toISOString(),
      };
    };
  }
}

// We'll change the class to store dispatched inputs for testing
class MockTaskExecutionDispatcherWithLog implements TaskExecutionDispatcher {
  dispatch: any;
  dispatched: any[] = [];
  constructor() {
    this.dispatch = async (input: any) => {
      this.dispatched.push(input);
      // Return a mock TaskExecutionResult
      return {
        id: `execution-${Date.now()}`,
        taskId: input.taskId,
        workflowId: `workflow-${Date.now()}`,
        outcome: 'success',
        result: 'success',
        completedAt: new Date().toISOString(),
      };
    };
  }
}

class MockTaskExecutionResultRepository implements TaskExecutionResultRepository {
  private results: Map<string, any> = new Map();

  async getByTaskId(taskId: string): Promise<any> {
    return this.results.get(taskId) ?? null;
  }

  async getByWorkflowId(workflowId: string): Promise<any> {
    // For simplicity, we'll search by value (not efficient but okay for tests)
    for (const [_, result] of this.results.entries()) {
      if (result && result.workflowId === workflowId) {
        return result;
      }
    }
    return null;
  }

  async listByTaskIds(taskIds: string[]): Promise<any[]> {
    const list: any[] = [];
    for (const taskId of taskIds) {
      const result = this.results.get(taskId);
      if (result) {
        list.push(result);
      }
    }
    return list;
  }

  async record(input: any): Promise<any> {
    // Just store the input and return it
    this.results.set(input.taskId, input);
    return input;
  }
}

class MockReviewerService implements ReviewerService {
  async review(input: any): Promise<any> {
    // Return a mock review result
    return {
      id: `review-${Date.now()}`,
      taskId: input.task.id,
      workflowId: input.workflowId,
      missionId: input.mission.id,
      decision: {
        id: `decision-${Date.now()}`,
        taskId: input.task.id,
        workflowId: input.workflowId,
        missionId: input.mission.id,
        decision: "APPROVE",
        reviewerKind: "deterministic",
        severity: "info",
        createdAt: new Date(),
        humanOverridden: false,
        reasons: [],
        overriddenBy: undefined,
      },
    };
  }
}

class MockReviewDecisionRepository implements ReviewDecisionRepository {
  private decisions: Map<string, any[]> = new Map();

  async save(decision: any): Promise<any> {
    // Store the decision by taskId so that listByTaskId can retrieve it
    if (!this.decisions.has(decision.taskId)) {
      this.decisions.set(decision.taskId, []);
    }
  this.decisions.get(decision.taskId)!.push(decision);
    return decision;
  }

  async addReviewDecision(taskId: string, outcome: string, reasons: string[]): Promise<void> {
    const decision = { taskId, outcome, reasons };
    await this.save(decision);
  }

  async getById(id: string): Promise<any> {
    // We don't store by id, so return null for simplicity
    return null;
  }

  async getByWorkflowId(workflowId: string): Promise<any> {
    for (const decisions of this.decisions.values()) {
      const match = decisions.find(
        (decision) => decision.workflowId === workflowId,
      );

      if (match) return match;
    }

    return null;
  }

  async listByTaskId(taskId: string): Promise<any[]> {
    return this.decisions.get(taskId) || [];
  }

  async listByMissionId(missionId: string): Promise<any[]> {
    // We don't store by missionId, so return empty array
    return [];
  }

  async list(): Promise<any[]> {
    // Flatten all decisions
    const all: any[] = [];
    for (const list of this.decisions.values()) {
      all.push(...list);
    }
    return all;
  }
}

describe('SupervisorService - CORRECTION RESTART', () => {

  let missionRepository: MockMissionRepository;

  let taskRepository: MockTaskRepository;

  let durableMemory: MockDurableMemory;

  let reviewerService: MockReviewerService;

  let taskDispatcher: MockTaskExecutionDispatcherWithLog;

  let executionResultRepo: MockTaskExecutionResultRepository;

  let reviewDecisionRepo: MockReviewDecisionRepository;



  beforeEach(() => {

    missionRepository = new MockMissionRepository();

    taskRepository = new MockTaskRepository();

    durableMemory = new MockDurableMemory();

    reviewerService = new MockReviewerService();

    taskDispatcher = new MockTaskExecutionDispatcherWithLog();

    executionResultRepo = new MockTaskExecutionResultRepository();

    reviewDecisionRepo = new MockReviewDecisionRepository();

  });



  afterEach(() => {

    vi.restoreAllMocks();

  });



  it('should reconstruct correction workflowId after restart and prevent double execution', async () => {
    const mission = await missionRepository.create({
      title: 'Test Mission',
      objective: 'Test',
      tasks: [{
        title: 'Test Task',
        description: 'Test Description',
        workerKind: 'test-worker',
        capability: 'test-capability',
        dependsOn: [],
      }],
    });

    const missionTasks = await missionRepository.listTasks(mission.id);
    const task = missionTasks[0];

    if (!task?.taskId) {
      throw new Error('Expected task.taskId to be defined');
    }

    const canonicalTaskId = task.taskId;
    const initialWorkflowId = `icos-task-${canonicalTaskId}`;
    const correctionWorkflowId =
      `icos-task-${canonicalTaskId}-correction-1`;

    // MissionTask.id and canonical Task.id are distinct.
    taskRepository.seed({
      id: canonicalTaskId,
      title: task.title,
      description: task.description,
      status: 'running',
    } as Task);

    // The execution result must exist before mission-level review.
    await executionResultRepo.record({
      id: `execution-${canonicalTaskId}`,
      taskId: canonicalTaskId,
      workflowId: initialWorkflowId,
      outcome: 'success',
      result: 'initial result',
      completedAt: new Date().toISOString(),
      recordedAt: new Date().toISOString(),
    });

    vi.spyOn(reviewerService, 'review').mockResolvedValue({
      id: `review-${canonicalTaskId}`,
      missionId: mission.id,
      taskId: canonicalTaskId,
      workflowId: initialWorkflowId,
      decision: 'REQUEST_CHANGES',
      reviewerKind: 'deterministic',
      severity: 'warning',
      createdAt: new Date(),
      humanOverridden: false,
      reasons: ['needs change'],
      requestedChanges: ['needs change'],
    } as any);

    const processA = new SupervisorService(
      missionRepository,
      taskRepository,
      taskDispatcher,
      durableMemory,
    );

    await recordMissionTaskExecution(
      {
        missions: missionRepository,
        tasks: taskRepository,
        reviewer: reviewerService,
        reviewDecisions: reviewDecisionRepo,
        executionResults: executionResultRepo,
        supervisor: processA,
        durableMemory,
        taskExecution: taskDispatcher,
      },
      {
        missionId: mission.id,
        taskId: canonicalTaskId,
        workflowId: initialWorkflowId,
        outcome: 'success',
        result: 'initial result',
        completedAt: new Date().toISOString(),
      },
    );

    const checkpoint =
      await durableMemory.loadCheckpoint(mission.id);

    expect(checkpoint).toBeTruthy();

    expect(
      taskDispatcher.dispatched.filter(
        (dispatch) =>
          dispatch.workflowId === correctionWorkflowId,
      ),
    ).toHaveLength(1);

    // Fresh Supervisor = logical restart, same durable repositories.
    const processB = new SupervisorService(
      missionRepository,
      taskRepository,
      taskDispatcher,
      durableMemory,
    );

    // Replay the original callback. The persisted review must make this
    // idempotent: correction-1 must not be dispatched twice.
    await recordMissionTaskExecution(
      {
        missions: missionRepository,
        tasks: taskRepository,
        reviewer: reviewerService,
        reviewDecisions: reviewDecisionRepo,
        executionResults: executionResultRepo,
        supervisor: processB,
        durableMemory,
        taskExecution: taskDispatcher,
      },
      {
        missionId: mission.id,
        taskId: canonicalTaskId,
        workflowId: initialWorkflowId,
        outcome: 'success',
        result: 'initial result',
        completedAt: new Date().toISOString(),
      },
    );

    const correctionDispatches =
      taskDispatcher.dispatched.filter(
        (dispatch) =>
          dispatch.workflowId === correctionWorkflowId,
      );

    expect(correctionDispatches).toHaveLength(1);

    const decisions =
      await reviewDecisionRepo.listByTaskId(canonicalTaskId);

    expect(
      decisions.filter(
        (decision) =>
          decision.decision === 'REQUEST_CHANGES',
      ),
    ).toHaveLength(1);

    const finalMissionTask =
      await missionRepository.getMissionTaskByCanonicalTaskId(
        canonicalTaskId,
      );

    expect(finalMissionTask?.status).toBe('queued');
  });
});
