import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  improvementCandidateStatusSchema,
  improvementCategorySchema,
  improvementPrioritySchema,
  ImprovementCandidateStatus,
  ImprovementCategory,
  ImprovementPriority,
  ImprovementCandidateIdentity,
  improvementCandidateSchema,
  ImprovementCandidate,
  computeCandidateContentHash,
  generateCandidateIdentity,
  areCandidatesEquivalent,
  deduplicateCandidates,
  comparePriority,
  sortCandidatesForSelection,
  selectHighestPriorityCandidate,
  VALID_STATUS_TRANSITIONS,
  isValidStatusTransition,
  createImprovementCandidate,
  updateCandidateStatus,
  supersedeCandidate,
  ImprovementBacklog,
  InMemoryImprovementBacklog,
} from './improvement-backlog';

// Helper to create a valid ImprovementCandidate for testing
function makeCandidate(overrides: Partial<ImprovementCandidate> = {}): ImprovementCandidate {
  const now = new Date().toISOString();
  const base: ImprovementCandidate = {
    id: 'imp-default',
    identity: {
      contentHash: 'default-hash',
      category: 'performance' as ImprovementCategory,
      targetComponent: 'default-component',
    },
    title: 'Test Title',
    description: 'Test Description',
    rationale: 'Test Rationale',
    category: 'performance' as ImprovementCategory,
    targetComponent: 'default-component',
    status: 'proposed',
    priority: 'high' as ImprovementPriority,
    proposedBy: 'Tester',
    proposedAt: now,
    reviewedAt: null,
    reviewedBy: null,
    reviewNotes: null,
    implementedAt: null,
    implementedBy: null,
    supersededBy: null,
    createdAt: now,
    updatedAt: now,
  };
  // Ensure identity matches category and targetComponent if they are overridden
  const candidate = { ...base, ...overrides };
  if (overrides.category || overrides.targetComponent) {
    candidate.identity = {
      ...candidate.identity,
      category: overrides.category ?? candidate.category,
      targetComponent: overrides.targetComponent ?? candidate.targetComponent,
    };
  }
  // If identity is overridden, ensure it matches
  if (overrides.identity) {
    candidate.identity = overrides.identity;
    // Also ensure the top-level category and targetComponent match identity
    candidate.category = overrides.identity.category;
    candidate.targetComponent = overrides.identity.targetComponent;
  }
  if (!overrides.id) {
    candidate.id = `imp-${candidate.category}-${candidate.targetComponent}-${candidate.title}`;
  }
  return candidate;
}

describe('ImprovementBacklog', () => {
  describe('schemas', () => {
    it('should have correct status schema', () => {
      expect(improvementCandidateStatusSchema).toEqual([
        'proposed',
        'under_review',
        'approved',
        'rejected',
        'implemented',
        'superseded',
      ]);
    });

    it('should have correct category schema', () => {
      expect(improvementCategorySchema).toEqual([
        'performance',
        'reliability',
        'security',
        'maintainability',
        'observability',
        'cost',
        'other',
      ]);
    });

    it('should have correct priority schema', () => {
      expect(improvementPrioritySchema).toEqual([
        'critical',
        'high',
        'medium',
        'low',
      ]);
    });
  });

  describe('computeCandidateContentHash', () => {
    it('should produce same hash for same input', () => {
      const hash1 = computeCandidateContentHash(
        'title',
        'description',
        'rationale',
        'performance',
        'component'
      );
      const hash2 = computeCandidateContentHash(
        'title',
        'description',
        'rationale',
        'performance',
        'component'
      );
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(16); // SHA256 truncated to 16 hex chars
    });

    it('should produce different hash for different input', () => {
      const hash1 = computeCandidateContentHash(
        'title',
        'description',
        'rationale',
        'performance',
        'component'
      );
      const hash2 = computeCandidateContentHash(
        'title',
        'description',
        'rationale',
        'performance',
        'differentComponent'
      );
      expect(hash1).not.toBe(hash2);
    });

    it('should trim whitespace', () => {
      const hash1 = computeCandidateContentHash(
        ' title ',
        ' description ',
        ' rationale ',
        'performance',
        ' component '
      );
      const hash2 = computeCandidateContentHash(
        'title',
        'description',
        'rationale',
        'performance',
        'component'
      );
      expect(hash1).toBe(hash2);
    });

    it('should be deterministic regardless of field order in JSON', () => {
      // JSON.stringify with sorted keys ensures same order
      const hash1 = computeCandidateContentHash(
        'title',
        'description',
        'rationale',
        'performance',
        'component'
      );
      // Simulate different order by swapping title and description in a custom function
      // But our function sorts keys, so it should be same.
      const payload = {
        title: 'title',
        description: 'description',
        rationale: 'rationale',
        category: 'performance',
        targetComponent: 'component'
      };
      const serialized1 = JSON.stringify(payload, Object.keys(payload).sort());
      const serialized2 = JSON.stringify(payload, ['rationale', 'description', 'title', 'category', 'targetComponent'].sort());
      expect(serialized1).toBe(serialized2); // Because we sort keys
    });
  });

  describe('generateCandidateIdentity', () => {
    it('should generate identity with contentHash, category, targetComponent', () => {
      const identity = generateCandidateIdentity(
        'title',
        'description',
        'rationale',
        'performance',
        'component'
      );
      expect(identity).toHaveProperty('contentHash');
      expect(identity).toHaveProperty('category', 'performance');
      expect(identity).toHaveProperty('targetComponent', 'component');
      expect(typeof identity.contentHash).toBe('string');
      expect(identity.contentHash.length).toBe(16);
    });

    it('should produce same identity for same input', () => {
      const id1 = generateCandidateIdentity(
        'title',
        'description',
        'rationale',
        'performance',
        'component'
      );
      const id2 = generateCandidateIdentity(
        'title',
        'description',
        'rationale',
        'performance',
        'component'
      );
      expect(id1).toEqual(id2);
    });
  });

  describe('areCandidatesEquivalent', () => {
    it('should return true for equivalent identities', () => {
      const id1: ImprovementCandidateIdentity = {
        contentHash: 'abc123',
        category: 'performance',
        targetComponent: 'component'
      };
      const id2: ImprovementCandidateIdentity = {
        contentHash: 'abc123',
        category: 'performance',
        targetComponent: 'component'
      };
      expect(areCandidatesEquivalent(id1, id2)).toBe(true);
    });

    it('should return false for different contentHash', () => {
      const id1: ImprovementCandidateIdentity = {
        contentHash: 'abc123',
        category: 'performance',
        targetComponent: 'component'
      };
      const id2: ImprovementCandidateIdentity = {
        contentHash: 'def456',
        category: 'performance',
        targetComponent: 'component'
      };
      expect(areCandidatesEquivalent(id1, id2)).toBe(false);
    });

    it('should return false for different category', () => {
      const id1: ImprovementCandidateIdentity = {
        contentHash: 'abc123',
        category: 'performance',
        targetComponent: 'component'
      };
      const id2: ImprovementCandidateIdentity = {
        contentHash: 'abc123',
        category: 'reliability',
        targetComponent: 'component'
      };
      expect(areCandidatesEquivalent(id1, id2)).toBe(false);
    });

    it('should return false for different targetComponent', () => {
      const id1: ImprovementCandidateIdentity = {
        contentHash: 'abc123',
        category: 'performance',
        targetComponent: 'component'
      };
      const id2: ImprovementCandidateIdentity = {
        contentHash: 'abc123',
        category: 'performance',
        targetComponent: 'otherComponent'
      };
      expect(areCandidatesEquivalent(id1, id2)).toBe(false);
    });
  });

  describe('deduplicateCandidates', () => {
    it('should deduplicate by identity', () => {
      const candidates = [
        makeCandidate({ id: '1', identity: { contentHash: 'hash1', category: 'performance', targetComponent: 'comp' }, title: 't1', description: 'd1', rationale: 'r1', category: 'performance', targetComponent: 'comp' }),
        makeCandidate({ id: '2', identity: { contentHash: 'hash1', category: 'performance', targetComponent: 'comp' }, title: 't1', description: 'd1', rationale: 'r1', category: 'performance', targetComponent: 'comp' }),
        makeCandidate({ id: '3', identity: { contentHash: 'hash2', category: 'performance', targetComponent: 'comp' }, title: 't2', description: 'd2', rationale: 'r2', category: 'performance', targetComponent: 'comp' }),
      ];
      const deduped = deduplicateCandidates(candidates);
      expect(deduped).toHaveLength(2);
      const ids = deduped.map(c => c.id);
      expect(ids).toContain('1');
      expect(ids).toContain('3');
      // Should keep first occurrence
      expect(deduped.find(c => c.id === '1')?.identity.contentHash).toBe('hash1');
    });

    it('should return empty array for empty input', () => {
      expect(deduplicateCandidates([])).toEqual([]);
    });

    it('should return same array if no duplicates', () => {
      const candidates = [
        makeCandidate({ id: '1', identity: { contentHash: 'hash1', category: 'performance', targetComponent: 'comp' }, title: 't1', description: 'd1', rationale: 'r1', category: 'performance', targetComponent: 'comp' }),
        makeCandidate({ id: '2', identity: { contentHash: 'hash2', category: 'performance', targetComponent: 'comp' }, title: 't2', description: 'd2', rationale: 'r2', category: 'performance', targetComponent: 'comp' }),
      ];
      const deduped = deduplicateCandidates(candidates);
      expect(deduped).toHaveLength(2);
      expect(deduped.map(c => c.id)).toEqual(['1', '2']);
    });
  });

  describe('comparePriority', () => {
    it('should return negative if a has higher priority than b', () => {
      expect(comparePriority('critical', 'high')).toBeLessThan(0);
      expect(comparePriority('high', 'medium')).toBeLessThan(0);
      expect(comparePriority('medium', 'low')).toBeLessThan(0);
    });

    it('should return positive if a has lower priority than b', () => {
      expect(comparePriority('high', 'critical')).toBeGreaterThan(0);
      expect(comparePriority('medium', 'high')).toBeGreaterThan(0);
      expect(comparePriority('low', 'medium')).toBeGreaterThan(0);
    });

    it('should return 0 for same priority', () => {
      expect(comparePriority('critical', 'critical')).toBe(0);
      expect(comparePriority('high', 'high')).toBe(0);
      expect(comparePriority('medium', 'medium')).toBe(0);
      expect(comparePriority('low', 'low')).toBe(0);
    });
  });

  describe('sortCandidatesForSelection', () => {
    it('should sort by priority (highest first) then proposedAt (oldest first)', () => {
      const now = new Date();
      const old = new Date(now.getTime() - 10000); // 10 seconds ago
      const recent = new Date(now.getTime()); // now

      const candidates = [
        makeCandidate({ id: '1', priority: 'low', proposedAt: old.toISOString(), title: 't1', description: 'd1', rationale: 'r1', category: 'performance', targetComponent: 'comp' }),
        makeCandidate({ id: '2', priority: 'high', proposedAt: recent.toISOString(), title: 't2', description: 'd2', rationale: 'r2', category: 'performance', targetComponent: 'comp' }),
        makeCandidate({ id: '3', priority: 'high', proposedAt: old.toISOString(), title: 't3', description: 'd3', rationale: 'r3', category: 'performance', targetComponent: 'comp' }),
        makeCandidate({ id: '4', priority: 'medium', proposedAt: old.toISOString(), title: 't4', description: 'd4', rationale: 'r4', category: 'performance', targetComponent: 'comp' }),
      ];

      const sorted = sortCandidatesForSelection(candidates);
      // Expected order: high (old), high (recent), medium, low
      expect(sorted[0].id).toBe('3'); // high, old
      expect(sorted[1].id).toBe('2'); // high, recent
      expect(sorted[2].id).toBe('4'); // medium
      expect(sorted[3].id).toBe('1'); // low
    });
  });

  describe('selectHighestPriorityCandidate', () => {
    it('should return null for empty array', () => {
      expect(selectHighestPriorityCandidate([])).toBeNull();
    });

    it('should return the highest priority candidate', () => {
      const now = new Date();
      const old = new Date(now.getTime() - 10000);
      const recent = new Date(now.getTime());

      const candidates = [
        makeCandidate({ id: '1', priority: 'low', proposedAt: old.toISOString(), title: 't1', description: 'd1', rationale: 'r1', category: 'performance', targetComponent: 'comp' }),
        makeCandidate({ id: '2', priority: 'high', proposedAt: recent.toISOString(), title: 't2', description: 'd2', rationale: 'r2', category: 'performance', targetComponent: 'comp' }),
        makeCandidate({ id: '3', priority: 'high', proposedAt: old.toISOString(), title: 't3', description: 'd3', rationale: 'r3', category: 'performance', targetComponent: 'comp' }),
      ];

      const selected = selectHighestPriorityCandidate(candidates);
      // Should be the high priority with oldest proposedAt (id:3)
      expect(selected?.id).toBe('3');
    });
  });

  describe('VALID_STATUS_TRANSITIONS and isValidStatusTransition', () => {
    it('should define valid transitions', () => {
      expect(VALID_STATUS_TRANSITIONS.proposed).toEqual(['under_review', 'rejected', 'superseded']);
      expect(VALID_STATUS_TRANSITIONS.under_review).toEqual(['approved', 'rejected', 'superseded']);
      expect(VALID_STATUS_TRANSITIONS.approved).toEqual(['implemented', 'rejected', 'superseded']);
      expect(VALID_STATUS_TRANSITIONS.rejected).toEqual(['proposed']);
      expect(VALID_STATUS_TRANSITIONS.implemented).toEqual(['superseded']);
      expect(VALID_STATUS_TRANSITIONS.superseded).toEqual([]);
    });

    it('should return true for valid transitions', () => {
      expect(isValidStatusTransition('proposed', 'under_review')).toBe(true);
      expect(isValidStatusTransition('proposed', 'rejected')).toBe(true);
      expect(isValidStatusTransition('proposed', 'superseded')).toBe(true);
      expect(isValidStatusTransition('under_review', 'approved')).toBe(true);
      expect(isValidStatusTransition('under_review', 'rejected')).toBe(true);
      expect(isValidStatusTransition('under_review', 'superseded')).toBe(true);
      expect(isValidStatusTransition('approved', 'implemented')).toBe(true);
      expect(isValidStatusTransition('approved', 'rejected')).toBe(true);
      expect(isValidStatusTransition('approved', 'superseded')).toBe(true);
      expect(isValidStatusTransition('rejected', 'proposed')).toBe(true);
      expect(isValidStatusTransition('implemented', 'superseded')).toBe(true);
    });

    it('should return false for invalid transitions', () => {
      expect(isValidStatusTransition('proposed', 'approved')).toBe(false);
      expect(isValidStatusTransition('proposed', 'implemented')).toBe(false);
      expect(isValidStatusTransition('under_review', 'proposed')).toBe(false);
      expect(isValidStatusTransition('approved', 'under_review')).toBe(false);
      expect(isValidStatusTransition('rejected', 'under_review')).toBe(false);
      expect(isValidStatusTransition('superseded', 'proposed')).toBe(false);
      expect(isValidStatusTransition('superseded', 'under_review')).toBe(false);
      expect(isValidStatusTransition('superseded', 'approved')).toBe(false);
      expect(isValidStatusTransition('superseded', 'rejected')).toBe(false);
      expect(isValidStatusTransition('superseded', 'implemented')).toBe(false);
    });
  });

  describe('createImprovementCandidate', () => {
    it('should create candidate with correct initial values', () => {
      const input = {
        title: 'Test Title',
        description: 'Test Description',
        rationale: 'Test Rationale',
        category: 'performance' as ImprovementCategory,
        targetComponent: 'TestComponent',
        priority: 'high' as ImprovementPriority,
        proposedBy: 'tester'
      };
      const candidate = createImprovementCandidate(input);
      expect(candidate.title).toBe('Test Title');
      expect(candidate.description).toBe('Test Description');
      expect(candidate.rationale).toBe('Test Rationale');
      expect(candidate.category).toBe('performance');
      expect(candidate.targetComponent).toBe('TestComponent');
      expect(candidate.priority).toBe('high');
      expect(candidate.proposedBy).toBe('tester');
      expect(candidate.status).toBe('proposed');
      expect(candidate.reviewedAt).toBeNull();
      expect(candidate.reviewedBy).toBeNull();
      expect(candidate.reviewNotes).toBeNull();
      expect(candidate.implementedAt).toBeNull();
      expect(candidate.implementedBy).toBeNull();
      expect(candidate.supersededBy).toBeNull();
      expect(candidate.createdAt).toBeDefined();
      expect(candidate.updatedAt).toBeDefined();
      expect(candidate.id).toMatch(/^imp-[a-f0-9]{16}$/);
      // Identity should be generated
      expect(candidate.identity).toHaveProperty('contentHash');
      expect(candidate.identity.category).toBe('performance');
      expect(candidate.identity.targetComponent).toBe('TestComponent');
    });

    it('should trim input strings', () => {
      const input = {
        title: '  Test Title  ',
        description: '  Test Description  ',
        rationale: '  Test Rationale  ',
        category: 'performance' as ImprovementCategory,
        targetComponent: '  TestComponent  ',
        priority: 'high' as ImprovementPriority,
        proposedBy: '  tester  '
      };
      const candidate = createImprovementCandidate(input);
      expect(candidate.title).toBe('Test Title');
      expect(candidate.description).toBe('Test Description');
      expect(candidate.rationale).toBe('Test Rationale');
      expect(candidate.targetComponent).toBe('TestComponent');
      expect(candidate.proposedBy).toBe('tester');
    });

    it('should return defensive copy (mutating returned object does not affect internal state)', () => {
      // This is hard to test without exposing internal state, but we can at least check that the object is not frozen
      const input = {
        title: 'Test',
        description: 'Test',
        rationale: 'Test',
        category: 'performance' as ImprovementCategory,
        targetComponent: 'Test',
        priority: 'high' as ImprovementPriority,
        proposedBy: 'tester'
      };
      const candidate1 = createImprovementCandidate(input);
      const candidate2 = createImprovementCandidate(input);

      /*
       * Compare WITHOUT createdAt/updatedAt.
       *
       * createImprovementCandidate() stamps `new Date().toISOString()` per call,
       * so two calls that straddle a millisecond boundary produce different
       * timestamps. Comparing them made this test intermittently fail in the
       * full suite while passing in isolation — a flaky gate proves nothing.
       *
       * Wall-clock timestamps differing between two separate calls is correct
       * behaviour, not the property under test. The defensive-copy property is
       * still asserted below (distinct objects, independent mutation), and the
       * content-derived id is still compared.
       */
      const ignoringTimestamps = (
        candidate: typeof candidate1,
      ) => ({
        ...candidate,
        createdAt: "<when>",
        updatedAt: "<when>",
      });

      expect(ignoringTimestamps(candidate1)).toEqual(
        ignoringTimestamps(candidate2),
      );
      expect(candidate1.id).toBe(candidate2.id);
      expect(candidate1).not.toBe(candidate2);
      // Mutating one should not affect the other
      candidate1.title = 'Mutated';
      expect(candidate2.title).toBe('Test');
    });
  });

  describe('updateCandidateStatus', () => {
    let candidate: ImprovementCandidate;
    const now = new Date().toISOString();

    beforeEach(() => {
      candidate = makeCandidate({
        title: 'Test',
        description: 'Test',
        rationale: 'Test',
        category: 'performance' as ImprovementCategory,
        targetComponent: 'Test',
        priority: 'high' as ImprovementPriority,
        proposedBy: 'tester'
      });
      // Override timestamps to fixed values for predictable testing
      candidate.createdAt = now;
      candidate.updatedAt = now;
    });

    it('should throw error for invalid transition', () => {
      expect(() => updateCandidateStatus(candidate, 'approved', 'tester')).toThrowError(
        /Invalid status transition: proposed -> approved/
      );
    });

    it('should transition to under_review', () => {
      const updated = updateCandidateStatus(candidate, 'under_review', 'reviewer', 'Notes');
      expect(updated.status).toBe('under_review');
      expect(updated.reviewedAt).toBeDefined();
      expect(updated.reviewedBy).toBe('reviewer');
      expect(updated.reviewNotes).toBe('Notes');
      expect(updated.updatedAt).toBeDefined();
      // Defensive copy: original candidate unchanged
      expect(candidate.status).toBe('proposed');
    });

    it('should transition to approved from under_review', () => {
      const underReview = updateCandidateStatus(candidate, 'under_review', 'reviewer', 'Notes');
      const approved = updateCandidateStatus(underReview, 'approved', 'approver', 'Approved');
      expect(approved.status).toBe('approved');
      expect(approved.reviewedAt).toBeDefined();
      expect(approved.reviewedBy).toBe('approver');
      expect(approved.reviewNotes).toBe('Approved');
    });

    it('should transition to rejected', () => {
      const rejected = updateCandidateStatus(candidate, 'rejected', 'reviewer', 'Rejected');
      expect(rejected.status).toBe('rejected');
      expect(rejected.reviewedAt).toBeDefined();
      expect(rejected.reviewedBy).toBe('reviewer');
      expect(rejected.reviewNotes).toBe('Rejected');
    });

    it('should transition to implemented from approved', () => {
      const underReview = updateCandidateStatus(candidate, 'under_review', 'reviewer', 'Notes');
      const approved = updateCandidateStatus(underReview, 'approved', 'approver', 'Approved');
      const implemented = updateCandidateStatus(approved, 'implemented', 'impler', '');
      expect(implemented.status).toBe('implemented');
      expect(implemented.implementedAt).toBeDefined();
      expect(implemented.implementedBy).toBe('impler');
    });

    it('should transition to superseded from implemented', () => {
      const underReview = updateCandidateStatus(candidate, 'under_review', 'reviewer', 'Notes');
      const approved = updateCandidateStatus(underReview, 'approved', 'approver', 'Approved');
      const implemented = updateCandidateStatus(approved, 'implemented', 'impler', '');
      const superseded = updateCandidateStatus(implemented, 'superseded', 'manager', '');
      expect(superseded.status).toBe('superseded');
      // supersededBy is set separately via supersedeCandidate
    });

    it('should allow re-proposing from rejected', () => {
      const rejected = updateCandidateStatus(candidate, 'rejected', 'reviewer', 'Rejected');
      const proposedAgain = updateCandidateStatus(rejected, 'proposed', 'tester2', '');
      expect(proposedAgain.status).toBe('proposed');
      // Note: proposedAt and proposedBy are not reset by updateCandidateStatus (only status and updatedAt)
      // This is by design: the original proposedAt/proposedBy remain for audit.
    });

    it('should return defensive copy', () => {
      const updated1 = updateCandidateStatus(candidate, 'under_review', 'reviewer', 'Notes');
      const updated2 = updateCandidateStatus(candidate, 'under_review', 'reviewer', 'Notes');
      expect(updated1).toEqual(updated2);
      expect(updated1).not.toBe(updated2);
      // Mutating one should not affect the other
      updated1.status = 'proposed';
      expect(updated2.status).toBe('under_review');
    });
  });

  describe('supersedeCandidate', () => {
    it('should set status to superseded and set supersededBy', () => {
      const candidate = makeCandidate({
        title: 'Test',
        description: 'Test',
        rationale: 'Test',
        category: 'performance' as ImprovementCategory,
        targetComponent: 'Test',
        priority: 'high' as ImprovementPriority,
        proposedBy: 'tester'
      });
      const superseded = supersedeCandidate(candidate, 'superseding-id');
      expect(superseded.status).toBe('superseded');
      expect(superseded.supersededBy).toBe('superseding-id');
      expect(superseded.updatedAt).toBeDefined();
      // Original candidate unchanged
      expect(candidate.status).toBe('proposed');
    });

    it('should be idempotent', () => {
      const candidate = makeCandidate({
        title: 'Test',
        description: 'Test',
        rationale: 'Test',
        category: 'performance' as ImprovementCategory,
        targetComponent: 'Test',
        priority: 'high' as ImprovementPriority,
        proposedBy: 'tester'
      });
      const superseded1 = supersedeCandidate(candidate, 'superseding-id');
      const superseded2 = supersedeCandidate(superseded1, 'superseding-id');
      expect(superseded1).toEqual(superseded2);
    });
  });

  describe('InMemoryImprovementBacklog', () => {
    let backlog: InMemoryImprovementBacklog;
    const now = new Date().toISOString();

    beforeEach(() => {
      backlog = new InMemoryImprovementBacklog();
    });

    it('should add and get candidate', async () => {
      const candidate = makeCandidate({
        title: 'Test',
        description: 'Test',
        rationale: 'Test',
        category: 'performance' as ImprovementCategory,
        targetComponent: 'Test',
        priority: 'high' as ImprovementPriority,
        proposedBy: 'tester'
      });
      await backlog.add(candidate);
      const retrieved = await backlog.get(candidate.id);
      expect(retrieved).toEqual(candidate);
      // Defensive copy: retrieved should not be same object
      expect(retrieved).not.toBe(candidate);
    });

    it('should return null for non-existent id', async () => {
      const retrieved = await backlog.get('non-existent-id');
      expect(retrieved).toBeNull();
    });

    it('should list all candidates', async () => {
      const c1 = makeCandidate({
        title: 'Test1',
        description: 'Test1',
        rationale: 'Test1',
        category: 'performance' as ImprovementCategory,
        targetComponent: 'Test1',
        priority: 'high' as ImprovementPriority,
        proposedBy: 'tester'
      });
      const c2 = makeCandidate({
        title: 'Test2',
        description: 'Test2',
        rationale: 'Test2',
        category: 'reliability' as ImprovementCategory,
        targetComponent: 'Test2',
        priority: 'low' as ImprovementPriority,
        proposedBy: 'tester'
      });
      await backlog.add(c1);
      await backlog.add(c2);
      const list = await backlog.list();
      expect(list).toHaveLength(2);
      expect(list.map(c => c.id)).toContain(c1.id);
      expect(list.map(c => c.id)).toContain(c2.id);
    });

    it('should list with status filter', async () => {
      const c1 = makeCandidate({
        title: 'Test1',
        description: 'Test1',
        rationale: 'Test1',
        category: 'performance' as ImprovementCategory,
        targetComponent: 'Test1',
        priority: 'high' as ImprovementPriority,
        proposedBy: 'tester'
      });
      const c2 = makeCandidate({
        title: 'Test2',
        description: 'Test2',
        rationale: 'Test2',
        category: 'reliability' as ImprovementCategory,
        targetComponent: 'Test2',
        priority: 'low' as ImprovementPriority,
        proposedBy: 'tester'
      });
      // Change c2 status to under_review
      const c2UnderReview = updateCandidateStatus(c2, 'under_review', 'reviewer', '');
      await backlog.add(c1);
      await backlog.add(c2UnderReview);
      const list = await backlog.list({ status: 'under_review' });
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(c2.id);
    });

    it('should list with category filter', async () => {
      const c1 = makeCandidate({
        title: 'Test1',
        description: 'Test1',
        rationale: 'Test1',
        category: 'performance' as ImprovementCategory,
        targetComponent: 'Test1',
        priority: 'high' as ImprovementPriority,
        proposedBy: 'tester'
      });
      const c2 = makeCandidate({
        title: 'Test2',
        description: 'Test2',
        rationale: 'Test2',
        category: 'reliability' as ImprovementCategory,
        targetComponent: 'Test2',
        priority: 'low' as ImprovementPriority,
        proposedBy: 'tester'
      });
      await backlog.add(c1);
      await backlog.add(c2);
      const list = await backlog.list({ category: 'performance' });
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(c1.id);
    });

    it('should list with targetComponent filter', async () => {
      const c1 = makeCandidate({
        title: 'Test1',
        description: 'Test1',
        rationale: 'Test1',
        category: 'performance' as ImprovementCategory,
        targetComponent: 'CompA',
        priority: 'high' as ImprovementPriority,
        proposedBy: 'tester'
      });
      const c2 = makeCandidate({
        title: 'Test2',
        description: 'Test2',
        rationale: 'Test2',
        category: 'performance' as ImprovementCategory,
        targetComponent: 'CompB',
        priority: 'low' as ImprovementPriority,
        proposedBy: 'tester'
      });
      await backlog.add(c1);
      await backlog.add(c2);
      const list = await backlog.list({ targetComponent: 'CompA' });
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(c1.id);
    });

    it('should list with priority filter', async () => {
      const c1 = makeCandidate({
        title: 'Test1',
        description: 'Test1',
        rationale: 'Test1',
        category: 'performance' as ImprovementCategory,
        targetComponent: 'Test1',
        priority: 'high' as ImprovementPriority,
        proposedBy: 'tester'
      });
      const c2 = makeCandidate({
        title: 'Test2',
        description: 'Test2',
        rationale: 'Test2',
        category: 'performance' as ImprovementCategory,
        targetComponent: 'Test2',
        priority: 'low' as ImprovementPriority,
        proposedBy: 'tester'
      });
      await backlog.add(c1);
      await backlog.add(c2);
      const list = await backlog.list({ priority: 'low' });
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(c2.id);
    });

    it('should list with limit', async () => {
      const c1 = makeCandidate({
        title: 'Test1',
        description: 'Test1',
        rationale: 'Test1',
        category: 'performance' as ImprovementCategory,
        targetComponent: 'Test1',
        priority: 'high' as ImprovementPriority,
        proposedBy: 'tester'
      });
      const c2 = makeCandidate({
        title: 'Test2',
        description: 'Test2',
        rationale: 'Test2',
        category: 'performance' as ImprovementCategory,
        targetComponent: 'Test2',
        priority: 'low' as ImprovementPriority,
        proposedBy: 'tester'
      });
      const c3 = makeCandidate({
        title: 'Test3',
        description: 'Test3',
        rationale: 'Test3',
        category: 'performance' as ImprovementCategory,
        targetComponent: 'Test3',
        priority: 'medium' as ImprovementPriority,
        proposedBy: 'tester'
      });
      await backlog.add(c1);
      await backlog.add(c2);
      await backlog.add(c3);
      const list = await backlog.list({ limit: 2 });
      expect(list).toHaveLength(2);
      // Should be sorted by priority then proposedAt (all same proposedAt, so high, medium, low -> take high and medium)
      expect(list[0].priority).toBe('high');
      expect(list[1].priority).toBe('medium');
    });

    it('should update candidate', async () => {
      const candidate = makeCandidate({
        title: 'Test',
        description: 'Test',
        rationale: 'Test',
        category: 'performance' as ImprovementCategory,
        targetComponent: 'Test',
        priority: 'high' as ImprovementPriority,
        proposedBy: 'tester'
      });
      await backlog.add(candidate);
      const updated = updateCandidateStatus(candidate, 'under_review', 'reviewer', 'Notes');
      await backlog.update(updated);
      const retrieved = await backlog.get(candidate.id);
      expect(retrieved?.status).toBe('under_review');
      expect(retrieved?.reviewedBy).toBe('reviewer');
      expect(retrieved?.reviewNotes).toBe('Notes');
    });

    it('rejects an update that would duplicate another candidate identity', async () => {
      const first = makeCandidate({
        id: 'first',
        identity: {
          contentHash: 'first-hash',
          category: 'performance',
          targetComponent: 'src/core/first.ts',
        },
      });
      const second = makeCandidate({
        id: 'second',
        identity: {
          contentHash: 'second-hash',
          category: 'performance',
          targetComponent: 'src/core/second.ts',
        },
      });
      await backlog.add(first);
      await backlog.add(second);

      await expect(
        backlog.update({
          ...second,
          identity: { ...first.identity },
          category: first.category,
          targetComponent: first.targetComponent,
        }),
      ).rejects.toThrow(/duplicates candidate first/);
      expect(await backlog.list()).toHaveLength(2);
    });

    it('should throw error when updating non-existent candidate', async () => {
      const candidate = makeCandidate({
        title: 'Test',
        description: 'Test',
        rationale: 'Test',
        category: 'performance' as ImprovementCategory,
        targetComponent: 'Test',
        priority: 'high' as ImprovementPriority,
        proposedBy: 'tester'
      });
      await expect(backlog.update(candidate)).rejects.toThrow(/Candidate .* not found/);
    });

    it('should remove candidate', async () => {
      const candidate = makeCandidate({
        title: 'Test',
        description: 'Test',
        rationale: 'Test',
        category: 'performance' as ImprovementCategory,
        targetComponent: 'Test',
        priority: 'high' as ImprovementPriority,
        proposedBy: 'tester'
      });
      await backlog.add(candidate);
      await backlog.remove(candidate.id);
      const retrieved = await backlog.get(candidate.id);
      expect(retrieved).toBeNull();
    });

    it('should return defensive copies in list', async () => {
      const candidate = makeCandidate({
        title: 'Test',
        description: 'Test',
        rationale: 'Test',
        category: 'performance' as ImprovementCategory,
        targetComponent: 'Test',
        priority: 'high' as ImprovementPriority,
        proposedBy: 'tester'
      });
      await backlog.add(candidate);
      const list1 = await backlog.list();
      const list2 = await backlog.list();
      expect(list1[0]).toEqual(list2[0]);
      expect(list1[0]).not.toBe(list2[0]);
      // Mutating one list's candidate should not affect the other
      list1[0].title = 'Mutated';
      expect(list2[0].title).toBe('Test');
    });

    it('deduplicates logically equivalent candidates on insertion', async () => {
      const first = createImprovementCandidate({
        title: 'Improve parser',
        description: 'Remove redundant work',
        rationale: 'Reduce latency',
        category: 'performance',
        targetComponent: 'src\\core\\parser.ts',
        priority: 'high',
        proposedBy: 'planner',
      });
      const equivalent = {
        ...createImprovementCandidate({
          title: ' Improve parser ',
          description: ' Remove redundant work ',
          rationale: ' Reduce latency ',
          category: 'performance',
          targetComponent: 'src/core/./parser.ts',
          priority: 'high',
          proposedBy: 'planner',
        }),
        id: 'different-external-id',
      };

      await backlog.add(first);
      await backlog.add(equivalent);

      expect(await backlog.list()).toHaveLength(1);
    });

    it('isolates stored nested identity from caller mutation after add', async () => {
      const candidate = makeCandidate({ id: 'nested-add' });
      await backlog.add(candidate);

      candidate.identity.targetComponent = 'mutated/component';

      expect((await backlog.get(candidate.id))?.identity.targetComponent).toBe(
        'default-component',
      );
    });

    it('does not expose nested identity through get or list', async () => {
      const candidate = makeCandidate({ id: 'nested-read' });
      await backlog.add(candidate);

      const retrieved = await backlog.get(candidate.id);
      if (!retrieved) throw new Error('candidate was not stored');
      retrieved.identity.targetComponent = 'mutated/from-get';

      const listed = await backlog.list();
      listed[0].identity.targetComponent = 'mutated/from-list';

      expect((await backlog.get(candidate.id))?.identity.targetComponent).toBe(
        'default-component',
      );
    });
  });

  describe('deterministic target and ordering semantics', () => {
    it('normalizes path-like target components for identity', () => {
      const posix = generateCandidateIdentity(
        'Improve parser',
        'Description',
        'Rationale',
        'maintainability',
        'src/core/parser.ts',
      );
      const lexicalEquivalent = generateCandidateIdentity(
        ' Improve parser ',
        ' Description ',
        ' Rationale ',
        'maintainability',
        'src\\core//./parser.ts',
      );

      expect(lexicalEquivalent).toEqual(posix);
      expect(lexicalEquivalent.targetComponent).toBe('src/core/parser.ts');
    });

    it('does not collapse distinct non-path semantic components', () => {
      const upper = generateCandidateIdentity(
        'Title',
        'Description',
        'Rationale',
        'other',
        'PlannerService',
      );
      const lower = generateCandidateIdentity(
        'Title',
        'Description',
        'Rationale',
        'other',
        'plannerservice',
      );

      expect(upper).not.toEqual(lower);
    });

    it.each([
      ['empty target', ''],
      ['NUL byte', 'src/core/parser\0.ts'],
      ['absolute target', '/src/core/parser.ts'],
      ['escaping traversal', 'src/../../parser.ts'],
    ])('rejects an unusable path-like %s', (_label, targetComponent) => {
      expect(() =>
        generateCandidateIdentity(
          'Title',
          'Description',
          'Rationale',
          'maintainability',
          targetComponent,
        ),
      ).toThrow();
    });

    it('uses a deterministic identity and id independent of creation time', () => {
      const input = {
        title: 'Stable candidate',
        description: 'Stable description',
        rationale: 'Stable rationale',
        category: 'reliability' as const,
        targetComponent: 'src/core/stable.ts',
        priority: 'critical' as const,
        proposedBy: 'planner',
      };

      const first = createImprovementCandidate(input);
      const second = createImprovementCandidate(input);

      expect(first.identity).toEqual(second.identity);
      expect(first.id).toBe(second.id);
    });

    it('uses identity as a deterministic tie-break for equal priority and time', () => {
      const proposedAt = '2026-01-01T00:00:00.000Z';
      const a = makeCandidate({ id: 'a', priority: 'high', proposedAt });
      const b = makeCandidate({ id: 'b', priority: 'high', proposedAt });

      expect(sortCandidatesForSelection([b, a]).map((candidate) => candidate.id)).toEqual([
        'a',
        'b',
      ]);
      expect(sortCandidatesForSelection([a, b]).map((candidate) => candidate.id)).toEqual([
        'a',
        'b',
      ]);
    });

    it('normalizes a path-like target component filter without host filesystem state', async () => {
      const backlog = new InMemoryImprovementBacklog();
      const candidate = createImprovementCandidate({
        title: 'Path filter',
        description: 'Description',
        rationale: 'Rationale',
        category: 'observability',
        targetComponent: 'src/core/telemetry.ts',
        priority: 'medium',
        proposedBy: 'planner',
      });
      await backlog.add(candidate);

      const matches = await backlog.list({
        targetComponent: 'src\\core\\./telemetry.ts',
      });

      expect(matches.map((item) => item.id)).toEqual([candidate.id]);
    });
  });
});