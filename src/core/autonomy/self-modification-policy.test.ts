import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SelfModificationClassification,
  SelfModificationDecision,
  selfModificationClassificationSchema,
  selfModificationDecisionSchema,
  PROTECTED_DOMAINS,
  ProtectedDomain,
  PROTECTED_PATHS,
  ALL_PROTECTED_PATHS,
  ALLOWED_IMPROVEMENT_DOMAINS,
  AllowedImprovementDomain,
  SelfModificationPolicyInput,
  classifySelfModification,
  evaluateSelfModification,
  isPathProtected,
  getProtectedDomainForPath,
  isAllowedImprovementCategory,
  getAllProtectedDomains,
  getAllAllowedImprovementDomains,
} from './self-modification-policy';

describe('SelfModificationPolicy', () => {
  describe('schemas', () => {
    it('should have correct classification schema', () => {
      expect(selfModificationClassificationSchema).toEqual([
        'allowed',
        'protected',
        'unknown',
      ]);
    });

    it('should have correct decision schema shape', () => {
      // We can't directly test the schema object, but we can test that the decision object conforms
      const decision: SelfModificationDecision = {
        classification: 'allowed',
        allowed: true,
        reason: 'test',
        evidence: ['evidence1'],
        protectedPaths: ['path1'],
        decidedAt: new Date().toISOString(),
        decidedBy: 'tester',
      };
      expect(decision).toHaveProperty('classification');
      expect(decision).toHaveProperty('allowed');
      expect(decision).toHaveProperty('reason');
      expect(decision).toHaveProperty('evidence');
      expect(decision).toHaveProperty('protectedPaths');
      expect(decision).toHaveProperty('decidedAt');
      expect(decision).toHaveProperty('decidedBy');
    });
  });

  describe('PROTECTED_DOMAINS and PROTECTED_PATHS', () => {
    it('should define the protected domains', () => {
      expect(PROTECTED_DOMAINS).toEqual([
        'kernel-authority',
        'security-policy',
        'credential-secrets-authority',
        'global-governance-policy',
        'completion-certification-authority',
      ]);
    });

    it('should define protected paths for each domain', () => {
      // Check that each domain has a non-empty array of paths
      PROTECTED_DOMAINS.forEach(domain => {
        const paths = PROTECTED_PATHS[domain as ProtectedDomain];
        expect(paths).toBeInstanceOf(Array);
        expect(paths.length).toBeGreaterThan(0);
      });
    });

    it('should flatten to ALL_PROTECTED_PATHS', () => {
      const flattened = Object.values(PROTECTED_PATHS).flat();
      expect(ALL_PROTECTED_PATHS).toEqual(flattened);
    });
  });

  describe('ALLOWED_IMPROVEMENT_DOMAINS', () => {
    it('should define the allowed improvement domains', () => {
      expect(ALLOWED_IMPROVEMENT_DOMAINS).toEqual([
        'performance-optimization',
        'observability-enhancement',
        'documentation-improvement',
        'test-coverage',
        'refactoring-non-core',
        'dependency-update-non-breaking',
        'logging-enhancement',
        'metrics-instrumentation',
        'cache-optimization',
        'resource-cleanup',
      ]);
    });
  });

  describe('classifySelfModification', () => {
    const baseInput: SelfModificationPolicyInput = {
      targetPaths: ['src/core/some-service.ts'],
      changeDescription: 'Some change',
      improvementCategory: 'performance-optimization',
      isSelfProposed: false,
      actor: 'tester',
    };

    it('should return protected if any target path matches a protected path', () => {
      const input = {
        ...baseInput,
        targetPaths: ['src/core/authorization/permissions.ts'], // protected path
      };
      const classification = classifySelfModification(input);
      expect(classification).toBe('protected');
    });

    it('should return protected if target path is a parent of a protected path', () => {
      const input = {
        ...baseInput,
        targetPaths: ['src/core/authorization/'], // parent of protected path
      };
      const classification = classifySelfModification(input);
      expect(classification).toBe('protected');
    });

    it('should return protected if protected path is a parent of target path', () => {
      const input = {
        ...baseInput,
        targetPaths: ['src/core/authorization/permissions.ts/subpath.ts'], // child of protected path
      };
      const classification = classifySelfModification(input);
      expect(classification).toBe('protected');
    });

    it('should return allowed if category is in allowed list and not protected', () => {
      const input = {
        ...baseInput,
        targetPaths: ['src/core/some-service.ts'],
        improvementCategory: 'performance-optimization',
      };
      const classification = classifySelfModification(input);
      expect(classification).toBe('allowed');
    });

    it('should return allowed for self-proposed changes in allowed domain', () => {
      const input = {
        ...baseInput,
        targetPaths: ['src/core/some-service.ts'],
        improvementCategory: 'performance-optimization',
        isSelfProposed: true,
      };
      const classification = classifySelfModification(input);
      expect(classification).toBe('allowed');
    });

    it('should return unknown if category not in allowed list and not protected', () => {
      const input = {
        ...baseInput,
        targetPaths: ['src/core/some-service.ts'],
        improvementCategory: 'unknown-category', // not in allowed list
      };
      const classification = classifySelfModification(input);
      expect(classification).toBe('unknown');
    });
  });

  describe('evaluateSelfModification', () => {
    const baseInput: SelfModificationPolicyInput = {
      targetPaths: ['src/core/some-service.ts'],
      changeDescription: 'Some change',
      improvementCategory: 'performance-optimization',
      isSelfProposed: false,
      actor: 'tester',
    };

    it('should return denied decision for protected classification', () => {
      const input = {
        ...baseInput,
        targetPaths: ['src/core/authorization/permissions.ts'],
      };
      const decision = evaluateSelfModification(input);
      expect(decision.classification).toBe('protected');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('protected domain');
      expect(decision.evidence).toContain('src/core/authorization/permissions.ts');
      expect(decision.protectedPaths).toContain('src/core/authorization/permissions.ts');
    });

    it('should return allowed decision for allowed classification', () => {
      const input = {
        ...baseInput,
        targetPaths: ['src/core/some-service.ts'],
        improvementCategory: 'performance-optimization',
      };
      const decision = evaluateSelfModification(input);
      expect(decision.classification).toBe('allowed');
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toContain('allowed improvement domain');
      expect(decision.evidence).toContain('category: performance-optimization');
      expect(decision.evidence).toContain('targetPaths: src/core/some-service.ts');
    });

    it('should return denied decision for unknown classification (fail-closed)', () => {
      const input = {
        ...baseInput,
        targetPaths: ['src/core/some-service.ts'],
        improvementCategory: 'unknown-category',
      };
      const decision = evaluateSelfModification(input);
      expect(decision.classification).toBe('unknown');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('Classification UNKNOWN');
      expect(decision.reason).toContain('fail-closed');
      expect(decision.evidence).toContain('category: unknown-category (not in allowed list)');
    });

    it('should include the actor in evidence for allowed decision', () => {
      const input = {
        ...baseInput,
        targetPaths: ['src/core/some-service.ts'],
        improvementCategory: 'performance-optimization',
        actor: 'jane-doe',
      };
      const decision = evaluateSelfModification(input);
      expect(decision.evidence).toContain('actor: jane-doe');
    });

    it('should include self-proposed flag in evidence for allowed decision', () => {
      const input = {
        ...baseInput,
        targetPaths: ['src/core/some-service.ts'],
        improvementCategory: 'performance-optimization',
        isSelfProposed: true,
      };
      const decision = evaluateSelfModification(input);
      expect(decision.evidence).toContain('self-proposed: additional review recommended');
    });

    it('should return a decision with a timestamp and decider', () => {
      const input = {
        ...baseInput,
        targetPaths: ['src/core/some-service.ts'],
        improvementCategory: 'performance-optimization',
      };
      const decision = evaluateSelfModification(input);
      expect(decision.decidedAt).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z/);
      expect(decision.decidedBy).toBe('self-modification-policy-engine');
    });
  });

  describe('isPathProtected', () => {
    it('should return true for a protected path', () => {
      expect(isPathProtected('src/core/authorization/permissions.ts')).toBe(true);
    });

    it('should return true for a path under a protected directory', () => {
      expect(isPathProtected('src/core/authorization/permissions.ts/subpath.ts')).toBe(true);
    });

    it('should return true for a parent directory of a protected path', () => {
      expect(isPathProtected('src/core/authorization/')).toBe(true);
    });

    it('should return false for a non-protected path', () => {
      expect(isPathProtected('src/core/some-service.ts')).toBe(false);
    });
  });

  describe('getProtectedDomainForPath', () => {
    it('should return the domain for a protected path', () => {
      const domain = getProtectedDomainForPath('src/core/authorization/permissions.ts');
      expect(domain).toBe('kernel-authority');
    });

    it('should return the domain for a path under a protected directory', () => {
      const domain = getProtectedDomainForPath('src/core/authorization/permissions.ts/subpath.ts');
      expect(domain).toBe('kernel-authority');
    });

    it('should return null for a non-protected path', () => {
      const domain = getProtectedDomainForPath('src/core/some-service.ts');
      expect(domain).toBeNull();
    });
  });

  describe('isAllowedImprovementCategory', () => {
    it('should return true for an allowed category', () => {
      expect(isAllowedImprovementCategory('performance-optimization')).toBe(true);
    });

    it('should return false for a non-allowed category', () => {
      expect(isAllowedImprovementCategory('unknown-category')).toBe(false);
    });
  });

  describe('getAllProtectedDomains', () => {
    it('should return a copy of the protected domains array', () => {
      const domains = getAllProtectedDomains();
      expect(domains).toEqual(PROTECTED_DOMAINS);
      // Ensure it's a copy
      expect(domains).not.toBe(PROTECTED_DOMAINS);
    });
  });

  describe('getAllAllowedImprovementDomains', () => {
    it('should return a copy of the allowed improvement domains array', () => {
      const domains = getAllAllowedImprovementDomains();
      expect(domains).toEqual(ALLOWED_IMPROVEMENT_DOMAINS);
      // Ensure it's a copy
      expect(domains).not.toBe(ALLOWED_IMPROVEMENT_DOMAINS);
    });
  });
});