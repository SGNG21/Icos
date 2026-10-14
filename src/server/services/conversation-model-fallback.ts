/**
 * FALLBACK WITHIN AN EXPLICIT LIST, AND NOWHERE ELSE (owner decision 2026-10-14).
 *
 * A conversation call tries its models in the order given and moves to the next ONLY when the
 * failure says "this model, right now" — HTTP 429, HTTP 5xx, or a timeout. Anything else is
 * thrown as is, at once: a 4xx is a request or credential problem another model will not fix,
 * a budget refusal is about the conversation and not the model, and a caller's cancellation
 * is a decision. When the list is spent, {@link ConversationModelsExhaustedError} is thrown;
 * both conversation layers already report a thrown error as unavailability (the CEO service's
 * "Le cerveau ICOS est indisponible : …", the cognitive runtime's failed turn). There is no
 * implicit last resort: not the gateway's first listed id, not a meta-route.
 */

/** A non-2xx answer from the gateway, with its status kept for the fallback decision. */
export class ConversationHttpError extends Error {
  override readonly name = "ConversationHttpError";
  constructor(
    readonly status: number,
    readonly model: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ModelAttemptFailure {
  readonly model: string;
  readonly failure: string;
}

export class ConversationModelsExhaustedError extends Error {
  override readonly name = "ConversationModelsExhaustedError";
  constructor(readonly attempts: readonly ModelAttemptFailure[]) {
    super(
      `CONVERSATION_MODELS_EXHAUSTED: ${attempts.map((a) => `${a.model} → ${a.failure}`).join(" | ")}`,
    );
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/** 429, 5xx, timeout: the only failures that justify trying the next listed model. */
export function isModelFallbackFailure(error: unknown): boolean {
  if (error instanceof ConversationHttpError) {
    return error.status === 429 || (error.status >= 500 && error.status <= 599);
  }
  return isTimeout(error);
}

function describe(error: unknown): string {
  if (error instanceof ConversationHttpError) return `HTTP ${error.status}`;
  if (isTimeout(error)) return "timeout";
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export interface ModelFallbackOptions {
  /** The caller's own signal (user cancellation). Aborted ⇒ no further model is tried. */
  readonly signal?: AbortSignal;
  /** Budget for the WHOLE chain: a fallback never extends what the caller was promised. */
  readonly totalTimeoutMs: number;
  /** Budget for one attempt, so a hung first model still leaves time for the next. */
  readonly attemptTimeoutMs: number;
}

export async function completeWithModelFallback<T>(
  models: readonly string[],
  attempt: (model: string, signal: AbortSignal) => Promise<T>,
  options: ModelFallbackOptions,
): Promise<T> {
  if (models.length === 0) throw new ConversationModelsExhaustedError([]);
  const deadline = AbortSignal.timeout(options.totalTimeoutMs);
  const failures: ModelAttemptFailure[] = [];

  for (const [index, model] of models.entries()) {
    const signals = [deadline, AbortSignal.timeout(options.attemptTimeoutMs)];
    if (options.signal) signals.push(options.signal);
    try {
      return await attempt(model, AbortSignal.any(signals));
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (!isModelFallbackFailure(error)) throw error;
      failures.push({ model, failure: describe(error) });
      const next = deadline.aborted ? undefined : models[index + 1];
      /* Named diagnostic, on stderr like the spend diagnostics: never silent. */
      console.warn(
        JSON.stringify({
          event: "CONVERSATION_MODEL_FALLBACK",
          from: model,
          failure: describe(error),
          to: next ?? null,
        }),
      );
      if (next === undefined) break;
    }
  }
  throw new ConversationModelsExhaustedError(failures);
}
