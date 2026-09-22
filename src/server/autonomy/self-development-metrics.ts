import type { SelfDevelopmentMetricsPort, SelfDevelopmentMetricsSnapshot } from "@/core/contracts/self-development";
import { selfDevelopmentMetricsSnapshotSchema } from "@/core/contracts/self-development";

export class SelfDevelopmentMetrics implements SelfDevelopmentMetricsPort {
  private cyclesTotal = 0;
  private candidatesProcessed = 0;
  private repairsAttempted = 0;
  private repairsAccepted = 0;
  private repairsRejected = 0;
  private repairsExhausted = 0;
  private humanEscalations = 0;
  private patternsLearned = 0;

  recordCycle(): void {
    this.cyclesTotal += 1;
  }

  recordCandidateProcessed(): void {
    this.candidatesProcessed += 1;
  }

  recordRepairAttempted(): void {
    this.repairsAttempted += 1;
  }

  recordRepairAccepted(): void {
    this.repairsAccepted += 1;
  }

  recordRepairRejected(): void {
    this.repairsRejected += 1;
  }

  recordRepairExhausted(): void {
    this.repairsExhausted += 1;
  }

  recordHumanEscalation(): void {
    this.humanEscalations += 1;
  }

  recordPatternLearned(): void {
    this.patternsLearned += 1;
  }

  getSnapshot(): SelfDevelopmentMetricsSnapshot {
    const snapshot = {
      cyclesTotal: this.cyclesTotal,
      candidatesProcessed: this.candidatesProcessed,
      repairsAttempted: this.repairsAttempted,
      repairsAccepted: this.repairsAccepted,
      repairsRejected: this.repairsRejected,
      repairsExhausted: this.repairsExhausted,
      humanEscalations: this.humanEscalations,
      patternsLearned: this.patternsLearned,
      capturedAt: new Date().toISOString(),
    };

    return selfDevelopmentMetricsSnapshotSchema.parse(snapshot);
  }

  reset(): void {
    this.cyclesTotal = 0;
    this.candidatesProcessed = 0;
    this.repairsAttempted = 0;
    this.repairsAccepted = 0;
    this.repairsRejected = 0;
    this.repairsExhausted = 0;
    this.humanEscalations = 0;
    this.patternsLearned = 0;
  }
}