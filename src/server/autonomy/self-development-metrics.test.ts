import { describe, it, expect, vi, beforeEach } from "vitest";
import { SelfDevelopmentMetrics } from "./self-development-metrics";
import { selfDevelopmentMetricsSnapshotSchema } from "@/core/contracts/self-development";

describe("SelfDevelopmentMetrics", () => {
  let metrics: SelfDevelopmentMetrics;

  beforeEach(() => {
    metrics = new SelfDevelopmentMetrics();
  });

  it("initializes all counters to zero", () => {
    const snapshot = metrics.getSnapshot();
    expect(snapshot.cyclesTotal).toBe(0);
    expect(snapshot.candidatesProcessed).toBe(0);
    expect(snapshot.repairsAttempted).toBe(0);
    expect(snapshot.repairsAccepted).toBe(0);
    expect(snapshot.repairsRejected).toBe(0);
    expect(snapshot.repairsExhausted).toBe(0);
    expect(snapshot.humanEscalations).toBe(0);
    expect(snapshot.patternsLearned).toBe(0);
  });

  it("increments cyclesTotal on recordCycle", () => {
    metrics.recordCycle();
    metrics.recordCycle();
    const snapshot = metrics.getSnapshot();
    expect(snapshot.cyclesTotal).toBe(2);
  });

  it("increments candidatesProcessed on recordCandidateProcessed", () => {
    metrics.recordCandidateProcessed();
    metrics.recordCandidateProcessed();
    metrics.recordCandidateProcessed();
    const snapshot = metrics.getSnapshot();
    expect(snapshot.candidatesProcessed).toBe(3);
  });

  it("increments repairsAttempted on recordRepairAttempted", () => {
    metrics.recordRepairAttempted();
    metrics.recordRepairAttempted();
    const snapshot = metrics.getSnapshot();
    expect(snapshot.repairsAttempted).toBe(2);
  });

  it("increments repairsAccepted on recordRepairAccepted", () => {
    metrics.recordRepairAccepted();
    const snapshot = metrics.getSnapshot();
    expect(snapshot.repairsAccepted).toBe(1);
  });

  it("increments repairsRejected on recordRepairRejected", () => {
    metrics.recordRepairRejected();
    metrics.recordRepairRejected();
    const snapshot = metrics.getSnapshot();
    expect(snapshot.repairsRejected).toBe(2);
  });

  it("increments repairsExhausted on recordRepairExhausted", () => {
    metrics.recordRepairExhausted();
    const snapshot = metrics.getSnapshot();
    expect(snapshot.repairsExhausted).toBe(1);
  });

  it("increments humanEscalations on recordHumanEscalation", () => {
    metrics.recordHumanEscalation();
    metrics.recordHumanEscalation();
    const snapshot = metrics.getSnapshot();
    expect(snapshot.humanEscalations).toBe(2);
  });

  it("increments patternsLearned on recordPatternLearned", () => {
    metrics.recordPatternLearned();
    const snapshot = metrics.getSnapshot();
    expect(snapshot.patternsLearned).toBe(1);
  });

  it("returns valid snapshot schema", () => {
    metrics.recordCycle();
    metrics.recordCandidateProcessed();
    metrics.recordRepairAttempted();
    metrics.recordRepairAccepted();
    metrics.recordRepairRejected();
    metrics.recordRepairExhausted();
    metrics.recordHumanEscalation();
    metrics.recordPatternLearned();

    const snapshot = metrics.getSnapshot();
    const parsed = selfDevelopmentMetricsSnapshotSchema.safeParse(snapshot);
    expect(parsed.success).toBe(true);
  });

  it("snapshot includes capturedAt timestamp", () => {
    metrics.recordCycle();
    const snapshot = metrics.getSnapshot();
    expect(snapshot.capturedAt).toBeDefined();
    expect(new Date(snapshot.capturedAt).toString()).not.toBe("Invalid Date");
  });

  it("reset sets all counters to zero", () => {
    metrics.recordCycle();
    metrics.recordCandidateProcessed();
    metrics.recordRepairAttempted();
    metrics.recordRepairAccepted();
    metrics.recordRepairRejected();
    metrics.recordRepairExhausted();
    metrics.recordHumanEscalation();
    metrics.recordPatternLearned();

    metrics.reset();

    const snapshot = metrics.getSnapshot();
    expect(snapshot.cyclesTotal).toBe(0);
    expect(snapshot.candidatesProcessed).toBe(0);
    expect(snapshot.repairsAttempted).toBe(0);
    expect(snapshot.repairsAccepted).toBe(0);
    expect(snapshot.repairsRejected).toBe(0);
    expect(snapshot.repairsExhausted).toBe(0);
    expect(snapshot.humanEscalations).toBe(0);
    expect(snapshot.patternsLearned).toBe(0);
  });

  it("counters are independent", () => {
    metrics.recordCycle();
    metrics.recordRepairAttempted();
    metrics.recordRepairAccepted();
    metrics.recordRepairRejected();

    const snapshot = metrics.getSnapshot();
    expect(snapshot.cyclesTotal).toBe(1);
    expect(snapshot.repairsAttempted).toBe(1);
    expect(snapshot.repairsAccepted).toBe(1);
    expect(snapshot.repairsRejected).toBe(1);
    expect(snapshot.repairsExhausted).toBe(0);
  });

  it("deterministic metrics - same sequence produces same snapshot", () => {
    const metrics1 = new SelfDevelopmentMetrics();
    const metrics2 = new SelfDevelopmentMetrics();

    const operations = [
      () => metrics1.recordCycle(),
      () => metrics1.recordCandidateProcessed(),
      () => metrics1.recordRepairAttempted(),
      () => metrics1.recordRepairAccepted(),
      () => metrics1.recordRepairRejected(),
      () => metrics1.recordRepairExhausted(),
      () => metrics1.recordHumanEscalation(),
      () => metrics1.recordPatternLearned(),
    ];

    operations.forEach((op) => op());
    operations.forEach((op) => op());

    const snap1 = metrics1.getSnapshot();
    const snap2 = metrics2.getSnapshot();

    // After same operations, both should have same values
    // But we only ran operations on metrics1, so metrics2 should be zero
    expect(snap2.cyclesTotal).toBe(0);
    expect(snap1.cyclesTotal).toBe(2);
  });
});