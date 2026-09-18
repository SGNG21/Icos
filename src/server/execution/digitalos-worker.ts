/**
 * DigitalOS Worker - Adapter ICOS
 *
 * Wraps DigitalOS Execution Facade without reimplementing any logic.
 * Maps ICOS Task/execution context -> DigitalOS ExecutionInput -> ExecutionResult -> ICOS TaskExecutionResult
 *
 * FAIL-CLOSED: unsupported capability -> INVALID_INPUT
 * No business logic copied from DigitalOS.
 */

import type { FacadeModule } from "./digitalos-facade-types";

import {
  ExecutionInput,
  ExecutionResult,
  ExecutionError as DigitalOSExecutionError,
  Artifact,
  Evidence,
  Finding,
} from "./digitalos-contracts";
import type { ExecutionError as IcosExecutionError } from "@/core/contracts";

// ============================================================
// ICOS → DigitalOS Input Mapping
// ============================================================

export interface DigitalOSWorkerInput {
  taskId: string;
  workflowId: string;
  capability: string;
  prompt: string;
  projectId: string;
  missionId?: string;
  client?: Record<string, unknown>;
  slots?: Record<string, unknown>;
  options?: {
    root?: string;
    baseDir?: string; // DigitalOS project root (where usine/premium-starter exists)
    baseUrl?: string;
    previewPort?: number;
    healMaxPasses?: number;
  };
  digitalosFacadePath?: string;
}

export interface DigitalOSWorkerResult {
  outcome: "success" | "blocked" | "failure";
  result?: string;
  error?: IcosExecutionError;
  digitalosExecutionId?: string;
  artifacts: Artifact[];
  evidence: Evidence[];
  findings: Finding[];
  startedAt: string;
  completedAt: string;
}

/**
 * Map DigitalOS error code to ICOS error code
 */
function mapDigitalOSErrorToIcos(
  digitalError: DigitalOSExecutionError | undefined,
): IcosExecutionError | undefined {
  if (!digitalError) return undefined;

  const codeMap: Record<string, IcosExecutionError["code"]> = {
    INVALID_INPUT: "INVALID_RESULT",
    BUILD_FAILED: "WORKER_FAILED",
    QA_BLOCKED: "WORKER_FAILED",
    HEAL_FAILED: "WORKER_FAILED",
    PREVIEW_FAILED: "WORKER_FAILED",
    INTERNAL_ERROR: "INTERNAL_ERROR",
  };

  return {
    code: codeMap[digitalError.code] ?? "INTERNAL_ERROR",
    message: digitalError.message,
  };
}

/**
 * Map ICOS execution context to DigitalOS ExecutionInput
 */
export function mapToDigitalOSInput(input: DigitalOSWorkerInput): ExecutionInput {
  return {
    executionId: input.workflowId,
    projectId: input.projectId,
    missionId: input.missionId,
    capability: input.capability as ExecutionInput["capability"],
    client: input.client,
    slots: input.slots,
    options: {
      root: input.options?.root || ".",
      baseDir: input.options?.baseDir,
      previewPort: input.options?.previewPort || 4180,
      healMaxPasses: input.options?.healMaxPasses || 2,
      ...input.options,
    },
    // startedAt is set by facade internally
  };
}

/**
 * Map DigitalOS ExecutionResult to ICOS worker result
 */
export function mapFromDigitalOSResult(digitalResult: ExecutionResult): DigitalOSWorkerResult {
  const outcomeMap: Record<string, "success" | "blocked" | "failure"> = {
    success: "success",
    blocked: "blocked",
    failure: "failure",
  };

  return {
    outcome: outcomeMap[digitalResult.status] ?? "failure",
    result: digitalResult.result ? JSON.stringify(digitalResult.result) : undefined,
    error: mapDigitalOSErrorToIcos(digitalResult.error),
    digitalosExecutionId: digitalResult.executionId,
    artifacts: digitalResult.artifacts,
    evidence: digitalResult.evidence,
    findings: digitalResult.findings,
    startedAt: digitalResult.startedAt,
    completedAt: digitalResult.completedAt,
  };
}

/**
 * DigitalOS Worker - wraps the facade
 */
export class DigitalOSWorker {
  private facade: { execute: (input: ExecutionInput) => Promise<ExecutionResult> } | null = null;
  private facadeModule: FacadeModule | null = null;

  constructor() {}

  /**
   * Initialize with facade (lazy to avoid importing DigitalOS at module load if not needed)
   */
  private async getFacade(
    facadePath?: string,
    baseDir?: string,
  ): Promise<{
    execute: (input: ExecutionInput) => Promise<ExecutionResult>;
  } | null> {
    if (!this.facade) {
      // Dynamic import to avoid coupling at build time if DigitalOS not available
      if (!facadePath) {
        return null;
      }
      try {
        this.facadeModule = (await import(facadePath)) as FacadeModule;
        this.facade = new this.facadeModule.DigitalOSExecutionFacade(baseDir);
      } catch {
        // Failed to load facade - will be handled in execute()
        return null;
      }
    }
    return this.facade;
  }

  /**
   * Execute a capability
   */
  async execute(input: DigitalOSWorkerInput): Promise<DigitalOSWorkerResult> {
    const facade = await this.getFacade(input.digitalosFacadePath, input.options?.baseDir);

    // Validate capability is supported
    const supportedCapabilities = [
      "website.build",
      "website.qa",
      "website.heal",
      "website.preview",
    ] as const;
    if (
      !supportedCapabilities.includes(input.capability as (typeof supportedCapabilities)[number])
    ) {
      return {
        outcome: "failure",
        error: {
          code: "INVALID_RESULT",
          message: `Unsupported capability: ${input.capability}. Supported: ${supportedCapabilities.join(", ")}`,
        },
        digitalosExecutionId: undefined,
        artifacts: [],
        evidence: [],
        findings: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }

    // Check if facade is available
    if (!facade) {
      return {
        outcome: "failure",
        error: {
          code: "WORKER_UNAVAILABLE",
          message:
            "DigitalOS facade not available (DIGITALOS_FACADE_PATH not configured or failed to load)",
        },
        digitalosExecutionId: undefined,
        artifacts: [],
        evidence: [],
        findings: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }

    // Map to DigitalOS input
    const digitalInput = mapToDigitalOSInput(input);

    // Execute via facade
    const digitalResult = await facade.execute(digitalInput);

    // Map back to ICOS format
    return mapFromDigitalOSResult(digitalResult);
  }
}
