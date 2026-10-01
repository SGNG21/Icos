import type { ContextCandidate } from "./context-selection";

/**
 * ICOS's self-model: what it can actually do RIGHT NOW (decision 0062).
 *
 * The cognition prompt used to assert capability in static prose ("tu n'exécutes
 * jamais rien toi-même"), so on a real phone ICOS described itself as a generic
 * assistant: no external access, every action human-validated. Both claims were
 * prose, not measurement. Capability is a property of the RUNTIME, so it is
 * assembled per turn from the live runtime and handed to the model as context.
 *
 * Nothing here grants authority. It only DESCRIBES what the runtime already
 * permits, so the description cannot drift from the permission.
 */

/** The five classes the self-description must distinguish. */
export const CAPABILITY_STATES = [
  /** Allowed now, no human approval: policy classifies it as low-risk and in-policy. */
  "AUTONOMOUS",
  /** Executable, but only through a governed path (Tool Gateway / Workforce / CORE3). */
  "GOVERNED",
  /** Policy actually classifies this as approval-required before it may proceed. */
  "APPROVAL_REQUIRED",
  /** Architecturally supported, not available in THIS runtime. Never claimed as usable. */
  "NOT_CONNECTED",
  /** Genuinely absent from ICOS. */
  "NOT_SUPPORTED",
] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

export type CapabilityFact = {
  readonly key: string;
  /** User-facing French, because ICOS answers in French. */
  readonly label: string;
  readonly state: CapabilityState;
  /** Why this state, in a few words. Never a secret, a URL or a key. */
  readonly evidence: string;
};

/**
 * What the runtime reports about itself. Every field is a measurement, and
 * `undefined` means "could not be determined" — which fails closed to
 * NOT_CONNECTED rather than being assumed available.
 */
export type RuntimeCapabilityProbe = {
  readonly cognitionConfigured: boolean | undefined;
  readonly conversationDurable: boolean | undefined;
  readonly memoryDurable: boolean | undefined;
  readonly missionIntakeConnected: boolean | undefined;
  readonly durableSchedulerRunning: boolean | undefined;
  /** Connectors actually installed in the Tool Gateway for this tenant. */
  readonly toolConnectors: number | undefined;
  /** Non-expired, non-revoked grants: without one, no tool action may run. */
  readonly toolGrants: number | undefined;
  readonly registeredWorkers: number | undefined;
  readonly registeredCapabilities: number | undefined;
  readonly speechToText: boolean | undefined;
  readonly textToSpeech: boolean | undefined;
};

const yes = (v: boolean | undefined) => v === true;
const some = (n: number | undefined) => typeof n === "number" && n > 0;

/**
 * The live capability truth, as facts. Order is stable so the rendered context
 * and the tests are deterministic.
 */
export function capabilityFacts(probe: RuntimeCapabilityProbe): CapabilityFact[] {
  const toolsUsable = some(probe.toolConnectors) && some(probe.toolGrants);
  const canThink = yes(probe.cognitionConfigured);
  const facts: CapabilityFact[] = [
    {
      key: "conversation.context",
      label: "converser en gardant le contexte de la conversation",
      state: canThink && yes(probe.conversationDurable) ? "AUTONOMOUS" : "NOT_CONNECTED",
      evidence: canThink
        ? "moteur cognitif configuré, tours persistés"
        : "aucun moteur cognitif configuré",
    },
    {
      key: "memory.durable",
      label: "retenir et retrouver des informations durables",
      state: yes(probe.memoryDurable) ? "AUTONOMOUS" : "NOT_CONNECTED",
      evidence: yes(probe.memoryDurable) ? "mémoire PostgreSQL active" : "mémoire indisponible",
    },
    {
      key: "reasoning.propose",
      label: "raisonner, planifier et proposer un objectif ou une action",
      state: canThink ? "AUTONOMOUS" : "NOT_CONNECTED",
      evidence: canThink ? "moteur cognitif configuré" : "aucun moteur cognitif configuré",
    },
    {
      key: "mission.launch",
      label: "lancer une mission issue de la conversation",
      // launchPolicy(): the risk level is ASSERTED BY THE MODEL, so it is unverified
      // and can never be relaxed on the model's word. This is the real policy.
      state: yes(probe.missionIntakeConnected) ? "APPROVAL_REQUIRED" : "NOT_CONNECTED",
      evidence: yes(probe.missionIntakeConnected)
        ? "niveau de risque affirmé par le modèle, donc non vérifié : approbation humaine requise avant lancement"
        : "intake d'objectif non connecté",
    },
    {
      key: "mission.execute",
      label: "exécuter une mission approuvée de façon durable, sans superviseur humain",
      state:
        yes(probe.missionIntakeConnected) && yes(probe.durableSchedulerRunning)
          ? "GOVERNED"
          : "NOT_CONNECTED",
      evidence:
        yes(probe.missionIntakeConnected) && yes(probe.durableSchedulerRunning)
          ? "ordonnanceur durable actif : une mission approuvée continue même déconnecté"
          : "ordonnanceur durable inactif",
    },
    {
      key: "tools.governed",
      label: "utiliser des outils ou connecteurs externes gouvernés",
      state: toolsUsable ? "GOVERNED" : "NOT_CONNECTED",
      evidence: toolsUsable
        ? "connecteurs installés et habilitations actives ; risque élevé ou critique = approbation humaine"
        : `aucun outil utilisable (connecteurs: ${probe.toolConnectors ?? "inconnu"}, habilitations: ${probe.toolGrants ?? "inconnu"})`,
    },
    {
      key: "external.realtime",
      label: "accéder à des données externes en temps réel",
      // Strictly follows the tools: there is no other external path.
      state: toolsUsable ? "GOVERNED" : "NOT_CONNECTED",
      evidence: toolsUsable
        ? "via les connecteurs gouvernés uniquement"
        : "aucun connecteur externe installé",
    },
    {
      key: "workforce.delegate",
      label: "déléguer du travail à des workers ou agents",
      state: some(probe.registeredWorkers) ? "GOVERNED" : "NOT_CONNECTED",
      evidence: some(probe.registeredWorkers)
        ? `${probe.registeredWorkers} worker(s) enregistré(s)`
        : "aucun worker enregistré",
    },
    {
      key: "voice.speech",
      label: "écouter et répondre à la voix",
      state: yes(probe.speechToText) ? "AUTONOMOUS" : "NOT_CONNECTED",
      evidence: yes(probe.speechToText)
        ? yes(probe.textToSpeech)
          ? "reconnaissance et synthèse vocale configurées"
          : "reconnaissance vocale configurée, synthèse indisponible (réponse en texte)"
        : "reconnaissance vocale non configurée",
    },
  ];
  return facts;
}

/** One line per fact, as the model will read it. */
export function renderCapabilityFact(fact: CapabilityFact): string {
  return `${fact.state} — ${fact.label} (${fact.evidence})`;
}

/**
 * Capability facts as context candidates. `TOOL_CONFIRMED` because each one is
 * a measurement of the running system, not an inference; `runtime` stage so a
 * recalled self-description can never outrank it; `occurredAt = now` because
 * the claim is only about this instant.
 */
export function capabilityCandidates(probe: RuntimeCapabilityProbe, now: Date): ContextCandidate[] {
  return capabilityFacts(probe).map((fact) => ({
    stage: "runtime" as const,
    kind: "runtime_state" as const,
    ref: `runtime:capability.${fact.key}`,
    text: renderCapabilityFact(fact),
    anchored: true,
    entityIds: [],
    occurredAt: now.toISOString(),
    confidence: 1,
    epistemic: "TOOL_CONFIRMED" as const,
    trust: "trusted" as const,
  }));
}
