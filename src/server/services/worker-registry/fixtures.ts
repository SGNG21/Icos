import { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import { isoDateTimeSchema } from "@/core/contracts/common";

/**
 * Test fixtures for the worker registry.
 * These represent workers that actually exist in the codebase.
 */

/**
 * Hermes worker - represents the hermes CLI binary
 * Based on: docs/icos/handoffs/temporal-poc-worker/hermes-run.ts.txt
 */
export const hermesWorker: WorkerRegistryEntry = {
  id: "hermes-worker-001",
  workerKind: "hermes",
  displayName: "Hermes CLI Worker",
  capabilities: ["search", "information-gathering", "fact-checking", "web-search", "deep-research"],
  features: ["web-search", "deep-research"],
  supportsTools: true,
  supportsStructuredOutput: false,
  runtime: "binary",
  runtimeSupport: "SUPPORTED_RUNTIME",
  health: "unknown", // Fail-closed: we don't probe health
  availability: "unknown", // Fail-closed: we don't probe availability
  status: "active",
  tags: ["cli", "binary", "hermes"],
  metadata: {
    source: "hermes-binary",
    description: "Hermes CLI agent for information gathering"
  },
  updatedAt: isoDateTimeSchema.parse(new Date().toISOString())
};

/**
 * OpenHands worker - represents the OpenHands AI agent
 * Based on references in codebase
 */
export const openhandsWorker: WorkerRegistryEntry = {
  id: "openhands-worker-001",
  workerKind: "openhands",
  displayName: "OpenHands AI Agent",
  capabilities: ["code-generation", "code-editing", "debugging", "testing"],
  features: ["reasoning", "planning", "code-generation"],
  supportsTools: true,
  supportsStructuredOutput: true,
  runtime: "docker",
  runtimeSupport: "SUPPORTED_RUNTIME",
  health: "unknown",
  availability: "unknown",
  status: "active",
  tags: ["ai-agent", "code-editing", "openhands"],
  metadata: {
    source: "openhands-agent",
    description: "OpenHands AI agent for software engineering tasks"
  },
  updatedAt: isoDateTimeSchema.parse(new Date().toISOString())
};

/**
 * DigitalOS worker - represents the DigitalOS execution facade
 * Based on: src/server/execution/digitalos-worker.ts
 */
export const digitalosWorker: WorkerRegistryEntry = {
  id: "digitalos-worker-001",
  workerKind: "digitalos",
  displayName: "DigitalOS Execution Facade",
  capabilities: ["website.build", "website.qa", "website.heal", "website.preview"],
  features: ["website-generation", "qa", "healing", "preview"],
  supportsTools: true,
  supportsStructuredOutput: true,
  runtime: "node",
  runtimeSupport: "SUPPORTED_RUNTIME",
  health: "unknown",
  availability: "unknown",
  status: "active",
  tags: ["website", "digitalos", "facade"],
  metadata: {
    source: "digitalos-facade",
    description: "DigitalOS execution facade for website operations"
  },
  updatedAt: isoDateTimeSchema.parse(new Date().toISOString())
};

/**
 * Agent worker - represents a generic AI agent
 * Based on references in contracts and local-task-execution-dispatcher
 */
export const agentWorker: WorkerRegistryEntry = {
  id: "agent-worker-001",
  workerKind: "agent",
  displayName: "Generic AI Agent",
  capabilities: ["text-generation", "analysis", "summarization"],
  features: ["reasoning", "planning"],
  supportsTools: true,
  supportsStructuredOutput: true,
  runtime: "node",
  runtimeSupport: "SUPPORTED_RUNTIME",
  health: "unknown",
  availability: "unknown",
  status: "active",
  tags: ["generic", "ai-agent"],
  metadata: {
    source: "generic-agent",
    description: "Generic AI agent for text-based tasks"
  },
  updatedAt: isoDateTimeSchema.parse(new Date().toISOString())
};

/**
 * Other worker - represents the "other" worker kind used in local execution
 * Based on: src/server/execution/local-task-execution-dispatcher.ts
 */
export const otherWorker: WorkerRegistryEntry = {
  id: "other-worker-001",
  workerKind: "other",
  displayName: "Other Worker",
  capabilities: ["validation", "review", "quality-check"],
  features: ["precision"],
  supportsTools: false,
  supportsStructuredOutput: true,
  runtime: "node",
  runtimeSupport: "SUPPORTED_RUNTIME",
  health: "unknown",
  availability: "unknown",
  status: "active",
  tags: ["validation", "review"],
  metadata: {
    source: "local-dispatcher",
    description: "Worker for validation and review tasks"
  },
  updatedAt: isoDateTimeSchema.parse(new Date().toISOString())
};

/**
 * Array of all test fixtures
 */
export const testWorkers = [
  hermesWorker,
  openhandsWorker,
  digitalosWorker,
  agentWorker,
  otherWorker
];

/**
 * Map of worker IDs to workers for easy lookup
 */
export const testWorkerMap: Record<string, WorkerRegistryEntry> = Object.fromEntries(
  testWorkers.map(w => [w.id, w])
);