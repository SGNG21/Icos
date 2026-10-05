import type { CognitiveScope } from "@/core/cognitive/contracts";
import {
  capabilityCandidates,
  type ComputeProviderProbe,
  type RuntimeCapabilityProbe,
} from "@/core/cognitive/self-model";
import type { ContextCandidate } from "@/core/cognitive/context-selection";
import type { SelfModelSource } from "@/server/cognitive/context-assembler";

/**
 * Measures the running ICOS so the cognition prompt can describe it truthfully
 * (decision 0062). Every probe is a question about THIS process and THIS
 * database; anything that cannot be measured stays `undefined`, which the
 * self-model turns into NOT_CONNECTED rather than an optimistic claim.
 *
 * It grants nothing. A capability appearing here means the runtime already
 * permits it, so registering a worker or a connector changes the answer with no
 * code change — which is the point: no static capability list to drift.
 */
export type RuntimeProbes = {
  /** Resolved lazily and per turn: a connector or worker registered now must show up now. */
  readonly countToolConnectors: () => Promise<number | undefined>;
  readonly countToolGrants: () => Promise<number | undefined>;
  readonly countWorkers: () => Promise<number | undefined>;
  /** Healthy AND available — the fleet that can actually take work right now. */
  readonly countRoutableWorkers: () => Promise<number | undefined>;
  /** Executors the Execution Gateway can launch under its sandbox. */
  readonly countGovernedExecutors: () => Promise<number | undefined>;
  /** Connectors that genuinely reach the web/search, not model providers. */
  readonly countRealtimeConnectors: () => Promise<number | undefined>;
  /** Canonical durable brains — logical roles, never compute workers. */
  readonly countDurableBrains: () => Promise<number | undefined>;
  readonly countCapabilities: () => Promise<number | undefined>;
  /** Fleet health per provider, from the registry's durable probe evidence. */
  readonly computeProviders: () => Promise<readonly ComputeProviderProbe[] | undefined>;
  /** URL and key of the model provider are set. Not a capability: a classifier of absence. */
  readonly providerConfigured: () => boolean;
  readonly cognitionConfigured: () => boolean;
  readonly missionIntakeConnected: () => boolean;
  readonly durableSchedulerRunning: () => boolean;
  readonly speechToText: () => boolean;
  readonly textToSpeech: () => boolean;
};

/** A probe that throws is a probe that did not answer: `undefined`, never `0`. */
const safely = async <T>(probe: () => Promise<T | undefined>): Promise<T | undefined> => {
  try {
    return await probe();
  } catch {
    return undefined;
  }
};

export class RuntimeSelfModel implements SelfModelSource {
  constructor(private readonly probes: RuntimeProbes) {}

  async probe(): Promise<RuntimeCapabilityProbe> {
    const [
      toolConnectors,
      toolGrants,
      registeredWorkers,
      registeredCapabilities,
      routableWorkers,
      governedExecutors,
      realtimeConnectors,
      durableBrains,
      computeProviders,
    ] = await Promise.all([
      safely(this.probes.countToolConnectors),
      safely(this.probes.countToolGrants),
      safely(this.probes.countWorkers),
      safely(this.probes.countCapabilities),
      safely(this.probes.countRoutableWorkers),
      safely(this.probes.countGovernedExecutors),
      safely(this.probes.countRealtimeConnectors),
      safely(this.probes.countDurableBrains),
      safely(this.probes.computeProviders),
    ]);
    return {
      providerConfigured: this.probes.providerConfigured(),
      cognitionConfigured: this.probes.cognitionConfigured(),
      // Reaching this class at all means the PostgreSQL runtime was composed.
      conversationDurable: true,
      memoryDurable: true,
      missionIntakeConnected: this.probes.missionIntakeConnected(),
      durableSchedulerRunning: this.probes.durableSchedulerRunning(),
      toolConnectors,
      toolGrants,
      registeredWorkers,
      routableWorkers,
      governedExecutors,
      realtimeConnectors,
      durableBrains,
      computeProviders,
      registeredCapabilities,
      speechToText: this.probes.speechToText(),
      textToSpeech: this.probes.textToSpeech(),
    };
  }

  /** Capability is a property of the runtime, so the scope does not change it. */
  async candidates(_scope: CognitiveScope, now: Date): Promise<ContextCandidate[]> {
    return capabilityCandidates(await this.probe(), now);
  }
}
