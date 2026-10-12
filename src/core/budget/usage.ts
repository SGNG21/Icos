import { UNMETERED, type UnmeteredReason, type UsageOutcome } from "./contracts";

/**
 * Lecture du bloc `usage` d'une réponse OpenAI-compatible (OmniRoute en renvoie un sur
 * chaque complétion ; ICOS le jetait).
 *
 * Tout ce qui n'est pas un décompte entier, positif et cohérent rend UNMETERED avec un motif.
 * On ne devine pas, on ne complète pas, on ne remplace pas par 0.
 */

/**
 * Au-delà, un « décompte » n'est plus un décompte : aucun fournisseur ne facture 10^9 tokens
 * sur un seul appel. Borne de plausibilité, pas une limite de produit.
 */
export const MAX_PLAUSIBLE_TOKENS_PER_CALL = 1_000_000_000;

const unmetered = (reason: UnmeteredReason): UsageOutcome => ({ kind: UNMETERED, reason });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `undefined` = champ absent, `null` = champ présent mais invalide. */
function tokenCount(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number") return null;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

export function readUsage(body: unknown): UsageOutcome {
  if (!isPlainObject(body)) return unmetered("NON_JSON_BODY");

  const raw = body.usage;
  if (!isPlainObject(raw)) return unmetered("USAGE_ABSENT");
  if (raw.prompt_tokens === undefined && raw.completion_tokens === undefined) {
    if (raw.input_tokens !== undefined || raw.output_tokens !== undefined) {
      return anthropicUsage(raw);
    }
  }

  const prompt = tokenCount(raw.prompt_tokens);
  const completion = tokenCount(raw.completion_tokens);
  const total = tokenCount(raw.total_tokens);

  if (prompt === undefined || completion === undefined) return unmetered("USAGE_INCOMPLETE");
  if (prompt === null || completion === null || total === null) return unmetered("USAGE_INVALID");

  const sum = prompt + completion;
  /**
   * Un total supérieur à la somme est légitime (tokens de raisonnement, tokens cachés
   * facturés séparément) : on garde celui du fournisseur, c'est lui qui facture.
   * Un total inférieur est incohérent : on refuse de mesurer.
   */
  if (total !== undefined && total < sum) return unmetered("USAGE_INCONSISTENT");
  const totalTokens = total ?? sum;

  if (
    prompt > MAX_PLAUSIBLE_TOKENS_PER_CALL ||
    completion > MAX_PLAUSIBLE_TOKENS_PER_CALL ||
    totalTokens > MAX_PLAUSIBLE_TOKENS_PER_CALL
  ) {
    return unmetered("USAGE_IMPLAUSIBLE");
  }

  return {
    kind: "METERED",
    usage: { promptTokens: prompt, completionTokens: completion, totalTokens },
  };
}

/**
 * LE FORMAT ANTHROPIC (`POST /v1/messages`), que sert aussi OmniRoute et que parle Claude Code.
 *
 * `{input_tokens, output_tokens, cache_creation_input_tokens?, cache_read_input_tokens?}` :
 * les tokens de cache SONT des tokens d'entrée facturés, ils sont donc ajoutés à l'entrée —
 * les ignorer sous-compterait exactement la partie qui grossit à chaque tour d'un agent.
 * Mêmes règles qu'au-dessus : absent ≠ 0, invalide = UNMETERED.
 */
function anthropicUsage(raw: Record<string, unknown>): UsageOutcome {
  const input = tokenCount(raw.input_tokens);
  const output = tokenCount(raw.output_tokens);
  const cacheCreation = tokenCount(raw.cache_creation_input_tokens);
  const cacheRead = tokenCount(raw.cache_read_input_tokens);
  if (input === undefined || output === undefined) return unmetered("USAGE_INCOMPLETE");
  if (input === null || output === null || cacheCreation === null || cacheRead === null) {
    return unmetered("USAGE_INVALID");
  }
  const prompt = input + (cacheCreation ?? 0) + (cacheRead ?? 0);
  const totalTokens = prompt + output;
  if (totalTokens > MAX_PLAUSIBLE_TOKENS_PER_CALL) return unmetered("USAGE_IMPLAUSIBLE");
  return {
    kind: "METERED",
    usage: {
      promptTokens: prompt,
      completionTokens: output,
      totalTokens,
      ...(cacheCreation !== undefined || cacheRead !== undefined
        ? { cache: { read: cacheRead ?? 0, creation: cacheCreation ?? 0 } }
        : {}),
    },
  };
}

/**
 * LA CONSOMMATION D'UN FLUX SSE ANTHROPIC, lu en entier.
 *
 * Un flux `/v1/messages` (stream: true) porte la consommation en deux morceaux :
 *   - `message_start.message.usage` : l'entrée (et le cache), plus un `output_tokens` initial ;
 *   - `message_delta.usage`         : `output_tokens` CUMULÉ, et parfois l'entrée réécrite.
 * Le dernier mot sur chaque champ gagne. Un flux sans `message_start` lisible, ou sans aucun
 * décompte de sortie, est UNMETERED — jamais 0.
 *
 * Rend la forme d'un corps non-streamé (`{model, usage}`) pour réutiliser {@link readUsage}.
 */
export interface AnthropicStreamReading {
  readonly usage: UsageOutcome;
  readonly model?: string;
  /**
   * An in-stream provider error (`{"type":"error"}` event) that arrived BEFORE any
   * `message_start`: the gateway had already answered 2xx, then the provider failed — a
   * cooldown, a quota, an upstream outage. No completion was produced and nothing was counted.
   * Reported so the caller can treat it like a non-2xx answer instead of a consumption it
   * cannot measure (measured 2026-10-12: two such calls locked a lab goal's budget window).
   */
  readonly providerError?: { readonly type: string; readonly message: string };
  /** What the stream actually contained, for the diagnostic line when nothing was measurable. */
  readonly stream: { readonly bytes: number; readonly events: Readonly<Record<string, number>> };
}

export function readAnthropicStream(text: string): AnthropicStreamReading {
  let model: string | undefined;
  let started = false;
  let providerError: AnthropicStreamReading["providerError"];
  const events: Record<string, number> = {};
  const merged: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      events["(unparseable)"] = (events["(unparseable)"] ?? 0) + 1;
      continue;
    }
    if (!isPlainObject(event)) continue;
    const type = typeof event.type === "string" ? event.type : "(untyped)";
    events[type] = (events[type] ?? 0) + 1;
    if (event.type === "message_start" && isPlainObject(event.message)) {
      started = true;
      if (typeof event.message.model === "string") model = event.message.model;
      if (isPlainObject(event.message.usage)) Object.assign(merged, event.message.usage);
    } else if (event.type === "message_delta" && isPlainObject(event.usage)) {
      for (const [key, value] of Object.entries(event.usage)) {
        if (value !== null && value !== undefined) merged[key] = value;
      }
    } else if (event.type === "error" && !started && providerError === undefined) {
      const error = isPlainObject(event.error) ? event.error : {};
      providerError = {
        type: typeof error.type === "string" ? error.type : "unknown",
        message: typeof error.message === "string" ? error.message.slice(0, 300) : "",
      };
    }
  }
  const stream = { bytes: text.length, events };
  if (!started) {
    return {
      usage: unmetered("USAGE_ABSENT"),
      ...(providerError ? { providerError } : {}),
      stream,
    };
  }
  return { usage: readUsage({ usage: merged }), ...(model ? { model } : {}), stream };
}
