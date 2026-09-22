import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskExecutionResult } from '@/core/contracts/task-execution';
import type { ReviewDecisionRecord } from '@/core/contracts/review';
import type { DurableMemory } from '@/core/context/durable-memory';
import type { LearnedPattern } from '@/core/context/contracts';
import {
  FactualOutcome,
  FactualLearnedPattern,
  LearningHarvesterInput,
  LearningHarvestResult,
  extractOutcomesFromExecution,
  extractOutcomesFromReview,
  groupOutcomesBySignature,
  generatePatternName,
  generatePatternDescription,
  extractObservations,
  buildPatternFromOutcomes,
  harvestLearning,
  queryLearnedPatterns,
  getLearnedPatternById,
} from './learning-harvester';

// Mock DurableMemory
const createMockDurableMemory = () => {
  const patterns: LearnedPattern[] = [];
  return {
    getPatterns: vi.fn(async (query: { capability?: string; workerKind?: string; outcome?: string; limit?: number }) => {
      let filtered = patterns;
      if (query.capability) filtered = filtered.filter(p => p.signature.capability === query.capability);
      if (query.workerKind) filtered = filtered.filter(p => p.signature.workerKind === query.workerKind);
      if (query.outcome) filtered = filtered.filter(p => p.outcome === query.outcome);
      if (query.limit) filtered = filtered.slice(0, query.limit);
      return Promise.resolve(filtered);
    }),
    savePattern: vi.fn(async (pattern: LearnedPattern) => {
      const existingIndex = patterns.findIndex(p => p.id === pattern.id);
      if (existingIndex >= 0) {
        patterns[existingIndex] = pattern;
      } else {
        patterns.push(pattern);
      }
      return Promise.resolve();
    }),
    // For testing, we expose the patterns
    __getPatterns: () => patterns,
    __clear: () => {
      patterns.length = 0;
    },
  } as unknown as DurableMemory;
};

describe('LearningHarvester', () => {
  let durableMemory: DurableMemory;

  beforeEach(() => {
    durableMemory = createMockDurableMemory();
  });

  describe('extractOutcomesFromExecution', () => {
    it('should extract outcomes from execution results', () => {
      const now = new Date().toISOString();
      const results: TaskExecutionResult[] = [
        {
          id: 'exec-1',
          taskId: 'task-1',
          workflowId: 'wf-1',
          outcome: 'success',
          capability: 'cap-1',
          workerKind: 'hermes',
          error: undefined,
          findings: [],
          evidence: [],
          completedAt: now,
          recordedAt: now,
        },
        {
          id: 'exec-2',
          taskId: 'task-2',
          workflowId: 'wf-2',
          outcome: 'failure',
          capability: 'cap-2',
          workerKind: 'openhands',
          error: { code: 'WORKER_FAILED', message: 'Something went wrong' },
          findings: [
            {
              severity: 'WARN',
              check: 'check-1',
              message: 'Finding message',
              category: 'cat-1',
              repairability: 'auto',
            },
          ],
          evidence: [
            { type: 'log', source: 'system', timestamp: now, url: 'http://example.com/evidence1' },
            { type: 'log', source: 'system', timestamp: now, path: '/path/to/evidence2' },
            { type: 'log', source: 'source-3', timestamp: now },
          ],
          completedAt: now,
        },
      ];

      const outcomes = extractOutcomesFromExecution(results);
      expect(outcomes).toHaveLength(2);

      // First outcome
      expect(outcomes[0]).toEqual({
        id: 'exec-exec-1',
        source: 'execution',
        missionId: '',
        taskId: 'task-1',
        workflowId: 'wf-1',
        outcome: 'success',
        capability: 'cap-1',
        workerKind: 'hermes',
        errorCode: undefined,
        errorMessage: undefined,
        findings: [],
        evidenceRefs: [],
        timestamp: now,
      });

      // Second outcome
      expect(outcomes[1]).toEqual({
        id: 'exec-exec-2',
        source: 'execution',
        missionId: '',
        taskId: 'task-2',
        workflowId: 'wf-2',
        outcome: 'failure',
        capability: 'cap-2',
        workerKind: 'openhands',
        errorCode: 'WORKER_FAILED',
        errorMessage: 'Something went wrong',
        findings: [
          {
            severity: 'warn', // lowercased
            check: 'check-1',
            message: 'Finding message',
            category: 'cat-1',
            repairability: 'auto', // unchanged
          },
        ],
        evidenceRefs: [
          'http://example.com/evidence1',
          '/path/to/evidence2',
          'source-3',
        ],
        timestamp: now,
      });
    });

    it('should handle empty execution results', () => {
      const outcomes = extractOutcomesFromExecution([]);
      expect(outcomes).toEqual([]);
    });
  });

  describe('extractOutcomesFromReview', () => {
    it('should extract outcomes from review decisions', () => {
      const now = new Date().toISOString();
      const decisions: ReviewDecisionRecord[] = [
        {
          id: 'review-1',
          missionId: 'mission-1',
          taskId: 'task-1',
          workflowId: 'wf-1',
          decision: 'APPROVE',
          requestedChanges: [],
          evidenceRefs: ['ref1', 'ref2'],
          createdAt: now,
        },
        {
          id: 'review-2',
          missionId: 'mission-2',
          taskId: 'task-2',
          workflowId: 'wf-2',
          decision: 'REJECT',
          requestedChanges: [
            { field: 'field-1', reason: 'Reason for change' },
            { field: 'field-2', reason: 'Another reason' },
          ],
          evidenceRefs: [],
          createdAt: now,
        },
      ];

      const outcomes = extractOutcomesFromReview(decisions);
      expect(outcomes).toHaveLength(2);

      // First outcome (APPROVE -> success)
      expect(outcomes[0]).toEqual({
        id: 'review-review-1',
        source: 'review',
        missionId: 'mission-1',
        taskId: 'task-1',
        workflowId: 'wf-1',
        outcome: 'success',
        capability: undefined,
        workerKind: undefined,
        errorCode: undefined,
        errorMessage: undefined,
        findings: [],
        evidenceRefs: ['ref1', 'ref2'],
        timestamp: now,
        reviewDecision: 'APPROVE',
      });

      // Second outcome (REJECT -> failure)
      expect(outcomes[1]).toEqual({
        id: 'review-review-2',
        source: 'review',
        missionId: 'mission-2',
        taskId: 'task-2',
        workflowId: 'wf-2',
        outcome: 'failure',
        capability: undefined,
        workerKind: undefined,
        errorCode: undefined,
        errorMessage: undefined,
        findings: [
          {
            severity: 'warning',
            check: 'field-1',
            message: 'Reason for change',
            category: 'review_change_request',
            repairability: 'manual',
          },
          {
            severity: 'warning',
            check: 'field-2',
            message: 'Another reason',
            category: 'review_change_request',
            repairability: 'manual',
          },
        ],
        evidenceRefs: [],
        timestamp: now,
        reviewDecision: 'REJECT',
      });
    });

    it('should handle empty review decisions', () => {
      const outcomes = extractOutcomesFromReview([]);
      expect(outcomes).toEqual([]);
    });
  });

  describe('groupOutcomesBySignature', () => {
    it('should group outcomes by signature', () => {
      const now = new Date().toISOString();
      const outcomes: FactualOutcome[] = [
        {
          id: '1',
          source: 'execution',
          missionId: 'mission-1',
          taskId: 'task-1',
          workflowId: 'wf-1',
          outcome: 'success',
          capability: 'cap-1',
          workerKind: 'worker-1',
          errorCode: 'ERR-1',
          findings: [
            { severity: 'error', check: 'check-1', message: 'msg', category: 'cat-1' },
            { severity: 'error', check: 'check-2', message: 'msg2', category: 'cat-2' },
          ],
          evidenceRefs: [],
          timestamp: now,
        },
        {
          id: '2',
          source: 'execution',
          missionId: 'mission-1',
          taskId: 'task-2',
          workflowId: 'wf-2',
          outcome: 'success',
          capability: 'cap-1',
          workerKind: 'worker-1',
          errorCode: 'ERR-1',
          findings: [
            { severity: 'error', check: 'check-1', message: 'msg', category: 'cat-1' },
            { severity: 'error', check: 'check-2', message: 'msg2', category: 'cat-2' },
          ],
          evidenceRefs: [],
          timestamp: now,
        },
        {
          id: '3',
          source: 'execution',
          missionId: 'mission-1',
          taskId: 'task-3',
          workflowId: 'wf-3',
          outcome: 'failure',
          capability: 'cap-2',
          workerKind: 'worker-2',
          errorCode: 'ERR-2',
          findings: [
            { severity: 'error', check: 'check-3', message: 'msg', category: 'cat-3' },
          ],
          evidenceRefs: [],
          timestamp: now,
        },
        {
          id: '4',
          source: 'execution',
          missionId: 'mission-1',
          taskId: 'task-4',
          workflowId: 'wf-4',
          outcome: 'success',
          capability: 'cap-1',
          // No workerKind
          errorCode: 'ERR-1',
          findings: [
            { severity: 'error', check: 'check-1', message: 'msg', category: 'cat-1' },
          ],
          evidenceRefs: [],
          timestamp: now,
        },
      ];

      const groups = groupOutcomesBySignature(outcomes);
      expect(groups.size).toBe(3); // Three distinct signatures

      // Check the groups
      const group1 = Array.from(groups.entries()).find(([key]) => key.startsWith('cap:cap-1|wk:worker-1|err:ERR-1|cat:cat-1,cat-2'));
      expect(group1).toBeDefined();
      expect(group1?.[1]).toHaveLength(2); // Two outcomes with signature cap-1|worker-1|ERR-1|cat-1,cat-2

      const group2 = Array.from(groups.entries()).find(([key]) => key.startsWith('cap:cap-2|wk:worker-2|err:ERR-2|cat:cat-3'));
      expect(group2).toBeDefined();
      expect(group2?.[1]).toHaveLength(1);

      const group3 = Array.from(groups.entries()).find(([key]) => key.startsWith('cap:cap-1|err:ERR-1|cat:cat-1') && !key.includes('wk:'));
      expect(group3).toBeDefined();
      expect(group3?.[1]).toHaveLength(1);
    });

    it('should handle empty outcomes', () => {
      const groups = groupOutcomesBySignature([]);
      expect(groups.size).toBe(0);
    });

    it('should use default signature when no signature parts', () => {
      const now = new Date().toISOString();
      const outcomes: FactualOutcome[] = [
        {
          id: '1',
          source: 'execution',
          missionId: 'mission-1',
          taskId: 'task-1',
          workflowId: 'wf-1',
          outcome: 'success',
          evidenceRefs: [],
          timestamp: now,
        },
      ];

      const groups = groupOutcomesBySignature(outcomes);
      expect(groups.size).toBe(1);
      const signature = groups.keys().next().value;
      expect(signature).toBe('default');
    });
  });

  describe('generatePatternName', () => {
    it('should generate a readable name from signature', () => {
      const name = generatePatternName('cap:cap-1|wk:worker-1|err:ERR-1|cat:cat-1,cat-2', 'failure');
      expect(name).toBe('failure: capability:cap-1, worker:worker-1, error:ERR-1, finding:cat-1,cat-2');
    });

    it('should handle empty signature', () => {
      const name = generatePatternName('', 'success');
      expect(name).toBe('success: ');
    });

    it('should handle signature with only some parts', () => {
      const name = generatePatternName('cap:cap-1|cat:cat-1', 'mixed');
      expect(name).toBe('mixed: capability:cap-1, finding:cat-1');
    });
  });

  describe('generatePatternDescription', () => {
    it('should generate description from outcomes', () => {
      const now = new Date().toISOString();
      const outcomes: FactualOutcome[] = [
        {
          id: '1',
          source: 'execution',
          missionId: 'mission-1',
          taskId: 'task-1',
          workflowId: 'wf-1',
          outcome: 'success',
          capability: 'cap-1',
          workerKind: 'worker-1',
          errorCode: 'ERR-1',
          findings: [
            { severity: 'error', check: 'check-1', message: 'msg', category: 'cat-1' },
            { severity: 'error', check: 'check-2', message: 'msg2', category: 'cat-2' },
          ],
          evidenceRefs: [],
          timestamp: now,
        },
        {
          id: '2',
          source: 'execution',
          missionId: 'mission-1',
          taskId: 'task-2',
          workflowId: 'wf-2',
          outcome: 'failure',
          capability: 'cap-1',
          workerKind: 'worker-1',
          errorCode: 'ERR-1',
          findings: [
            { severity: 'error', check: 'check-1', message: 'msg', category: 'cat-1' },
          ],
          evidenceRefs: [],
          timestamp: now,
        },
      ];

      const desc = generatePatternDescription(outcomes, 'cap:cap-1|wk:worker-1|err:ERR-1|cat:cat-1,cat-2');
      expect(desc).toContain('Observed 2 time(s): 1 success, 1 failure.');
      expect(desc).toContain('Capabilities: cap-1.');
      expect(desc).toContain('Workers: worker-1.');
      expect(desc).toContain('Error codes: ERR-1.');
    });

    it('should handle outcomes with missing fields', () => {
      const now = new Date().toISOString();
      const outcomes: FactualOutcome[] = [
        {
          id: '1',
          source: 'execution',
          missionId: 'mission-1',
          taskId: 'task-1',
          workflowId: 'wf-1',
          outcome: 'success',
          evidenceRefs: [],
          timestamp: now,
        },
      ];

      const desc = generatePatternDescription(outcomes, 'default');
      expect(desc).toBe('Observed 1 time(s): 1 success.');
    });
  });

  describe('extractObservations', () => {
    it('should extract observations from outcomes', () => {
      const now = new Date().toISOString();
      const outcomes: FactualOutcome[] = [
        {
          id: '1',
          source: 'execution',
          missionId: 'mission-1',
          taskId: 'task-1',
          workflowId: 'wf-1',
          outcome: 'success',
          errorMessage: 'Something went wrong',
          repairAction: 'restart-service',
          repairSucceeded: true,
          findings: [
            { severity: 'error', check: 'check-1', message: 'Error found', category: 'cat-1' },
            { severity: 'warning', check: 'check-2', message: 'Warning found', category: 'cat-2' },
          ],
          evidenceRefs: [],
          timestamp: now,
        },
        {
          id: '2',
          source: 'review',
          missionId: 'mission-1',
          taskId: 'task-1',
          workflowId: 'wf-1',
          outcome: 'failure',
          reviewDecision: 'REJECT',
          evidenceRefs: [],
          timestamp: now,
        },
      ];

      const observations = extractObservations(outcomes);
      expect(observations).toContain('Error: Something went wrong');
      expect(observations).toContain('Repair: restart-service (succeeded)');
      expect(observations).toContain('Review decision: REJECT');
      expect(observations).toContain('Finding [error]: check-1 - Error found');
      expect(observations).toContain('Finding [warning]: check-2 - Warning found');
      // Should be capped at 20
    });

    it('should return empty array for outcomes with no observations', () => {
      const now = new Date().toISOString();
      const outcomes: FactualOutcome[] = [
        {
          id: '1',
          source: 'execution',
          missionId: 'mission-1',
          taskId: 'task-1',
          workflowId: 'wf-1',
          outcome: 'success',
          evidenceRefs: [],
          timestamp: now,
        },
      ];
      expect(extractObservations(outcomes)).toEqual([]);
    });
  });

  describe('buildPatternFromOutcomes', () => {
    it('should build a pattern from outcomes', () => {
      const now = new Date().toISOString();
      const outcomes: FactualOutcome[] = [
        {
          id: '1',
          source: 'execution',
          missionId: 'mission-1',
          taskId: 'task-1',
          workflowId: 'wf-1',
          outcome: 'success',
          capability: 'cap-1',
          workerKind: 'worker-1',
          errorCode: 'ERR-1',
          findings: [
            { severity: 'error', check: 'check-1', message: 'msg', category: 'cat-1' },
          ],
          evidenceRefs: ['ref1', 'ref2'],
          timestamp: now,
        },
        {
          id: '2',
          source: 'execution',
          missionId: 'mission-1',
          taskId: 'task-2',
          workflowId: 'wf-2',
          outcome: 'success',
          capability: 'cap-1',
          workerKind: 'worker-1',
          errorCode: 'ERR-1',
          findings: [
            { severity: 'error', check: 'check-1', message: 'msg', category: 'cat-1' },
          ],
          evidenceRefs: ['ref2', 'ref3'],
          timestamp: now,
        },
      ];

      const pattern = buildPatternFromOutcomes('cap:cap-1|wk:worker-1|err:ERR-1|cat:cat-1', outcomes);
      expect(pattern).toHaveProperty('id');
      expect(pattern.name).toBe('success: capability:cap-1, worker:worker-1, error:ERR-1, finding:cat-1');
      expect(pattern.description).toBe('Observed 2 time(s): 2 success. Capabilities: cap-1. Workers: worker-1. Error codes: ERR-1.');
      expect(pattern.signature).toEqual({
        capability: 'cap-1',
        workerKind: 'worker-1',
        errorCode: 'ERR-1',
        findingCategory: 'cat-1',
        taskTitleKeywords: [],
      });
      expect(pattern.outcome).toBe('success');
      expect(pattern.observations).toEqual(expect.arrayContaining([expect.stringContaining('check-1 - msg')]));
      // No confidence field
      expect(pattern.occurrenceCount).toBe(2);
      expect(pattern.outcomeCounts).toEqual({ success: 2, failure: 0 });
      expect(pattern.evidenceRefs).toEqual(['ref1', 'ref2', 'ref3']); // deduplicated
      expect(pattern.lastSeenAt).toBe(now);
      expect(pattern.firstSeenAt).toBe(now);
    });

    it('should handle mixed outcomes', () => {
      const now = new Date().toISOString();
      const outcomes: FactualOutcome[] = [
        {
          id: '1',
          source: 'execution',
          missionId: 'mission-1',
          taskId: 'task-1',
          workflowId: 'wf-1',
          outcome: 'success',
          evidenceRefs: [],
          timestamp: now,
        },
        {
          id: '2',
          source: 'execution',
          missionId: 'mission-1',
          taskId: 'task-2',
          workflowId: 'wf-2',
          outcome: 'failure',
          evidenceRefs: [],
          timestamp: now,
        },
      ];

      const pattern = buildPatternFromOutcomes('default', outcomes);
      expect(pattern.outcome).toBe('mixed');
      expect(pattern.occurrenceCount).toBe(2);
      expect(pattern.outcomeCounts).toEqual({ success: 1, failure: 1 });
    });
  });

  describe('harvestLearning', () => {
    it('should harvest learning from execution results', async () => {
      const now = new Date().toISOString();
      const executionResults: TaskExecutionResult[] = [
        {
          id: 'exec-1',
          taskId: 'task-1',
          workflowId: 'wf-1',
          outcome: 'success',
          capability: 'cap-1',
          workerKind: 'worker-1',
          error: undefined,
          findings: [],
          evidence: [],
          completedAt: now,
        },
        {
          id: 'exec-2',
          taskId: 'task-1',
          workflowId: 'wf-1',
          outcome: 'success',
          capability: 'cap-1',
          workerKind: 'worker-1',
          error: undefined,
          findings: [],
          evidence: [],
          completedAt: now,
        },
      ];

      const input: LearningHarvesterInput = {
        executionResults,
      };

      const result = await harvestLearning(input, durableMemory);
      expect(result.outcomesProcessed).toBe(2);
      expect(result.newPatterns).toHaveLength(1);
      expect(result.updatedPatterns).toHaveLength(0);
      expect(result.errors).toEqual([]);

      const pattern = result.newPatterns[0];
      expect(pattern.outcome).toBe('success');
      expect(pattern.occurrenceCount).toBe(2);
      expect(pattern.outcomeCounts).toEqual({ success: 2, failure: 0 });
    });

    it('should harvest learning from review decisions', async () => {
      const now = new Date().toISOString();
      const reviewDecisions: ReviewDecisionRecord[] = [
        {
          id: 'review-1',
          missionId: 'mission-1',
          taskId: 'task-1',
          workflowId: 'wf-1',
          decision: 'APPROVE',
          requestedChanges: [],
          evidenceRefs: ['ref1'],
          createdAt: now,
        },
        {
          id: 'review-2',
          missionId: 'mission-1',
          taskId: 'task-1',
          workflowId: 'wf-1',
          decision: 'APPROVE',
          requestedChanges: [],
          evidenceRefs: ['ref2'],
          createdAt: now,
        },
      ];

      const input: LearningHarvesterInput = {
        reviewDecisions,
      };

      const result = await harvestLearning(input, durableMemory);
      expect(result.outcomesProcessed).toBe(2);
      expect(result.newPatterns).toHaveLength(1);
      expect(result.updatedPatterns).toHaveLength(0);
      expect(result.errors).toEqual([]);

      const pattern = result.newPatterns[0];
      expect(pattern.outcome).toBe('success');
      expect(pattern.occurrenceCount).toBe(2);
      expect(pattern.evidenceRefs).toEqual(['ref1', 'ref2']);
    });

    it('should update existing pattern when similar outcomes are seen', async () => {
      const now = new Date().toISOString();
      // First, save a pattern directly to durableMemory
      const existingPattern: LearnedPattern = {
        id: 'existing-pattern',
        name: 'existing pattern',
        description: 'existing description',
        signature: {
          capability: 'cap-1',
          workerKind: 'worker-1',
        },
        outcome: 'success',
        observations: ['old observation'],
        confidence: 0, // Not used
        occurrenceCount: 1,
        evidenceRefs: ['old-ref'],
        lastSeenAt: now,
        createdAt: now,
      };
      await durableMemory.savePattern(existingPattern);

      // Now harvest learning that should match this pattern
      const executionResults: TaskExecutionResult[] = [
        {
          id: 'exec-1',
          taskId: 'task-1',
          workflowId: 'wf-1',
          outcome: 'success',
          capability: 'cap-1',
          workerKind: 'worker-1',
          error: undefined,
          findings: [],
          evidence: [{ url: 'new-ref' }],
          completedAt: now,
        },
      ];

      const input: LearningHarvesterInput = {
        executionResults,
      };

      const result = await harvestLearning(input, durableMemory);
      expect(result.outcomesProcessed).toBe(1);
      expect(result.newPatterns).toHaveLength(0); // Should update existing, not create new
      expect(result.updatedPatterns).toHaveLength(1);
      expect(result.errors).toEqual([]);

      const updatedPattern = result.updatedPatterns[0];
      expect(updatedPattern.outcome).toBe('success');
      expect(updatedPattern.occurrenceCount).toBe(2); // 1 existing + 1 new
      expect(updatedPattern.outcomeCounts).toEqual({ success: 2, failure: 0 });
      expect(updatedPattern.evidenceRefs).toEqual(expect.arrayContaining(['old-ref', 'new-ref']));
      expect(updatedPattern.observations).toEqual(expect.arrayContaining(['old observation']));
    });

    it('should handle factualOutcomes input', async () => {
      const now = new Date().toISOString();
      const factualOutcomes: FactualOutcome[] = [
        {
          id: 'outcome-1',
          source: 'execution',
          missionId: 'mission-1',
          taskId: 'task-1',
          workflowId: 'wf-1',
          outcome: 'success',
          capability: 'cap-1',
          workerKind: 'worker-1',
          evidenceRefs: ['ref1'],
          timestamp: now,
        },
        {
          id: 'outcome-2',
          source: 'execution',
          missionId: 'mission-1',
          taskId: 'task-1',
          workflowId: 'wf-1',
          outcome: 'success',
          capability: 'cap-1',
          workerKind: 'worker-1',
          evidenceRefs: ['ref2'],
          timestamp: now,
        },
      ];

      const input: LearningHarvesterInput = {
        factualOutcomes,
      };

      const result = await harvestLearning(input, durableMemory);
      expect(result.outcomesProcessed).toBe(2);
      expect(result.newPatterns).toHaveLength(1);
      expect(result.updatedPatterns).toHaveLength(0);
      expect(result.errors).toEqual([]);
    });

    it('should filter by missionId', async () => {
      const now = new Date().toISOString();
      const executionResults: TaskExecutionResult[] = [
        {
          id: 'exec-1',
          taskId: 'task-1',
          workflowId: 'wf-1',
          outcome: 'success',
          capability: 'cap-1',
          workerKind: 'worker-1',
          error: undefined,
          findings: [],
          evidence: [],
          completedAt: now,
        },
        {
          id: 'exec-2',
          taskId: 'task-2',
          workflowId: 'wf-2',
          outcome: 'success',
          capability: 'cap-1',
          workerKind: 'worker-1',
          error: undefined,
          findings: [],
          evidence: [],
          completedAt: now,
        },
      ];

      // We need to set missionId in the outcomes. In our extractOutcomesFromExecution, missionId is hardcoded to ''.
      // So we will use factualOutcomes where we can set missionId.
      const factualOutcomes: FactualOutcome[] = [
        {
          id: 'outcome-1',
          source: 'execution',
          missionId: 'mission-1',
          taskId: 'task-1',
          workflowId: 'wf-1',
          outcome: 'success',
          capability: 'cap-1',
          workerKind: 'worker-1',
          evidenceRefs: [],
          timestamp: now,
        },
        {
          id: 'outcome-2',
          source: 'execution',
          missionId: 'mission-2',
          taskId: 'task-2',
          workflowId: 'wf-2',
          outcome: 'success',
          capability: 'cap-1',
          workerKind: 'worker-1',
          evidenceRefs: [],
          timestamp: now,
        },
      ];

      const input2: LearningHarvesterInput = {
        factualOutcomes,
        missionId: 'mission-1',
      };

      const result2 = await harvestLearning(input2, durableMemory);
      expect(result2.outcomesProcessed).toBe(1); // Only one outcome matches missionId
      expect(result2.newPatterns).toHaveLength(1);
    });

    it('should handle errors during extraction', async () => {
      const now = new Date().toISOString();
      const executionResults: TaskExecutionResult[] = [
        {
          id: 'exec-1',
          taskId: 'task-1',
          workflowId: 'wf-1',
          outcome: 'success',
          capability: 'cap-1',
          workerKind: 'worker-1',
          error: undefined,
          findings: [],
          evidence: [],
          completedAt: now,
        },
      ];

      const input: LearningHarvesterInput = {
        executionResults,
      };

      const result = await harvestLearning(input, durableMemory);
      expect(result.errors).toEqual([]);
    });
  });

  describe('queryLearnedPatterns', () => {
    it('should query learned patterns from durable memory', async () => {
      const pattern: LearnedPattern = {
        id: 'pattern-1',
        name: 'pattern 1',
        description: 'description 1',
        signature: {
          capability: 'cap-1',
          workerKind: 'worker-1',
        },
        outcome: 'success',
        observations: ['obs1'],
        confidence: 0,
        occurrenceCount: 1,
        evidenceRefs: ['ref1'],
        lastSeenAt: '2026-09-22T19:08:50.347Z',
        createdAt: '2026-09-22T19:08:50.347Z',
      };
      await durableMemory.savePattern(pattern);

      const result = await queryLearnedPatterns(durableMemory, { capability: 'cap-1' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('pattern-1');
      expect(result[0].name).toBe('pattern 1');
      expect(result[0].outcome).toBe('success');
      expect(result[0].observations).toEqual(['obs1']);
      // No confidence field
      expect(result[0].occurrenceCount).toBe(1);
      expect(result[0].evidenceRefs).toEqual(['ref1']);
    });
  });

  describe('getLearnedPatternById', () => {
    it('should return pattern by ID', async () => {
      const pattern: LearnedPattern = {
        id: 'pattern-1',
        name: 'pattern 1',
        description: 'description 1',
        signature: {
          capability: 'cap-1',
          workerKind: 'worker-1',
        },
        outcome: 'success',
        observations: ['obs1'],
        confidence: 0,
        occurrenceCount: 1,
        evidenceRefs: ['ref1'],
        lastSeenAt: '2026-09-22T19:08:50.347Z',
        createdAt: '2026-09-22T19:08:50.347Z',
      };
      await durableMemory.savePattern(pattern);

      const result = await getLearnedPatternById(durableMemory, 'pattern-1');
      expect(result).not.toBeNull();
      expect(result?.id).toBe('pattern-1');
      expect(result?.name).toBe('pattern 1');
      expect(result?.description).toBe('description 1');
      expect(result?.signature).toEqual({
        capability: 'cap-1',
        workerKind: 'worker-1',
      });
      expect(result?.outcome).toBe('success');
      expect(result?.observations).toEqual(['obs1']);
      // No confidence field
      expect(result?.occurrenceCount).toBe(1);
      expect(result?.outcomeCounts).toEqual({ success: 1, failure: 0 });
      expect(result?.firstSeenAt).toBe('2026-09-22T19:08:50.347Z');
      expect(result?.lastSeenAt).toBe('2026-09-22T19:08:50.347Z');
      expect(result?.evidenceRefs).toEqual(['ref1']);
    });

    it('should return null for non-existent ID', async () => {
      const result = await getLearnedPatternById(durableMemory, 'non-existent');
      expect(result).toBeNull();
    });
  });
});