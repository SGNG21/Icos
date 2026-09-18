/**
 * Type declarations for DigitalOS Execution Facade
 * Provides type safety for the dynamic import of the facade module
 */

export interface DigitalOSExecutionFacade {
  execute(input: {
    executionId: string;
    projectId: string;
    capability: "website.build" | "website.qa" | "website.heal" | "website.preview";
    missionId?: string;
    client?: Record<string, unknown>;
    slots?: Record<string, unknown>;
    options?: {
      root?: string;
      baseUrl?: string;
      previewPort?: number;
      healMaxPasses?: number;
    };
  }): Promise<{
    executionId: string;
    projectId: string;
    missionId?: string;
    capability: string;
    status: "success" | "blocked" | "failure";
    artifacts: Array<{
      type: string;
      path?: string;
      url?: string;
      mediaType?: string;
      metadata?: Record<string, unknown>;
    }>;
    evidence: Array<{
      type: string;
      source: string;
      path?: string;
      url?: string;
      timestamp: string;
      metadata?: Record<string, unknown>;
    }>;
    findings: Array<{
      severity: "PASS" | "WARN" | "BLOCK";
      check: string;
      message: string;
      where?: string;
      category?: string;
      repairability?: "auto" | "content" | "human";
    }>;
    result?: Record<string, unknown>;
    error?: {
      code:
        | "INVALID_INPUT"
        | "BUILD_FAILED"
        | "QA_BLOCKED"
        | "HEAL_FAILED"
        | "PREVIEW_FAILED"
        | "INTERNAL_ERROR";
      message: string;
      details?: Record<string, unknown>;
    };
    startedAt: string;
    completedAt: string;
  }>;
}

export interface FacadeModule {
  DigitalOSExecutionFacade: new (baseDir?: string) => DigitalOSExecutionFacade;
}
