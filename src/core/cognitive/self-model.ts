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
  /**
   * Reachable, but a configuration VALUE is unset (a model id, a connector instance). The
   * fix is a setting, not code — which is what the owner needs to know. Collapsing this into
   * NOT_CONNECTED made "set one env var" indistinguishable from "nothing is wired".
   */
  "NOT_CONFIGURED",
  /** Available, and measurably impaired: part of the fleet behind it is down. */
  "DEGRADED",
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
/** One compute provider as the worker registry sees it, after the durable health probes. */
export type ComputeProviderProbe = {
  /** Declared in registration metadata; `(non déclaré)` when the worker names none. */
  readonly provider: string;
  readonly registered: number;
  /** Healthy AND available right now. */
  readonly routable: number;
};

export type RuntimeCapabilityProbe = {
  /**
   * The model PROVIDER (OmniRoute) is configured: URL and key present. Read from the same
   * source the compute fleet and voice probes use. Reachability of a provider is NOT
   * capability — it only decides whether a missing model is NOT_CONFIGURED or NOT_CONNECTED.
   */
  readonly providerConfigured: boolean | undefined;
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
  /**
   * Registered is not routable. A worker whose probe failed is a row, not a resource, and
   * reporting "15 workers" while 9 are unhealthy describes a fleet ICOS does not have.
   */
  readonly routableWorkers: number | undefined;
  /**
   * GOVERNED EXECUTORS the Execution Gateway can actually launch — hermes, codex — as
   * distinct from Tool Gateway connectors. These were invisible here, so ICOS reported
   * "aucun outil utilisable" while sandboxed autolaunch was certified working. Two
   * different capabilities; conflating them made one of them unspeakable.
   */
  readonly governedExecutors: number | undefined;
  /**
   * A live WEB/REALTIME connector. Reaching a model provider is NOT web access: a model
   * answers from its weights. Kept separate so provider connectivity can never be
   * mistaken for the ability to look something up.
   */
  readonly realtimeConnectors: number | undefined;
  /** Canonical durable brains. Logical roles — never counted as compute workers. */
  readonly durableBrains: number | undefined;
  /** Per-provider fleet health, from the worker registry's probe evidence. */
  readonly computeProviders: readonly ComputeProviderProbe[] | undefined;
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
  /* Provider present, model id absent: a setting is missing, not a subsystem. */
  const unconfigured = (configured: boolean | undefined): CapabilityState =>
    yes(probe.providerConfigured) && configured === false ? "NOT_CONFIGURED" : "NOT_CONNECTED";
  const noEngine = yes(probe.providerConfigured)
    ? "fournisseur de modèles configuré, aucun modèle de conversation réglé (ICOS_COGNITIVE_MODEL)"
    : "aucun moteur cognitif configuré";
  const providers = probe.computeProviders;
  const fleet = {
    registered: providers?.reduce((n, p) => n + p.registered, 0) ?? 0,
    routable: providers?.reduce((n, p) => n + p.routable, 0) ?? 0,
  };
  const fleetEvidence = providers
    ?.map((p) => `${p.provider} ${p.routable}/${p.registered}`)
    .join(", ");
  const facts: CapabilityFact[] = [
    {
      key: "conversation.context",
      label: "converser en gardant le contexte de la conversation",
      state:
        canThink && yes(probe.conversationDurable)
          ? "AUTONOMOUS"
          : unconfigured(probe.cognitionConfigured),
      evidence: canThink ? "moteur cognitif configuré, tours persistés" : noEngine,
    },
    {
      key: "compute.providers",
      label: "joindre des fournisseurs de calcul (modèles) pour le travail délégué",
      /*
       * MEASURED PER PROVIDER, from the same probe evidence that decides routing. A fleet
       * of 15 with 12 routable is DEGRADED — true and actionable — where "15 workers" would
       * describe a fleet ICOS does not have, and "12 workers" would hide the three dead ones.
       */
      state: !providers
        ? "NOT_CONNECTED"
        : providers.length === 0
          ? unconfigured(false)
          : fleet.routable === 0
            ? "NOT_CONNECTED"
            : fleet.routable < fleet.registered
              ? "DEGRADED"
              : "GOVERNED",
      evidence: !providers
        ? "flotte de calcul non mesurable"
        : providers.length === 0
          ? "aucun worker enregistré (flotte non amorcée)"
          : `workers routables ${fleet.routable}/${fleet.registered} — ${fleetEvidence}`,
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
      state: canThink ? "AUTONOMOUS" : unconfigured(probe.cognitionConfigured),
      evidence: canThink ? "moteur cognitif configuré" : noEngine,
    },
    {
      key: "mission.launch",
      label: "lancer une mission issue de la conversation",
      /*
       * The CLASS is decided per goal by `classifyMissionAutonomy`, from the capabilities
       * the goal declares — never from the risk the model claims for itself. This fact
       * describes the POLICY that will be applied, not a verdict on a goal that does not
       * exist yet, so it reports that safe internal work starts on its own and the rest
       * is asked about. Saying APPROVAL_REQUIRED unconditionally was simpler and false.
       */
      state: yes(probe.missionIntakeConnected) ? "GOVERNED" : "NOT_CONNECTED",
      evidence: yes(probe.missionIntakeConnected)
        ? "travail interne vérifiablement en lecture seule ou confiné à un worktree isolé : lancé sans approbation ; effet externe, destructif ou irréversible : approbation humaine. Le niveau de risque affirmé par le modèle ne peut qu'augmenter l'exigence."
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
      /*
       * TWO governed paths, and only one used to be measured.
       *
       * The Tool Gateway's connectors are one. The EXECUTION GATEWAY — hermes and codex,
       * launched under a kernel sandbox with brokered credentials — is the other, and it
       * was invisible here, so ICOS answered "aucun outil utilisable" on a runtime where
       * governed autolaunch is certified. Either path makes the capability real.
       */
      state: toolsUsable || some(probe.governedExecutors) ? "GOVERNED" : "NOT_CONNECTED",
      evidence: toolsUsable
        ? "connecteurs installés et habilitations actives ; risque élevé ou critique = approbation humaine"
        : some(probe.governedExecutors)
          ? `exécuteurs gouvernés disponibles (${probe.governedExecutors}) sous bac à sable ; aucun connecteur externe installé`
          : `aucun outil utilisable (connecteurs: ${probe.toolConnectors ?? "inconnu"}, habilitations: ${probe.toolGrants ?? "inconnu"}, exécuteurs: ${probe.governedExecutors ?? "inconnu"})`,
    },
    {
      key: "external.realtime",
      label: "consulter des données externes en temps réel (web, recherche)",
      /*
       * ITS OWN MEASUREMENT. This used to follow `toolsUsable`, which made it true as
       * soon as ANY connector existed and false otherwise — neither of which is a
       * statement about the web. Reaching a model provider is not realtime access
       * either: a model answers from its weights, so being able to call one says nothing
       * about being able to look something up today.
       */
      state: some(probe.realtimeConnectors) ? "GOVERNED" : "NOT_CONNECTED",
      evidence: some(probe.realtimeConnectors)
        ? `connecteur web/recherche gouverné disponible (${probe.realtimeConnectors})`
        : "aucun connecteur web ou de recherche installé : joindre un fournisseur de modèle n'est pas un accès au web",
    },
    {
      key: "workforce.delegate",
      label: "déléguer du travail à des workers ou agents",
      /* Registered is not routable: delegation needs a worker that can take work NOW. */
      state: !some(probe.registeredWorkers)
        ? "NOT_CONNECTED"
        : !some(probe.routableWorkers)
          ? "NOT_CONNECTED"
          : (probe.routableWorkers ?? 0) < (probe.registeredWorkers ?? 0)
            ? "DEGRADED"
            : "GOVERNED",
      evidence: some(probe.registeredWorkers)
        ? `${probe.routableWorkers ?? "?"} worker(s) routable(s) sur ${probe.registeredWorkers} enregistré(s)${some(probe.durableBrains) ? `, ${probe.durableBrains} cerveau(x) durable(s)` : ", aucun cerveau durable"}`
        : "aucun worker enregistré",
    },
    {
      key: "voice.speech",
      label: "écouter et répondre à la voix",
      state: yes(probe.speechToText)
        ? yes(probe.textToSpeech)
          ? "AUTONOMOUS"
          : "DEGRADED"
        : unconfigured(probe.speechToText),
      evidence: yes(probe.speechToText)
        ? yes(probe.textToSpeech)
          ? "reconnaissance et synthèse vocale configurées"
          : "reconnaissance vocale configurée, synthèse non réglée (réponse en texte)"
        : yes(probe.providerConfigured)
          ? "modèle de reconnaissance vocale non réglé (ICOS_VOICE_STT_MODEL)"
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
