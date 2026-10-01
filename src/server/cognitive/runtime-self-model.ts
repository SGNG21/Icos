import type { CognitiveScope } from "@/core/cognitive/contracts";
import { capabilityCandidates, type RuntimeCapabilityProbe } from "@/core/cognitive/self-model";
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
  readonly countCapabilities: () => Promise<number | undefined>;
  readonly cognitionConfigured: () => boolean;
  readonly missionIntakeConnected: () => boolean;
  readonly durableSchedulerRunning: () => boolean;
  readonly speechToText: () => boolean;
  readonly textToSpeech: () => boolean;
};

/** A probe that throws is a probe that did not answer: `undefined`, never `0`. */
const safely = async (probe: () => Promise<number | undefined>): Promise<number | undefined> => {
  try {
    return await probe();
  } catch {
    return undefined;
  }
};

export class RuntimeSelfModel implements SelfModelSource {
  constructor(private readonly probes: RuntimeProbes) {}

  async probe(): Promise<RuntimeCapabilityProbe> {
    const [toolConnectors, toolGrants, registeredWorkers, registeredCapabilities] =
      await Promise.all([
        safely(this.probes.countToolConnectors),
        safely(this.probes.countToolGrants),
        safely(this.probes.countWorkers),
        safely(this.probes.countCapabilities),
      ]);
    return {
      cognitionConfigured: this.probes.cognitionConfigured(),
      // Reaching this class at all means the PostgreSQL runtime was composed.
      conversationDurable: true,
      memoryDurable: true,
      missionIntakeConnected: this.probes.missionIntakeConnected(),
      durableSchedulerRunning: this.probes.durableSchedulerRunning(),
      toolConnectors,
      toolGrants,
      registeredWorkers,
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
