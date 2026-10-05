/**
 * Conversational workload classes (decision 0067, item 6).
 *
 * One `ICOS_COGNITIVE_MODEL` used to serve every interaction, so a one-line spoken reply paid
 * reasoning-model latency. A turn is classified HERE, deterministically, before any model
 * runs — the intent the model produces arrives too late to pick the model that produces it.
 *
 * Only CONVERSATIONAL classes live here. Research, planning, coding and review are mission
 * workloads: they already have their own models (`ICOS_PLANNER_MODEL`, `ICOS_WORKER_MODEL`,
 * `ICOS_REVIEWER_MODEL`) chosen by the planner, the router and the reviewer — not per turn.
 */
export const WORKLOAD_CLASSES = [
  /** Short exchange: an answer, a confirmation, a quick question. Latency matters most. */
  "CONVERSATION_FAST",
  /** Analysis, planning or a multi-step request in text: reasoning matters most. */
  "CONVERSATION_DEEP",
  /** Spoken: the reply is read aloud, so it must come fast and short. */
  "VOICE",
] as const;
export type WorkloadClass = (typeof WORKLOAD_CLASSES)[number];

export type WorkloadInput = {
  readonly text: string;
  /** Set by the transport, never by the model. */
  readonly channel: "text" | "voice";
};

/** Past this many characters a text turn is treated as needing reasoning. */
export const FAST_MAX_CHARS = 240;

/**
 * Words that ask for analysis or work rather than an answer. A heuristic by design: the
 * cost of a miss is one slower (or one shallower) reply, never a wrong permission.
 */
const DEEP_SIGNALS =
  /\b(analys\w*|pourquoi|compar\w*|planifi\w*|plan\b|stratégi\w*|audit\w*|corrig\w*|améliore\w*|optimis\w*|rédige\w*|conçois|architect\w*|implémente\w*|migre\w*|refactor\w*|diagnosti\w*|explique en détail|étape par étape)/iu;

/** Deterministic: same input, same class. No model in the loop. */
export function classifyWorkload(input: WorkloadInput): WorkloadClass {
  if (input.channel === "voice") return "VOICE";
  const text = input.text.trim();
  if (text.length > FAST_MAX_CHARS || DEEP_SIGNALS.test(text)) return "CONVERSATION_DEEP";
  return "CONVERSATION_FAST";
}

/** Model ids per class. `default` is mandatory; a missing class falls back to it. */
export type ModelRoutes = {
  readonly default: string;
  readonly CONVERSATION_FAST?: string;
  readonly CONVERSATION_DEEP?: string;
  readonly VOICE?: string;
};

export function modelFor(routes: ModelRoutes, workload: WorkloadClass): string {
  return routes[workload] ?? routes.default;
}

/** `ICOS_COGNITIVE_MODEL` is the default; `_FAST` / `_DEEP` / `_VOICE` override per class. */
export function modelRoutesFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ModelRoutes | null {
  const def = env.ICOS_COGNITIVE_MODEL ?? env.ICOS_CEO_MODEL;
  if (!def) return null;
  const pick = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
  return {
    default: def,
    CONVERSATION_FAST: pick(env.ICOS_COGNITIVE_MODEL_FAST),
    CONVERSATION_DEEP: pick(env.ICOS_COGNITIVE_MODEL_DEEP),
    VOICE: pick(env.ICOS_COGNITIVE_MODEL_VOICE),
  };
}
