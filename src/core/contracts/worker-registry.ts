import { z } from "zod";
import { workerKindSchema } from "./task-execution";
import { capabilityKeySchema } from "./capability";
import { isoDateTimeSchema } from "./common";

/** Descriptor of a worker's runtime (e.g., "node", "docker", "binary", "wasm", "unknown"). */
export const workerRuntimeDescriptorSchema = z.enum(["node", "docker", "binary", "wasm", "unknown"]);
export type WorkerRuntimeDescriptor = z.infer<typeof workerRuntimeDescriptorSchema>;

/** Health status of a worker. */
export const workerHealthSchema = z.enum(["healthy", "degraded", "unhealthy", "unknown"]);
export type WorkerHealth = z.infer<typeof workerHealthSchema>;

/** Availability of a worker. */
export const workerAvailabilitySchema = z.enum(["available", "unavailable", "unknown"]);
export type WorkerAvailability = z.infer<typeof workerAvailabilitySchema>;

/** Descriptor of a worker's capability (we reuse the capability key). */
export type WorkerCapabilityDescriptor = z.infer<typeof capabilityKeySchema>;

/** Descriptor of a worker's features (free-form strings, e.g., "reasoning", "vision"). */
export const workerFeatureSchema = z.string();
export type WorkerFeature = z.infer<typeof workerFeatureSchema>;

/** Descriptor of a worker's tags (free-form strings for categorization). */
export const workerTagSchema = z.string();
export type WorkerTag = z.infer<typeof workerTagSchema>;

/** Metadata for a worker (free-form key-value pairs). */
export const workerMetadataSchema = z.record(z.string(), z.string());
export type WorkerMetadata = z.infer<typeof workerMetadataSchema>;

/** A single entry in the worker registry. */
export const workerRegistryEntrySchema = z.object({
  /** Unique identifier of the worker. */
  id: z.string().uuid(),
  /** Kind of worker (e of worker (e.g., "agent", "hermes", "openhands"). */
  workerKind: workerKindSchema,
  /** Human-readable name. */
  displayName: z.string().min(1),
  /** List of capabilities this worker can handle (as capability keys). */
  capabilities: z.array(capabilityKeySchema).default([]),
  /** List of features this worker supports. */
  features: z.array(workerFeatureSchema).default([]),
  /** Whether this worker supports tool usage. */
  supportsTools: z.boolean().default(false),
  /** Whether this worker supports structured output (JSON). */
  supportsStructuredOutput: z.boolean().default(false),
  /** Current status of the worker. */
  status: z.enum(["active", "inactive", "maintenance"]).default("active"),
  /** Runtime environment. */
  runtime: workerRuntimeDescriptorSchema,
  /** Descriptor of a worker's runtime support. */
  runtimeSupport: z.enum(["SUPPORTED_RUNTIME", "DECLARED_ONLY", "UNKNOWN"]).default("UNKNOWN"),
  /** Current health status. */
  health: workerHealthSchema.default("unknown"),
  /** Current availability. */
  availability: workerAvailabilitySchema.default("unknown"),
  /** List of tags for categorization. */
  tags: z.array(workerTagSchema).default([]),
  /** Additional metadata. */
  metadata: workerMetadataSchema.default({}),
  /** Last update timestamp. */
  updatedAt: isoDateTimeSchema,
});

export type WorkerRegistryEntry = z.infer<typeof workerRegistryEntrySchema>;

/** Descriptor of a worker's runtime (for mapping to WorkerCandidate). */
export const workerRuntimeDescriptorToString = (runtime: WorkerRuntimeDescriptor): string => {
  return runtime;
};

/** Port abstraction for the worker registry. */
export interface WorkerRegistryPort {
  /** List all registered workers. */
  listWorkers(): WorkerRegistryEntry[];
  /** Get a worker by its ID. */
  getWorker(id: string): WorkerRegistryEntry | undefined;
  /** Get workers by their kind. */
  getByKind(workerKind: string): WorkerRegistryEntry[];
  /** Returns a deterministic snapshot of the registry state. */
  snapshot(): WorkerRegistryEntry[];
}