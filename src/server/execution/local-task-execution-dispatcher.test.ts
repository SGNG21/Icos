import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalTaskExecutionDispatcher } from './local-task-execution-dispatcher';
import type { TaskExecutionDispatcher } from './ports';
import type { TaskExecutionDispatchInput, TaskExecutionDispatchResult } from './ports';
import type { ExecutionOutcome, ExecutionError } from '@/core/contracts';
import { recordTaskExecution } from '@/server/usecases/record-task-execution';
import type { DurableMemory } from '@/core/context/durable-memory';
import type { MissionRepository } from '@/server/mission/ports';
import type { TaskExecutionResultRepository, TaskRepository } from '@/server/repositories/ports';
import type { SupervisorService } from '@/server/supervisor/supervisor-service';

// Mock the recordTaskExecution function
vi.mock('@/server/usecases/record-task-execution');

describe('LocalTaskExecutionDispatcher', () => {
  let dispatcher: LocalTaskExecutionDispatcher;
  // Distinct empty stand-ins: recordTaskExecution is mocked, only identity matters.
  const mockedDependencies = {
    tasks: {} as TaskRepository,
    executionResults: {} as TaskExecutionResultRepository,
    supervisor: {} as SupervisorService,
    missions: {} as MissionRepository,
    durableMemory: {} as DurableMemory,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    dispatcher = new LocalTaskExecutionDispatcher(
      mockedDependencies.executionResults,
      mockedDependencies.missions,
      mockedDependencies.tasks,
      mockedDependencies.supervisor,
      mockedDependencies.durableMemory,
    );
  });

  const createInput = (overrides: Partial<TaskExecutionDispatchInput> = {}): TaskExecutionDispatchInput => ({
    taskId: 'task1',
    prompt: 'ECHO:hello',
    workerKind: 'other',
    capability: 'test',
    ...overrides,
  });

  it('should execute the local work and return the workflowId', async () => {
    const input = createInput();
    const result = await dispatcher.dispatch(input);

    expect(result).toHaveProperty('workflowId');
    expect(typeof result.workflowId).toBe('string');
    // The workflowId should be generated because none was provided
    expect(result.workflowId).toMatch(/^icos-local-task1-\d+$/);
    // recordTaskExecution should have been called
    expect(recordTaskExecution).toHaveBeenCalled();
  });

  it('should not re-execute when the same explicit workflowId is provided twice', async () => {
    const workflowId = 'icos-local-test-fixed';
    const input1 = createInput({ workflowId });
    const input2 = createInput({ workflowId });

    // First dispatch
    const result1 = await dispatcher.dispatch(input1);
    expect(result1).toEqual({ workflowId });
    // Second dispatch with the same workflowId
    const result2 = await dispatcher.dispatch(input2);
    expect(result2).toEqual({ workflowId });

    // recordTaskExecution should have been called only once
    expect(recordTaskExecution).toHaveBeenCalledTimes(1);
  });

  it('should execute twice when different explicit workflowIds are provided', async () => {
    const input1 = createInput({ workflowId: 'icos-local-test-1' });
    const input2 = createInput({ workflowId: 'icos-local-test-2' });

    const result1 = await dispatcher.dispatch(input1);
    const result2 = await dispatcher.dispatch(input2);

    expect(result1).toEqual({ workflowId: 'icos-local-test-1' });
    expect(result2).toEqual({ workflowId: 'icos-local-test-2' });
    expect(recordTaskExecution).toHaveBeenCalledTimes(2);
  });

  it('should use the generated workflowId for idempotency within the same dispatcher instance', async () => {
    const input = createInput(); // No workflowId provided, so one will be generated
    const result1 = await dispatcher.dispatch(input);
    const result2 = await dispatcher.dispatch(input); // Same input, so same generated workflowId

    expect(result1).toEqual(result2);
    expect(recordTaskExecution).toHaveBeenCalledTimes(1);
  });

  it('should handle WRITE_FILE command', async () => {
    const input = createInput({ prompt: 'WRITE_FILE:/tmp/test.txt:Hello World' });
    const result = await dispatcher.dispatch(input);

    expect(result).toHaveProperty('workflowId');
    expect(recordTaskExecution).toHaveBeenCalled();
  });

  it('should handle unknown command as echo', async () => {
    const input = createInput({ prompt: 'UNKNOWN:something' });
    const result = await dispatcher.dispatch(input);

    expect(result).toHaveProperty('workflowId');
    expect(recordTaskExecution).toHaveBeenCalled();
  });
});