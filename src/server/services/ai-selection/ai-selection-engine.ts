import { TaskRequirements, SelectionPolicy, SelectionConstraints, WorkerCandidate, ModelCandidate, ProviderCandidate, SelectionScore, RejectedCandidate, SelectionDecision, FallbackPlan, AIResourceCatalogPort } from "@/core/contracts/ai-selection";
import { AIResourceCatalog } from "./ai-resource-catalog";

/**
 * AI Selection Engine with hard policy filters and deterministic scoring.
 * Implements fail-closed selection for sensitive tasks.
 */
export class AISelectionEngine {
  private catalog: AIResourceCatalogPort;

  constructor(catalog: AIResourceCatalogPort = new AIResourceCatalog()) {
    this.catalog = catalog;
  }

  /**
   * Select the best worker, model, and provider for a task based on requirements and policy.
   * @param taskRequirements - What the task needs
   * @param policy - Scoring policy (weights, etc.)
   * @returns SelectionDecision with selected option, fallback, and rejections
   */
  select(
    taskRequirements: TaskRequirements,
    policy: SelectionPolicy = {
      allowFallback: true,
      weightCapabilityFit: 0.25,
      weightQuality: 0.2,
      weightReliability: 0.15,
      weightLatency: 0.1,
      weightCost: 0.1,
      weightContextHeadroom: 0.05,
      weightFeatureFit: 0.05,
      weightProviderHealth: 0.025,
      weightTrust: 0.025,
      weightProviderPreference: 0.025,
      weightModelPreference: 0.025,
    }
  ): SelectionDecision {
    // Step 1: Derive constraints from task requirements and policy
    const constraints: SelectionConstraints = {
      capabilityRequired: taskRequirements.capabilityRequired,
      sensitivity: taskRequirements.sensitivity,
      requiresTools: taskRequirements.requiresTools,
      requiresStructuredOutput: taskRequirements.requiresStructuredOutput,
      minContextWindow: taskRequirements.minContextWindow,
      maxLatencyMs: taskRequirements.maxLatencyMs,
      maxCost: taskRequirements.maxCost,
      forbiddenProviders: [...(taskRequirements.forbiddenProviders ?? [])],
      forbiddenModels: [...(taskRequirements.forbiddenModels ?? [])],
      requiredFeatures: [...(taskRequirements.requiredFeatures ?? [])],
      qualityTarget: taskRequirements.qualityTarget,
      reliabilityTarget: taskRequirements.reliabilityTarget,
      workerKindAllowed: taskRequirements.workerKindAllowed,
      workerKindPreferred: taskRequirements.workerKindPreferred,
    };

    // Step 2: Generate a deterministic snapshot of the catalog
    const snapshot = this.catalog.snapshot();

    // Step 3: Generate all possible candidates (worker + model + provider combinations) from snapshot
    const allCandidates = this.generateAllCandidates(snapshot.workers, snapshot.models, snapshot.providers);

    // Step 4: Apply hard filters (eliminate incompatible candidates)
    const { viableCandidates, rejectedCandidates } = this.applyHardFilters(
      allCandidates,
      constraints
    );

    // Step 4: If no viable candidates, return fail-closed decision
    if (viableCandidates.length === 0) {
      return this.createFailClosedDecision(
        taskRequirements,
        rejectedCandidates,
        "NO_VIABLE_CANDIDATE"
      );
    }

    // Step 5: Score the viable candidates
    const scoredCandidates = this.scoreCandidates(
      viableCandidates,
      constraints,
      policy
    );

    // Step 6: Select the best candidate (highest score)
    const bestCandidate = scoredCandidates.reduce((best, current) =>
      current.score.overall > best.score.overall ? current : best
    );

    // Step 7: Create fallback plan from remaining viable candidates (excluding the best)
    const fallbackPlan = this.createFallbackPlan(
      scoredCandidates.filter((c) => c !== bestCandidate),
      taskRequirements
    );

    // Step 8: Create the final decision
    return this.createSelectionDecision(
      bestCandidate,
      scoredCandidates,
      fallbackPlan,
      taskRequirements,
      rejectedCandidates
    );
  }

  /**
   * Generate all possible combinations of workers, models, and providers.
   * Only includes combinations where the model is actually offered by the provider.
   */
  private generateAllCandidates(
    workers: WorkerCandidate[],
    models: ModelCandidate[],
    providers: ProviderCandidate[]
  ): Array<{
    worker: WorkerCandidate;
    model: ModelCandidate;
    provider: ProviderCandidate;
  }> {
    const candidates: Array<{
      worker: WorkerCandidate;
      model: ModelCandidate;
      provider: ProviderCandidate;
    }> = [];

    for (const worker of workers) {
      for (const model of models) {
        for (const provider of providers) {
          // Only include if the provider actually offers this model
          if (provider.offeredModels.includes(model.modelId)) {
            candidates.push({ worker, model, provider });
          }
        }
      }
    }

    return candidates;
  }

  /**
     * Apply hard policy filters to eliminate incompatible candidates.
     * Returns viable candidates and rejected candidates with reasons.
     */
    private applyHardFilters(
      candidates: Array<{
        worker: WorkerCandidate;
        model: ModelCandidate;
        provider: ProviderCandidate;
      }>,
      constraints: SelectionConstraints
    ): {
      viableCandidates: Array<{
        worker: WorkerCandidate;
        model: ModelCandidate;
        provider: ProviderCandidate;
      }>;
      rejectedCandidates: RejectedCandidate[];
    } {
      const viable: Array<{
        worker: WorkerCandidate;
        model: ModelCandidate;
        provider: ProviderCandidate;
      }> = [];
      const rejected: RejectedCandidate[] = [];

      for (const candidate of candidates) {
        const { worker, model, provider } = candidate;
        const candidateId = `${worker.workerKind}-${model.modelId}-${provider.providerId}`;

        // Check 1: Capability mismatch
        if (
          !worker.capabilities.includes(constraints.capabilityRequired) &&
          !model.capabilities.includes(constraints.capabilityRequired)
        ) {
          rejected.push({
            candidateId,
            reason: "CAPABILITY_MISMATCH",
            details: `Required capability '${constraints.capabilityRequired}' not supported by worker '${worker.workerKind}' or model '${model.modelId}'`,
          });
          continue;
        }

        // Check 2: Forbidden provider
        if (constraints.forbiddenProviders.includes(provider.providerId)) {
          rejected.push({
            candidateId,
            reason: "PROVIDER_FORBIDDEN",
            details: `Provider '${provider.providerId}' is forbidden`,
          });
          continue;
        }

        // Check 3: Forbidden model
        if (constraints.forbiddenModels.includes(model.modelId)) {
          rejected.push({
            candidateId,
            reason: "MODEL_FORBIDDEN",
            details: `Model '${model.modelId}' is forbidden`,
          });
          continue;
        }

        // Check 4: Worker kind allowed (hard policy)
        if (
          (constraints.workerKindAllowed?.length ?? 0) > 0 &&
          !constraints.workerKindAllowed.includes(worker.workerKind)
        ) {
          rejected.push({
            candidateId,
            reason: "WORKER_KIND_NOT_ALLOWED",
            details: `Worker kind '${worker.workerKind}' is not allowed by task requirements`,
          });
          continue;
        }

        // Check 5: Tools required but not supported
        if (
          constraints.requiresTools &&
          !(worker.supportsTools && model.supportsTools)
        ) {
          rejected.push({
            candidateId,
            reason: "TOOLS_UNSUPPORTED",
            details: `Task requires tools but worker '${worker.workerKind}' (supportsTools: ${worker.supportsTools}) or model '${model.modelId}' (supportsTools: ${model.supportsTools}) does not support tools`,
          });
          continue;
        }

        // Check 6: Structured output required but not supported
        if (
          constraints.requiresStructuredOutput &&
          !(worker.supportsStructuredOutput && model.supportsStructuredOutput)
        ) {
          rejected.push({
            candidateId,
            reason: "STRUCTURED_OUTPUT_UNSUPPORTED",
            details: `Task requires structured output but worker '${worker.workerKind}' (supportsStructuredOutput: ${worker.supportsStructuredOutput}) or model '${model.modelId}' (supportsStructuredOutput: ${model.supportsStructuredOutput}) does not support structured output`,
          });
          continue;
        }

        // Check 7: Context window too small (use min of worker and model)
        const effectiveContextWindow = Math.min(worker.contextWindow, model.contextWindow);
        if (constraints.minContextWindow > effectiveContextWindow) {
          rejected.push({
            candidateId,
            reason: "CONTEXT_TOO_SMALL",
            details: `Required context window (${constraints.minContextWindow}) exceeds available (${effectiveContextWindow})`,
          });
          continue;
        }

        // Check 8: Quality target not met (use min of worker and model quality)
        const effectiveQuality = Math.min(worker.quality, model.quality);
        if (effectiveQuality < constraints.qualityTarget) {
          rejected.push({
            candidateId,
            reason: "QUALITY_TARGET_NOT_MET",
            details: `Effective quality (${effectiveQuality}) is below target (${constraints.qualityTarget})`,
          });
          continue;
        }

        // Check 9: Reliability target not met (use min of worker and model reliability)
        const effectiveReliability = Math.min(worker.reliability, model.reliability);
        if (effectiveReliability < constraints.reliabilityTarget) {
          rejected.push({
            candidateId,
            reason: "RELIABILITY_TARGET_NOT_MET",
            details: `Effective reliability (${effectiveReliability}) is below target (${constraints.reliabilityTarget})`,
          });
          continue;
        }

        // Check 10: Budget exceeded (if maxCost is specified)
        if (
          constraints.maxCost !== null &&
          constraints.maxCost !== undefined
        ) {
          // Estimate cost per unit (simplified: average of worker and model cost)
          const estimatedCostPerUnit =
            (worker.typicalCostPerUnit + model.typicalCostPerUnit) / 2;
          if (estimatedCostPerUnit > constraints.maxCost) {
            rejected.push({
              candidateId,
              reason: "BUDGET_EXCEEDED",
              details: `Estimated cost per unit (${estimatedCostPerUnit}) exceeds maximum (${constraints.maxCost})`,
            });
            continue;
          }
        }

        // Check 11: Latency exceeded (if maxLatencyMs is specified)
        if (
          constraints.maxLatencyMs !== null &&
          constraints.maxLatencyMs !== undefined
        ) {
          // Estimate latency (simplified: average of worker and model latency)
          const estimatedLatencyMs =
            (worker.typicalLatencyMs + model.typicalLatencyMs) / 2;
          if (estimatedLatencyMs > constraints.maxLatencyMs) {
            rejected.push({
              candidateId,
              reason: "LATENCY_EXCEEDED",
              details: `Estimated latency (${estimatedLatencyMs}ms) exceeds maximum (${constraints.maxLatencyMs}ms)`,
            });
            continue;
          }
        }

        // Check 12: Provider unavailable
        if (!this.catalog.isProviderAvailable(provider.providerId)) {
          rejected.push({
            candidateId,
            reason: "PROVIDER_UNAVAILABLE",
            details: `Provider '${provider.providerId}' is currently unavailable`,
          });
          continue;
        }

        // Check 13: Model not offered by provider
        if (!this.catalog.isModelOffered(model.modelId, provider.providerId)) {
          rejected.push({
            candidateId,
            reason: "MODEL_UNAVAILABLE",
            details: `Model '${model.modelId}' is not offered by provider '${provider.providerId}'`,
          });
          continue;
        }

        // Check 14: Sensitivity policy block
        if (
          constraints.sensitivity === "sensitive" &&
          (provider.trust < 0.8 || provider.security < 0.7)
        ) {
          rejected.push({
            candidateId,
            reason: "SENSITIVITY_POLICY_BLOCK",
            details: `Sensitive task requires provider trust >= 0.8 and security >= 0.7, but got trust: ${provider.trust}, security: ${provider.security}`,
          });
          continue;
        }

        // Check 15: Feature missing
        const missingFeature = constraints.requiredFeatures.find(
          (feature) =>
            !worker.features.includes(feature) && !model.features.includes(feature)
        );
        if (missingFeature) {
          rejected.push({
            candidateId,
            reason: "FEATURE_MISSING",
            details: `Required feature '${missingFeature}' not supported by worker '${worker.workerKind}' or model '${model.modelId}'`,
          });
          continue;
        }

        // If we passed all checks, the candidate is viable
        viable.push(candidate);
      }

      return { viableCandidates: viable, rejectedCandidates: rejected };
    }

  /**
   * Score viable candidates based on the policy weights.
   */
  private scoreCandidates(
    candidates: Array<{
      worker: WorkerCandidate;
      model: ModelCandidate;
      provider: ProviderCandidate;
    }>,
    constraints: SelectionConstraints,
    policy: SelectionPolicy
  ): Array<{
    worker: WorkerCandidate;
    model: ModelCandidate;
    provider: ProviderCandidate;
    score: SelectionScore;
  }> {
    return candidates.map((candidate) => {
      const { worker, model, provider } = candidate;

      // Calculate individual score components (0-100 scale)

      // Capability fit: how well the capabilities match the requirement
      const capabilityFitScore = this.calculateCapabilityFitScore(
        worker,
        model,
        constraints.capabilityRequired
      );

      // Quality score: average of worker and model quality
      const qualityScore = ((worker.quality + model.quality) / 2) * 100;

      // Reliability score: average of worker and model reliability
      const reliabilityScore = ((worker.reliability + model.reliability) / 2) * 100;

      // Latency score: inverse of latency (lower is better)
      const maxLatency = 10000; // Assume 10s as worst case for normalization
      const latencyScore = Math.max(
        0,
        100 -
          (((worker.typicalLatencyMs + model.typicalLatencyMs) / 2) /
            maxLatency) *
            100
      );

      // Cost score: inverse of cost (lower is better)
      const maxCost = 0.01; // Assume $0.01 per unit as worst case for normalization
      const costScore = Math.max(
        0,
        100 -
          (((worker.typicalCostPerUnit + model.typicalCostPerUnit) / 2) /
            maxCost) *
            100
      );

      // Context headroom score: how much extra context we have beyond minimum
      const contextHeadroom = Math.min(
        worker.contextWindow,
        model.contextWindow
      ) - constraints.minContextWindow;
      const maxContextHeadroom = 100000; // Assume 100k as max for normalization
      const contextHeadroomScore = Math.min(
        100,
        (contextHeadroom / maxContextHeadroom) * 100
      );

      // Feature fit score: percentage of required features that are supported
      const featureFitScore = this.calculateFeatureFitScore(
        worker,
        model,
        constraints.requiredFeatures
      );

      // Provider health score
      const providerHealthScore = provider.health * 100;

      // Trust score
      const trustScore = provider.trust * 100;

      // Calculate weighted overall score
      const overallScore =
        capabilityFitScore * policy.weightCapabilityFit +
        qualityScore * policy.weightQuality +
        reliabilityScore * policy.weightReliability +
        latencyScore * policy.weightLatency +
        costScore * policy.weightCost +
        contextHeadroomScore * policy.weightContextHeadroom +
        featureFitScore * 0.1 + // Small weight for feature fit
        providerHealthScore * 0.05 + // Small weight for provider health
        trustScore * 0.05; // Small weight for trust

      return {
        worker,
        model,
        provider,
        score: {
          overall: Math.min(100, Math.max(0, overallScore)),
          capabilityFit: Math.min(100, Math.max(0, capabilityFitScore)),
          quality: Math.min(100, Math.max(0, qualityScore)),
          reliability: Math.min(100, Math.max(0, reliabilityScore)),
          latency: Math.min(100, Math.max(0, latencyScore)),
          cost: Math.min(100, Math.max(0, costScore)),
          contextHeadroom: Math.min(100, Math.max(0, contextHeadroomScore)),
          featureFit: Math.min(100, Math.max(0, featureFitScore)),
          providerHealth: Math.min(100, Math.max(0, providerHealthScore)),
          trust: Math.min(100, Math.max(0, trustScore)),
        },
      };
    });
  }

  /**
   * Calculate capability fit score (0-100).
   * Higher score if both worker and model support the capability.
   */
  private calculateCapabilityFitScore(
    worker: WorkerCandidate,
    model: ModelCandidate,
    requiredCapability: string
  ): number {
    const workerSupports = worker.capabilities.includes(requiredCapability) ? 1 : 0;
    const modelSupports = model.capabilities.includes(requiredCapability) ? 1 : 0;
    // If both support it, perfect score. If only one supports it, medium score. If none, zero.
    if (workerSupports && modelSupports) return 100;
    if (workerSupports || modelSupports) return 50;
    return 0;
  }

  /**
   * Calculate feature fit score (0-100).
   * Percentage of required features that are supported by worker or model.
   */
  private calculateFeatureFitScore(
    worker: WorkerCandidate,
    model: ModelCandidate,
    requiredFeatures: string[]
  ): number {
    if (requiredFeatures.length === 0) return 100;

    const supportedFeatures = requiredFeatures.filter((feature) =>
      worker.features.includes(feature) || model.features.includes(feature)
    );

    return (supportedFeatures.length / requiredFeatures.length) * 100;
  }

  /**
   * Create a fail-closed decision when no viable candidates are found.
   */
  private createFailClosedDecision(
    taskRequirements: TaskRequirements,
    rejectedCandidates: RejectedCandidate[],
    reason: string
  ): SelectionDecision {
    // Return a fail-closed decision with status no_viable_candidate and null selections
    return {
      status: "no_viable_candidate",
      selectedWorkerKind: null,
      selectedModelId: null,
      selectedProviderId: null,
      score: {
        overall: 0,
        capabilityFit: 0,
        quality: 0,
        reliability: 0,
        latency: 0,
        cost: 0,
        contextHeadroom: 0,
        featureFit: 0,
        providerHealth: 0,
        trust: 0,
      },
      rationale: `No viable candidate found for task requiring capability '${taskRequirements.capabilityRequired}'. Hard policy filters eliminated all options.`,
      evidence: [
        `Task requirements: ${JSON.stringify(taskRequirements)}`,
        `Rejected candidates count: ${rejectedCandidates.length}`,
      ],
      fallbackPlan: [],
      rejectedCandidates: rejectedCandidates,
      reason: "NO_VIABLE_CANDIDATE",
    };
  }

  /**
   * Create the final selection decision.
   */
  private createSelectionDecision(
    bestCandidate: {
      worker: WorkerCandidate;
      model: ModelCandidate;
      provider: ProviderCandidate;
      score: SelectionScore;
    },
    allScoredCandidates: Array<{
      worker: WorkerCandidate;
      model: ModelCandidate;
      provider: ProviderCandidate;
      score: SelectionScore;
    }>,
    fallbackPlan: FallbackPlan,
    taskRequirements: TaskRequirements,
    rejectedCandidates: RejectedCandidate[]
  ): SelectionDecision {
    const { worker, model, provider, score } = bestCandidate;

    // Generate rationale
    const rationale = this.generateRationale(
      worker,
      model,
      provider,
      score,
      taskRequirements
    );

    // Generate evidence
    const evidence = this.generateEvidence(
      worker,
      model,
      provider,
      score,
      taskRequirements,
      allScoredCandidates
    );

    return {
      status: "selected",
      selectedWorkerKind: worker.workerKind,
      selectedModelId: model.modelId,
      selectedProviderId: provider.providerId,
      score,
      rationale,
      evidence,
      fallbackPlan,
      rejectedCandidates: rejectedCandidates,
    };
  }

  /**
   * Generate rationale for the selection.
   */
  private generateRationale(
    worker: WorkerCandidate,
    model: ModelCandidate,
    provider: ProviderCandidate,
    score: SelectionScore,
    taskRequirements: TaskRequirements
  ): string {
    return `Selected worker '${worker.workerKind}', model '${model.modelId}' from provider '${provider.providerId}' with overall score ${score.overall.toFixed(
      1
    )}. Key factors: capability fit (${score.capabilityFit.toFixed(
      1
    )}), quality (${score.quality.toFixed(
      1
    )}), reliability (${score.reliability.toFixed(
      1
    )}), latency score (${score.latency.toFixed(
      1
    )}), cost score (${score.cost.toFixed(1)}).`;
  }

  /**
   * Generate evidence for the selection.
   */
  private generateEvidence(
    worker: WorkerCandidate,
    model: ModelCandidate,
    provider: ProviderCandidate,
    score: SelectionScore,
    taskRequirements: TaskRequirements,
    allScoredCandidates: Array<{
      worker: WorkerCandidate;
      model: ModelCandidate;
      provider: ProviderCandidate;
      score: SelectionScore;
    }>
  ): string[] {
    const evidence: string[] = [];

    evidence.push(
      `Worker '${worker.workerKind}' capabilities: ${worker.capabilities.join(
        ", "
      )}`
    );
    evidence.push(
      `Model '${model.modelId}' capabilities: ${model.capabilities.join(
        ", "
      )}`
    );
    evidence.push(
      `Provider '${provider.providerId}' health: ${provider.health.toFixed(
        2
      )}, trust: ${provider.trust.toFixed(2)}, security: ${provider.security.toFixed(
        2
      )}`
    );
    evidence.push(
      `Context window: ${Math.min(
        worker.contextWindow,
        model.contextWindow
      )} tokens (required: ${taskRequirements.minContextWindow})`
    );
    evidence.push(
      `Estimated latency: ${(
        (worker.typicalLatencyMs + model.typicalLatencyMs) /
        2
      ).toFixed(0)}ms`
    );
    evidence.push(
      `Estimated cost per unit: ${(
        (worker.typicalCostPerUnit + model.typicalCostPerUnit) /
        2
      ).toFixed(6)}`
    );
    evidence.push(
      `Total viable candidates considered: ${allScoredCandidates.length}`
    );

    return evidence;
  }

  /**
   * Create fallback plan from remaining viable candidates.
   * Ordered by score descending.
   */
  private createFallbackPlan(
    candidates: Array<{
      worker: WorkerCandidate;
      model: ModelCandidate;
      provider: ProviderCandidate;
      score: SelectionScore;
    }>,
    taskRequirements: TaskRequirements
  ): FallbackPlan {
    // Sort by score descending
    const sorted = [...candidates].sort(
      (a, b) => b.score.overall - a.score.overall
    );

    // Take top 3 as fallback options
    return sorted.slice(0, 3).map((c) => ({
      workerKind: c.worker.workerKind,
      modelId: c.model.modelId,
      providerId: c.provider.providerId,
    }));
  }
}