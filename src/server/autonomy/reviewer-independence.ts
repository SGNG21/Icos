import type { WorkerRegistryPort, WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import type { ReviewInput, ReviewDecision, ReviewDecisionRecord } from "@/server/review/ports";

export interface ReviewerIdentity {
  workerId: string;
  workerKind: string;
  source: "worker-registry" | "unknown";
}

export interface ReviewerIndependenceCheck {
  isIndependent: boolean;
  producerIdentity: ReviewerIdentity;
  reviewerIdentity: ReviewerIdentity | null;
  reason: string;
  evidence: ReviewIndependenceEvidence;
}

export interface ReviewIndependenceEvidence {
  producerWorkerId: string;
  reviewerWorkerId: string | null;
  producerWorkerKind: string;
  reviewerWorkerKind: string | null;
  sameWorkerId: boolean;
  sameWorkerKind: boolean;
  reviewerIdentityVerified: boolean;
  producerIdentityVerified: boolean;
}

export interface ReviewerIndependenceOptions {
  workerRegistry: WorkerRegistryPort;
  producerWorkerId: string;
  reviewerWorkerId?: string | null;
}

export class ReviewerIndependenceChecker {
  private readonly workerRegistry: WorkerRegistryPort;
  private readonly producerWorkerId: string;
  private readonly reviewerWorkerId: string | null;

  constructor(options: ReviewerIndependenceOptions) {
    this.workerRegistry = options.workerRegistry;
    this.producerWorkerId = options.producerWorkerId;
    this.reviewerWorkerId = options.reviewerWorkerId ?? null;
  }

  private getWorkerIdentity(workerId: string | null): ReviewerIdentity | null {
    if (!workerId) {
      return null;
    }
    
    const worker = this.workerRegistry.getWorker(workerId);
    if (!worker) {
      return {
        workerId,
        workerKind: "unknown",
        source: "unknown",
      };
    }
    
    return {
      workerId: worker.id,
      workerKind: worker.workerKind,
      source: "worker-registry",
    };
  }

  check(reviewInput?: ReviewInput): ReviewerIndependenceCheck {
    const producerIdentity = this.getWorkerIdentity(this.producerWorkerId);
    const reviewerIdentity = this.getWorkerIdentity(this.reviewerWorkerId);

    if (!producerIdentity) {
      return {
        isIndependent: false,
        producerIdentity: {
          workerId: this.producerWorkerId,
          workerKind: "unknown",
          source: "unknown",
        },
        reviewerIdentity,
        reason: "Producer identity missing or unknown",
        evidence: this.buildEvidence(producerIdentity, reviewerIdentity),
      };
    }

    if (!reviewerIdentity) {
      return {
        isIndependent: false,
        producerIdentity,
        reviewerIdentity: null,
        reason: "Reviewer identity missing or unknown",
        evidence: this.buildEvidence(producerIdentity, reviewerIdentity),
      };
    }

    // Check if reviewer identity is verified (exists in registry)
    const reviewerVerified = reviewerIdentity.source === "worker-registry";
    const producerVerified = producerIdentity.source === "worker-registry";

    if (!reviewerVerified) {
      return {
        isIndependent: false,
        producerIdentity,
        reviewerIdentity,
        reason: "Reviewer identity not verified in worker registry",
        evidence: this.buildEvidence(producerIdentity, reviewerIdentity, reviewerVerified, producerVerified),
      };
    }

    if (!producerVerified) {
      return {
        isIndependent: false,
        producerIdentity,
        reviewerIdentity,
        reason: "Producer identity not verified in worker registry",
        evidence: this.buildEvidence(producerIdentity, reviewerIdentity, reviewerVerified, producerVerified),
      };
    }

    // Check for self-review (same worker ID)
    const sameWorkerId = producerIdentity.workerId === reviewerIdentity.workerId;
    const sameWorkerKind = producerIdentity.workerKind === reviewerIdentity.workerKind;

    if (sameWorkerId) {
      return {
        isIndependent: false,
        producerIdentity,
        reviewerIdentity,
        reason: `Self-review denied: producer and reviewer are the same worker (${producerIdentity.workerId})`,
        evidence: this.buildEvidence(producerIdentity, reviewerIdentity, reviewerVerified, producerVerified),
      };
    }

    // Check for same worker kind (weaker check - could be different instances)
    // Note: We allow same kind if different worker IDs (e.g., multiple hermes workers)
    // but log it for audit purposes

    return {
      isIndependent: true,
      producerIdentity,
      reviewerIdentity,
      reason: "Reviewer is independent from producer",
      evidence: this.buildEvidence(producerIdentity, reviewerIdentity, reviewerVerified, producerVerified),
    };
  }

  private buildEvidence(
    producerIdentity: ReviewerIdentity | null,
    reviewerIdentity: ReviewerIdentity | null,
    reviewerVerified: boolean = false,
    producerVerified: boolean = false
  ): ReviewIndependenceEvidence {
    return {
      producerWorkerId: producerIdentity?.workerId ?? this.producerWorkerId,
      reviewerWorkerId: reviewerIdentity?.workerId ?? this.reviewerWorkerId,
      producerWorkerKind: producerIdentity?.workerKind ?? "unknown",
      reviewerWorkerKind: reviewerIdentity?.workerKind ?? "unknown",
      sameWorkerId: producerIdentity?.workerId === reviewerIdentity?.workerId,
      sameWorkerKind: producerIdentity?.workerKind === reviewerIdentity?.workerKind,
      reviewerIdentityVerified: reviewerVerified,
      producerIdentityVerified: producerVerified,
    };
  }
}

export interface IndependentReviewerSelectionResult {
  success: boolean;
  reviewerWorkerId?: string;
  reason: string;
  decision: "SELECTED" | "HUMAN_DECISION_REQUIRED" | "NO_ELIGIBLE_REVIEWERS";
}

export class IndependentReviewerSelector {
  private readonly workerRegistry: WorkerRegistryPort;
  private readonly producerWorkerId: string;
  private readonly requiredCapabilities?: string[];

  constructor(
    workerRegistry: WorkerRegistryPort,
    producerWorkerId: string,
    requiredCapabilities?: string[]
  ) {
    this.workerRegistry = workerRegistry;
    this.producerWorkerId = producerWorkerId;
    this.requiredCapabilities = requiredCapabilities;
  }

  select(): IndependentReviewerSelectionResult {
    const producerWorker = this.workerRegistry.getWorker(this.producerWorkerId);
    
    if (!producerWorker) {
      return {
        success: false,
        reason: `Producer worker ${this.producerWorkerId} not found in registry`,
        decision: "HUMAN_DECISION_REQUIRED",
      };
    }

    const allWorkers = this.workerRegistry.listWorkers();
    
    // Filter eligible reviewers: active, supported runtime, healthy, available
    const eligibleReviewers = allWorkers.filter((worker) => {
      if (worker.id === this.producerWorkerId) {
        return false; // Cannot be the same worker
      }
      
      if (worker.status !== "active") {
        return false;
      }
      
      if (worker.runtimeSupport !== "SUPPORTED_RUNTIME") {
        return false;
      }
      
      // Fail closed: ONLY "healthy" is acceptable, UNKNOWN is ineligible
      if (worker.health !== "healthy") {
        return false;
      }
      
      // Fail closed: ONLY "available" is acceptable, UNKNOWN is ineligible
      if (worker.availability !== "available") {
        return false;
      }
      
      if (this.requiredCapabilities && this.requiredCapabilities.length > 0) {
        const hasAllCapabilities = this.requiredCapabilities.every(
          (cap) => worker.capabilities.includes(cap)
        );
        if (!hasAllCapabilities) {
          return false;
        }
      }
      
      return true;
    });

    if (eligibleReviewers.length === 0) {
      return {
        success: false,
        reason: `No independent reviewers available for producer ${this.producerWorkerId} (${producerWorker.workerKind}) with capabilities: ${this.requiredCapabilities?.join(", ") ?? "any"}`,
        decision: "NO_ELIGIBLE_REVIEWERS",
      };
    }

    // Select first eligible reviewer (deterministic: sorted by ID)
    const selectedReviewer = eligibleReviewers
      .sort((a, b) => a.id.localeCompare(b.id))[0];

    return {
      success: true,
      reviewerWorkerId: selectedReviewer.id,
      reason: `Selected independent reviewer ${selectedReviewer.id} (${selectedReviewer.workerKind}) for producer ${this.producerWorkerId}`,
      decision: "SELECTED",
    };
  }
}

export function assertReviewerIndependence(
  check: ReviewerIndependenceCheck,
  context: string = "Review"
): void {
  if (!check.isIndependent) {
    const errorMessage = `${context} blocked: ${check.reason}`;
    // This is a fail-closed assertion - throws to prevent invalid review
    throw new Error(errorMessage);
  }
}

export function requireIndependentReviewer(
  check: ReviewerIndependenceCheck,
  context: string = "Review"
): ReviewerIdentity {
  if (!check.isIndependent) {
    throw new Error(`${context} requires independent reviewer: ${check.reason}`);
  }
  
  if (!check.reviewerIdentity) {
    throw new Error(`${context} requires reviewer identity but none provided`);
  }
  
  return check.reviewerIdentity;
}