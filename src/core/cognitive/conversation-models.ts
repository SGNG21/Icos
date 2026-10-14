import { isMetaRoute } from "@/core/workers/meta-route";

/**
 * THE MODELS A CONVERSATION MAY BE ANSWERED BY (owner decision 2026-10-14, ADR 0078 §3).
 *
 * The CEO conversation used to ask OmniRoute for `auto/best-chat`, then fall back to the FIRST
 * id `/v1/models` listed, then to `auto/nvidia-chat`. All three let the gateway choose the
 * model, and a meta-route can serve a paid one (measured: `auto/best-free` served
 * `claude-opus-5`). The conversation now runs on an EXPLICIT, ORDERED list of concrete ids,
 * and a fallback only ever moves to the next entry of that list.
 *
 * PURE: reads an env-shaped record, returns ids or throws {@link ConversationModelConfigError}.
 */

/**
 * The default when the operator names nothing. Both are free NVIDIA NIM models, MEASURED on
 * 2026-10-14 through the lab OmniRoute 3.8.49 (docs/icos/OMNIROUTE_MODEL_STRATEGY_2026-10-14.md
 * §1: super 200 in 1.0 s, ultra 200 in 0.7 s). Order: the faster, smaller one first. A
 * measurement ages: re-probe before relying on it, and set ICOS_CONVERSATION_MODELS to pin
 * the list instead of inheriting this one.
 */
export const DEFAULT_CONVERSATION_MODELS: readonly string[] = Object.freeze([
  "nvidia/nvidia/nemotron-3-super-120b-a12b",
  "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
]);

/** The ordered list variable (comma-separated, trimmed). */
export const CONVERSATION_MODELS_VARIABLE = "ICOS_CONVERSATION_MODELS";

/**
 * A conversation model configuration that cannot be honoured. Thrown, never repaired: a
 * meta-route or an ambiguous list is refused with the variable's name, not replaced by a guess.
 */
export class ConversationModelConfigError extends Error {
  override readonly name = "ConversationModelConfigError";
  constructor(
    readonly variable: string,
    detail: string,
  ) {
    super(`CONVERSATION_MODEL_NOT_ADMISSIBLE:${variable} ${detail}`);
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/** One named model: absent/blank = undefined, meta-route = refused. Trimmed. */
export function namedConversationModel(env: Env, variable: string): string | undefined {
  const raw = env[variable];
  if (raw === undefined || raw.trim() === "") return undefined;
  const id = raw.trim();
  if (isMetaRoute(id)) {
    throw new ConversationModelConfigError(
      variable,
      `\`${id}\` est une méta-route OmniRoute (le modèle servi est choisi par la passerelle) : nommer un modèle concret`,
    );
  }
  return id;
}

/**
 * The explicit ordered list, or `undefined` when the variable is absent or blank. An empty
 * entry (`a,,b`), a duplicate, or a meta-route refuses the whole list: an operator who wrote
 * it meant something precise, and guessing which part to keep is not ICOS's call.
 */
export function explicitConversationModels(env: Env): readonly string[] | undefined {
  const raw = env[CONVERSATION_MODELS_VARIABLE];
  if (raw === undefined || raw.trim() === "") return undefined;
  const ids = raw.split(",").map((id) => id.trim());
  const seen = new Set<string>();
  for (const id of ids) {
    if (id === "") {
      throw new ConversationModelConfigError(CONVERSATION_MODELS_VARIABLE, "entrée vide");
    }
    if (isMetaRoute(id)) {
      throw new ConversationModelConfigError(
        CONVERSATION_MODELS_VARIABLE,
        `\`${id}\` est une méta-route OmniRoute (le modèle servi est choisi par la passerelle) : nommer des modèles concrets`,
      );
    }
    if (seen.has(id)) {
      throw new ConversationModelConfigError(CONVERSATION_MODELS_VARIABLE, `\`${id}\` en double`);
    }
    seen.add(id);
  }
  return Object.freeze(ids);
}

export type ConversationModelSource =
  | typeof CONVERSATION_MODELS_VARIABLE
  | "ICOS_CEO_MODEL"
  | "ICOS_REVIEWER_MODEL"
  | "DEFAULT_MEASURED_FREE";

export interface ConversationModelPlan {
  /** Tried in this order; never anything else. */
  readonly models: readonly string[];
  readonly source: ConversationModelSource;
}

/**
 * The CEO conversation's plan, in precedence order:
 *   1. ICOS_CONVERSATION_MODELS — the explicit ordered list;
 *   2. COMPATIBILITY: ICOS_CEO_MODEL, else ICOS_REVIEWER_MODEL (the variables this client
 *      already read) — honoured as a ONE-model list, refused if it is a meta-route. No
 *      fallback is added to it: an operator who named one model did not authorise another;
 *   3. {@link DEFAULT_CONVERSATION_MODELS}, measured free.
 * Every non-meta-route variable is validated even when a higher one wins, so a meta-route left
 * in the environment is refused rather than lying in wait for the day the list is removed.
 */
export function conversationModelPlan(env: Env): ConversationModelPlan {
  const explicit = explicitConversationModels(env);
  const ceo = namedConversationModel(env, "ICOS_CEO_MODEL");
  const reviewer = namedConversationModel(env, "ICOS_REVIEWER_MODEL");
  if (explicit) return { models: explicit, source: CONVERSATION_MODELS_VARIABLE };
  if (ceo) return { models: [ceo], source: "ICOS_CEO_MODEL" };
  if (reviewer) return { models: [reviewer], source: "ICOS_REVIEWER_MODEL" };
  return { models: DEFAULT_CONVERSATION_MODELS, source: "DEFAULT_MEASURED_FREE" };
}

/**
 * The fallback chain of a cognition turn whose primary model is `primary` (its workload
 * route): the primary first, then ONLY the entries of the explicit list, in order, without
 * repeating the primary. No explicit list = no fallback, exactly as before.
 */
export function cognitionModelChain(
  primary: string,
  explicit: readonly string[],
): readonly string[] {
  return [primary, ...explicit.filter((id) => id !== primary)];
}
