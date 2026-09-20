import { WorkerCandidate, ModelCandidate, ProviderCandidate } from "@/core/contracts/ai-selection";

/**
 * In-memory deterministic AI resource catalog.
 * For Phase 8B, we use a hardcoded catalog that can be replaced later by a dynamic one (e.g., from OmniRoute).
 */
export class AIResourceCatalog {
  private workers: WorkerCandidate[];
  private models: ModelCandidate[];
  private providers: ProviderCandidate[];

  constructor() {
    // Initialize with some deterministic data for testing
    this.workers = [
      {
        workerKind: "agent",
        capabilities: ["text-generation", "analysis", "summarization"],
        supportsTools: true,
        supportsStructuredOutput: true,
        typicalLatencyMs: 1000,
        typicalCostPerUnit: 0.0001,
        contextWindow: 4096,
        reliability: 0.95,
        quality: 0.9,
        features: ["reasoning", "planning"],
      },
      {
        workerKind: "other",
        capabilities: ["validation", "review", "quality-check"],
        supportsTools: false,
        supportsStructuredOutput: true,
        typicalLatencyMs: 500,
        typicalCostPerUnit: 0.00005,
        contextWindow: 2048,
        reliability: 0.98,
        quality: 0.85,
        features: ["precision"],
      },
      {
        workerKind: "hermes",
        capabilities: ["search", "information-gathering", "fact-checking"],
        supportsTools: true,
        supportsStructuredOutput: false,
        typicalLatencyMs: 2000,
        typicalCostPerUnit: 0.0002,
        contextWindow: 8192,
        reliability: 0.9,
        quality: 0.8,
        features: ["web-search", "deep-research"],
      },
    ];

    this.models = [
      {
        modelId: "gpt-4",
        provider: "openai",
        capabilities: ["text-generation", "analysis", "summarization"],
        supportsTools: true,
        supportsStructuredOutput: true,
        contextWindow: 8192,
        typicalLatencyMs: 1500,
        typicalCostPerUnit: 0.0002,
        reliability: 0.95,
        quality: 0.95,
        features: ["vision", "function_calling"],
      },
      {
        modelId: "gpt-3.5-turbo",
        provider: "openai",
        capabilities: ["text-generation", "analysis"],
        supportsTools: true,
        supportsStructuredOutput: true,
        contextWindow: 4096,
        typicalLatencyMs: 1000,
        typicalCostPerUnit: 0.0001,
        reliability: 0.9,
        quality: 0.85,
        features: ["function_calling"],
      },
      {
        modelId: "claude-3-opus",
        provider: "anthropic",
        capabilities: ["text-generation", "analysis", "summarization"],
        supportsTools: true,
        supportsStructuredOutput: true,
        contextWindow: 200000,
        typicalLatencyMs: 2000,
        typicalCostPerUnit: 0.0003,
        reliability: 0.96,
        quality: 0.96,
        features: ["vision"],
      },
      {
        modelId: "claude-3-sonnet",
        provider: "anthropic",
        capabilities: ["text-generation", "analysis"],
        supportsTools: true,
        supportsStructuredOutput: true,
        contextWindow: 200000,
        typicalLatencyMs: 1500,
        typicalCostPerUnit: 0.0002,
        reliability: 0.94,
        quality: 0.93,
        features: ["vision"],
      },
      {
        modelId: "llama-3-70b",
        provider: "nvidia",
        capabilities: ["text-generation", "analysis"],
        supportsTools: false,
        supportsStructuredOutput: false,
        contextWindow: 8192,
        typicalLatencyMs: 1000,
        typicalCostPerUnit: 0.00005,
        reliability: 0.88,
        quality: 0.85,
        features: [],
      },
    ];

    this.providers = [
      {
        providerId: "openai",
        health: 0.99,
        isAvailable: true,
        offeredModels: ["gpt-4", "gpt-3.5-turbo"],
        trust: 0.9,
        security: 0.85,
      },
      {
        providerId: "anthropic",
        health: 0.97,
        isAvailable: true,
        offeredModels: ["claude-3-opus", "claude-3-sonnet"],
        trust: 0.92,
        security: 0.9,
      },
      {
        providerId: "nvidia",
        health: 0.95,
        isAvailable: true,
        offeredModels: ["llama-3-70b"],
        trust: 0.85,
        security: 0.8,
      },
    ];
  }

  /**
   * List all worker kinds.
   */
  listWorkers(): WorkerCandidate[] {
    return [...this.workers]; // return a copy
  }

  /**
   * List all models.
   */
  listModels(): ModelCandidate[] {
    return [...this.models];
  }

  /**
   * List all providers.
   */
  listProviders(): ProviderCandidate[] {
    return [...this.providers];
  }

  /**
   * Get capabilities for a specific worker kind.
   */
  getWorkerCapabilities(workerKind: string): string[] {
    const worker = this.workers.find((w) => w.workerKind === workerKind);
    return worker ? [...worker.capabilities] : [];
  }

  /**
   * Get capabilities for a specific model from a provider.
   */
  getModelCapabilities(modelId: string, providerId: string): string[] {
    const model = this.models.find(
      (m) => m.modelId === modelId && m.provider === providerId
    );
    return model ? [...model.capabilities] : [];
  }

  /**
   * Get health score for a provider (0-1).
   */
  getProviderHealth(providerId: string): number {
    const provider = this.providers.find((p) => p.providerId === providerId);
    return provider ? provider.health : 0;
  }

  /**
   * Check if a provider is available.
   */
  isProviderAvailable(providerId: string): boolean {
    const provider = this.providers.find((p) => p.providerId === providerId);
    return provider ? provider.isAvailable : false;
  }

  /**
   * Check if a model is offered by a provider.
   */
  isModelOffered(modelId: string, providerId: string): boolean {
    const provider = this.providers.find((p) => p.providerId === providerId);
    return provider ? provider.offeredModels.includes(modelId) : false;
  }
}