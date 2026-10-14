import type { Message } from "@/core/ceo/contracts";
import {
  conversationModelPlan,
  type ConversationModelPlan,
} from "@/core/cognitive/conversation-models";
import {
  completeWithModelFallback,
  ConversationHttpError,
} from "@/server/services/conversation-model-fallback";

/** One attempt per listed model; the old primary + fallback pair took at most 2 × 60 s. */
const ATTEMPT_TIMEOUT_MS = 60_000;
const TOTAL_TIMEOUT_MS = 120_000;

interface OmniRouteChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export class OmniRouteCeoClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  /**
   * The ordered, explicit models this conversation may use (see `conversationModelPlan`):
   * ICOS_CONVERSATION_MODELS, else the configured ICOS_CEO_MODEL / ICOS_REVIEWER_MODEL alone,
   * else the measured free default. A meta-route anywhere in them refuses construction.
   */
  readonly plan: ConversationModelPlan;
  /**
   * Seam de transport. Les quatre autres appelants OmniRoute acceptent déjà un `typeof fetch`
   * injectable ; celui-ci appelait le `fetch` global, donc le compteur de dépense ne pouvait pas
   * l'atteindre et son coût restait non mesuré. Paramètre optionnel : aucun appelant existant ne change.
   */
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)) {
    const baseUrl = process.env.OMNIROUTE_BASE_URL;
    const apiKey = process.env.OMNIROUTE_API_KEY;

    if (!baseUrl || !apiKey) {
      throw new Error("ICOS_AI_NOT_CONFIGURED");
    }

    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;

    this.plan = conversationModelPlan(process.env);
  }

  private async request(model: string, messages: Message[], signal: AbortSignal): Promise<string> {
    // On n'envoie pas toute la vie de la conversation au modèle.
    const recentMessages = messages.slice(-20);

    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        /*
         * EXPLICIT (same rule as cognition.ts, dec9fcb): this caller reads ONE JSON body, and
         * OmniRoute 3.8.49 answers text/event-stream when `stream` is absent.
         */
        stream: false,
        messages: [
          {
            role: "system",
            content: [
              "Tu es ICOS, le cerveau central du cockpit ICOS.",
              "Tu réponds en français sauf demande contraire.",
              "Tu es précis, opérationnel et concis.",
              "Tu n'affirmes jamais avoir exécuté une action qui n'a pas réellement été exécutée.",
              "Tu distingues conversation, analyse, mission, worker, approbation et exécution.",
              "Lorsqu'une action nécessite une mission ou une approbation, tu l'indiques explicitement.",
            ].join("\n"),
          },
          ...recentMessages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        ],
      }),
      cache: "no-store",
      signal,
    });

    if (!response.ok) {
      throw new ConversationHttpError(
        response.status,
        model,
        `OmniRoute chat HTTP ${response.status} (${model})`,
      );
    }

    const payload = (await response.json()) as OmniRouteChatResponse;
    const content = payload.choices?.[0]?.message?.content?.trim();

    if (!content) {
      throw new Error(`Réponse OmniRoute vide (${model})`);
    }

    return content;
  }

  /**
   * Tries `plan.models` in order; moves on ONLY on 429 / 5xx / timeout, and only to the next
   * listed model. Exhausted ⇒ `ConversationModelsExhaustedError`, which `CeoApplicationService`
   * reports as "Le cerveau ICOS est indisponible : …". Never the gateway's first listed id,
   * never a meta-route.
   */
  async answer(messages: Message[]): Promise<string> {
    return completeWithModelFallback(
      this.plan.models,
      (model, signal) => this.request(model, messages, signal),
      { totalTimeoutMs: TOTAL_TIMEOUT_MS, attemptTimeoutMs: ATTEMPT_TIMEOUT_MS },
    );
  }
}
