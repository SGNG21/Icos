import { createHash } from "node:crypto";
import { idSchema, isoDateTimeSchema } from "@/core/contracts/common";

/**
 * Status lifecycle for improvement candidates.
 * Explicit and auditable transitions.
 */
export const improvementCandidateStatusSchema = [
  "proposed",
  "under_review",
  "approved",
  "rejected",
  "implemented",
  "superseded",
] as const;

export type ImprovementCandidateStatus = (typeof improvementCandidateStatusSchema)[number];

/**
 * Category of improvement candidate.
 */
export const improvementCategorySchema = [
  "performance",
  "reliability",
  "security",
  "maintainability",
  "observability",
  "cost",
  "other",
] as const;

export type ImprovementCategory = (typeof improvementCategorySchema)[number];

/**
 * Priority levels - explicit ordering without synthetic scores.
 * Higher priority values = more important.
 */
export const improvementPrioritySchema = [
  "critical",
  "high",
  "medium",
  "low",
] as const;

export type ImprovementPriority = (typeof improvementPrioritySchema)[number];

/**
 * Deterministic identity for an improvement candidate.
 * Stable unique identity: contentHash + category + targetComponent.
 */
export interface ImprovementCandidateIdentity {
  contentHash: string;
  category: ImprovementCategory;
  targetComponent: string;
}

/**
 * Canonical representation of an improvement candidate.
 * Deterministic candidate representation with stable identity.
 */
export const improvementCandidateSchema = {
  id: idSchema,
  identity: {
    contentHash: { type: "string", minLength: 1 },
    category: { type: "string", enum: improvementCategorySchema },
    targetComponent: { type: "string", minLength: 1 },
  },
  title: { type: "string", minLength: 1 },
  description: { type: "string" },
  rationale: { type: "string", minLength: 1 },
  category: { type: "string", enum: improvementCategorySchema },
  targetComponent: { type: "string", minLength: 1 },
  status: { type: "string", enum: improvementCandidateStatusSchema },
  priority: { type: "string", enum: improvementPrioritySchema },
  proposedBy: { type: "string", minLength: 1 },
  proposedAt: isoDateTimeSchema,
  reviewedAt: { type: ["string", "null"], format: "date-time" },
  reviewedBy: { type: ["string", "null"] },
  reviewNotes: { type: ["string", "null"] },
  implementedAt: { type: ["string", "null"], format: "date-time" },
  implementedBy: { type: ["string", "null"] },
  supersededBy: { type: ["string", "null"] },
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
} as const;

export type ImprovementCandidate = {
  id: string;
  identity: ImprovementCandidateIdentity;
  title: string;
  description: string;
  rationale: string;
  category: ImprovementCategory;
  targetComponent: string;
  status: ImprovementCandidateStatus;
  priority: ImprovementPriority;
  proposedBy: string;
  proposedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNotes: string | null;
  implementedAt: string | null;
  implementedBy: string | null;
  supersededBy: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Deterministic hash of candidate content for deduplication.
 * Same content + category + targetComponent = same hash.
 */
export function computeCandidateContentHash(
  title: string,
  description: string,
  rationale: string,
  category: ImprovementCategory,
  targetComponent: string,
): string {
  const payload = {
    title: title.trim(),
    description: description.trim(),
    rationale: rationale.trim(),
    category,
    targetComponent: targetComponent.trim(),
  };
  const serialized = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(serialized, "utf-8").digest("hex").slice(0, 16);
}

/**
 * Generate stable unique identity for a candidate.
 */
export function generateCandidateIdentity(
  title: string,
  description: string,
  rationale: string,
  category: ImprovementCategory,
  targetComponent: string,
): ImprovementCandidateIdentity {
  const contentHash = computeCandidateContentHash(
    title,
    description,
    rationale,
    category,
    targetComponent,
  );
  return { contentHash, category, targetComponent };
}

/**
 * Check if two candidates are equivalent (same identity).
 */
export function areCandidatesEquivalent(
  a: ImprovementCandidateIdentity,
  b: ImprovementCandidateIdentity,
): boolean {
  return (
    a.contentHash === b.contentHash &&
    a.category === b.category &&
    a.targetComponent === b.targetComponent
  );
}

/**
 * Deduplicate a list of candidates by identity.
 * Keeps the first occurrence (proposed earliest).
 */
export function deduplicateCandidates<T extends { identity: ImprovementCandidateIdentity }>(
  candidates: T[],
): T[] {
  const seen = new Map<string, T>();
  for (const candidate of candidates) {
    const key = `${candidate.identity.contentHash}:${candidate.identity.category}:${candidate.identity.targetComponent}`;
    if (!seen.has(key)) {
      seen.set(key, candidate);
    }
  }
  return Array.from(seen.values());
}

/**
 * Priority ordering: critical > high > medium > low.
 * Returns negative if a has higher priority than b.
 */
export function comparePriority(a: ImprovementPriority, b: ImprovementPriority): number {
  const order: Record<ImprovementPriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  return order[a] - order[b];
}

/**
 * Sort candidates by priority (highest first), then by proposedAt (oldest first).
 * Deterministic selection.
 */
export function sortCandidatesForSelection<T extends { priority: ImprovementPriority; proposedAt: string }>(
  candidates: T[],
): T[] {
  return [...candidates].sort((a, b) => {
    const priorityDiff = comparePriority(a.priority, b.priority);
    if (priorityDiff !== 0) return priorityDiff;
    return new Date(a.proposedAt).getTime() - new Date(b.proposedAt).getTime();
  });
}

/**
 * Select the highest-priority candidate from a list.
 * Returns null if list is empty.
 * Deterministic: same input always yields same output.
 */
export function selectHighestPriorityCandidate<T extends { priority: ImprovementPriority; proposedAt: string }>(
  candidates: T[],
): T | null {
  if (candidates.length === 0) return null;
  const sorted = sortCandidatesForSelection(candidates);
  return sorted[0];
}

/**
 * Valid status transitions for improvement candidates.
 * Explicit lifecycle - no implicit transitions.
 */
export const VALID_STATUS_TRANSITIONS: Record<ImprovementCandidateStatus, ImprovementCandidateStatus[]> = {
  proposed: ["under_review", "rejected", "superseded"],
  under_review: ["approved", "rejected", "superseded"],
  approved: ["implemented", "rejected", "superseded"],
  rejected: ["proposed"], // Can be re-proposed with new evidence
  implemented: ["superseded"],
  superseded: [],
};

/**
 * Check if a status transition is valid.
 */
export function isValidStatusTransition(
  from: ImprovementCandidateStatus,
  to: ImprovementCandidateStatus,
): boolean {
  return VALID_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Create a new improvement candidate with all required fields.
 * Defensive copy of all input.
 */
export function createImprovementCandidate(input: {
  title: string;
  description: string;
  rationale: string;
  category: ImprovementCategory;
  targetComponent: string;
  priority: ImprovementPriority;
  proposedBy: string;
}): ImprovementCandidate {
  const now = new Date().toISOString();
  const identity = generateCandidateIdentity(
    input.title,
    input.description,
    input.rationale,
    input.category,
    input.targetComponent,
  );

  return {
    id: `imp-${identity.contentHash}`,
    identity,
    title: input.title.trim(),
    description: input.description.trim(),
    rationale: input.rationale.trim(),
    category: input.category,
    targetComponent: input.targetComponent.trim(),
    status: "proposed",
    priority: input.priority,
    proposedBy: input.proposedBy.trim(),
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
}

/**
 * Update candidate status with validation.
 * Returns new candidate object (defensive copy).
 */
export function updateCandidateStatus(
  candidate: ImprovementCandidate,
  newStatus: ImprovementCandidateStatus,
  actor: string,
  notes?: string,
): ImprovementCandidate {
  if (!isValidStatusTransition(candidate.status, newStatus)) {
    throw new Error(
      `Invalid status transition: ${candidate.status} -> ${newStatus}`,
    );
  }

  const now = new Date().toISOString();
  const updated: ImprovementCandidate = {
    ...candidate,
    status: newStatus,
    updatedAt: now,
  };

  switch (newStatus) {
    case "under_review":
      updated.reviewedAt = now;
      updated.reviewedBy = actor.trim();
      updated.reviewNotes = notes?.trim() ?? null;
      break;
    case "approved":
    case "rejected":
      updated.reviewedAt = now;
      updated.reviewedBy = actor.trim();
      updated.reviewNotes = notes?.trim() ?? null;
      break;
    case "implemented":
      updated.implementedAt = now;
      updated.implementedBy = actor.trim();
      break;
    case "superseded":
      // supersededBy set separately
      break;
  }

  return updated;
}

/**
 * Mark candidate as superseded by another candidate.
 */
export function supersedeCandidate(
  candidate: ImprovementCandidate,
  supersedingCandidateId: string,
): ImprovementCandidate {
  if (candidate.status === "superseded") {
    return candidate; // Idempotent
  }
  return {
    ...candidate,
    status: "superseded",
    supersededBy: supersedingCandidateId,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Improvement backlog interface for storage/retrieval.
 */
export interface ImprovementBacklog {
  add(candidate: ImprovementCandidate): Promise<void>;
  get(id: string): Promise<ImprovementCandidate | null>;
  list(query?: {
    status?: ImprovementCandidateStatus;
    category?: ImprovementCategory;
    targetComponent?: string;
    priority?: ImprovementPriority;
    limit?: number;
  }): Promise<ImprovementCandidate[]>;
  update(candidate: ImprovementCandidate): Promise<void>;
  remove(id: string): Promise<void>;
}

/**
 * In-memory implementation for testing.
 */
export class InMemoryImprovementBacklog implements ImprovementBacklog {
  private candidates = new Map<string, ImprovementCandidate>();

  async add(candidate: ImprovementCandidate): Promise<void> {
    // Defensive copy
    this.candidates.set(candidate.id, { ...candidate });
  }

  async get(id: string): Promise<ImprovementCandidate | null> {
    const candidate = this.candidates.get(id);
    return candidate ? { ...candidate } : null; // Defensive copy
  }

  async list(query?: {
    status?: ImprovementCandidateStatus;
    category?: ImprovementCategory;
    targetComponent?: string;
    priority?: ImprovementPriority;
    limit?: number;
  }): Promise<ImprovementCandidate[]> {
    let results = Array.from(this.candidates.values()).map((c) => ({ ...c })); // Defensive copies

    if (query?.status) {
      results = results.filter((c) => c.status === query.status);
    }
    if (query?.category) {
      results = results.filter((c) => c.category === query.category);
    }
    if (query?.targetComponent) {
      results = results.filter((c) => c.targetComponent === query.targetComponent);
    }
    if (query?.priority) {
      results = results.filter((c) => c.priority === query.priority);
    }

    // Sort by priority then proposedAt
    results = sortCandidatesForSelection(results);

    if (query?.limit) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  async update(candidate: ImprovementCandidate): Promise<void> {
    if (!this.candidates.has(candidate.id)) {
      throw new Error(`Candidate ${candidate.id} not found`);
    }
    this.candidates.set(candidate.id, { ...candidate }); // Defensive copy
  }

  async remove(id: string): Promise<void> {
    this.candidates.delete(id);
  }
}