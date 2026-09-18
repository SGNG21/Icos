import type {
  ReviewerPort,
  ReviewInput,
  ReviewDecision,
  RequestedChange,
} from "@/server/review/ports";

/**
 * Fake reviewer pour tests unitaires.
 * Comportement configurable via constructeur.
 */
export class FakeReviewer implements ReviewerPort {
  private readonly workflowResponses: Map<
    string,
    {
      decision: ReviewDecision;
      reasons: string[];
      requestedChanges?: RequestedChange[];
      confidence?: number;
      providerMetadata?: {
        provider: string;
        model: string;
        temperature?: number;
        promptVersion?: string;
      };
    }
  > = new Map();

  private readonly defaultResponse: {
    decision: ReviewDecision;
    reasons: string[];
    requestedChanges?: RequestedChange[];
    confidence?: number;
    providerMetadata?: {
      provider: string;
      model: string;
      temperature?: number;
      promptVersion?: string;
    };
  } = {
    decision: "APPROVE" as ReviewDecision,
    reasons: ["Fake reviewer: auto-approve for testing"],
    requestedChanges: undefined,
    confidence: 0.9,
    providerMetadata: {
      provider: "fake",
      model: "fake-reviewer-v1",
      temperature: 0,
      promptVersion: "test",
    },
  };

  constructor(options?: {
    workflowResponses?: Map<
      string,
      {
        decision: ReviewDecision;
        reasons: string[];
        requestedChanges?: RequestedChange[];
        confidence?: number;
        providerMetadata?: {
          provider: string;
          model: string;
          temperature?: number;
          promptVersion?: string;
        };
      }
    >;
    defaultResponse?: {
      decision: ReviewDecision;
      reasons: string[];
      requestedChanges?: RequestedChange[];
      confidence?: number;
      providerMetadata?: {
        provider: string;
        model: string;
        temperature?: number;
        promptVersion?: string;
      };
    };
  }) {
    if (options?.workflowResponses) {
      this.workflowResponses = options.workflowResponses;
    }
    if (options?.defaultResponse) {
      this.defaultResponse = options.defaultResponse;
    }
  }

  async review(input: ReviewInput): Promise<{
    decision: ReviewDecision;
    reasons: string[];
    requestedChanges?: RequestedChange[];
    confidence?: number;
    providerMetadata?: {
      provider: string;
      model: string;
      temperature?: number;
      promptVersion?: string;
    };
  }> {
    const key = input.executionResult.workflowId;
    const response = this.workflowResponses.get(key) ?? this.defaultResponse;
    return response;
  }

  /** Configure une réponse pour un workflowId spécifique */
  setResponse(
    workflowId: string,
    response: {
      decision: ReviewDecision;
      reasons: string[];
      requestedChanges?: RequestedChange[];
      confidence?: number;
      providerMetadata?: {
        provider: string;
        model: string;
        temperature?: number;
        promptVersion?: string;
      };
    },
  ) {
    this.workflowResponses.set(workflowId, {
      ...response,
      providerMetadata: response.providerMetadata ?? {
        provider: "fake",
        model: "fake-reviewer-v1",
        temperature: 0,
        promptVersion: "test",
      },
    });
  }

  /** Reset à la réponse par défaut */
  reset() {
    this.workflowResponses.clear();
  }
}
