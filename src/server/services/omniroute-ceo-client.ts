import type { Message } from "@/core/ceo/contracts";

interface OmniRouteModelsResponse {
  data?: Array<{ id?: string }>;
}

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
  private readonly configuredModel?: string;
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

    this.configuredModel =
      process.env.ICOS_CEO_MODEL ??
      process.env.ICOS_REVIEWER_MODEL ??
      undefined;
  }

  private async resolveModel(): Promise<string> {
    if (this.configuredModel) {
      return this.configuredModel;
    }

    const response = await this.fetchImpl(`${this.baseUrl}/v1/models`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`OmniRoute models HTTP ${response.status}`);
    }

    const payload = (await response.json()) as OmniRouteModelsResponse;

    const model =
      payload.data?.find((item) => item.id === "auto/best-chat")?.id ??
      payload.data?.find((item) => item.id)?.id;

    if (!model) {
      throw new Error("Aucun modèle disponible dans OmniRoute");
    }

    return model;
  }

  private async request(
    model: string,
    messages: Message[],
  ): Promise<string> {
    // On n'envoie pas toute la vie de la conversation au modèle.
    const recentMessages = messages.slice(-20);

    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
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
        signal: AbortSignal.timeout(60000),
      },
    );

    if (!response.ok) {
      throw new Error(
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

  async answer(messages: Message[]): Promise<string> {
    const primaryModel = await this.resolveModel();

    try {
      return await this.request(primaryModel, messages);
    } catch (primaryError) {
      // Si auto/best-chat rencontre un provider lent ou défaillant,
      // on tente une route NVIDIA conversationnelle.
      if (primaryModel === "auto/nvidia-chat") {
        throw primaryError;
      }

      try {
        return await this.request("auto/nvidia-chat", messages);
      } catch (fallbackError) {
        const primary =
          primaryError instanceof Error
            ? primaryError.message
            : "erreur primaire inconnue";

        const fallback =
          fallbackError instanceof Error
            ? fallbackError.message
            : "erreur fallback inconnue";

        throw new Error(
          `Primaire: ${primary} | Fallback: ${fallback}`,
        );
      }
    }
  }
}
