import { z } from "zod";

import type {
  SkillCandidate,
  SkillsMpErrorCode,
  CandidateProvenance,
  CapabilityClaimEvidence,
  CompatibilityHint,
} from "@/core/contracts/skill-candidate";
import { SkillsMpError } from "@/core/contracts/skill-candidate";
import {
  buildCandidateProvenanceFromSkillsMp,
  computeCandidateHash,
  extractCapabilityClaimsFromSkillsMp,
  extractCompatibilityHintsFromSkillsMp,
  sanitizeString,
  sanitizeUrl,
} from "@/core/skills/candidate";

/**
 * Schéma de validation défensif pour la réponse SkillsMP.
 * N'accepte que les champs observés à l'exécution ; tout le reste est ignoré.
 */
const skillsMpSkillSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string().min(1),
  description: z.string().optional(),
  author: z.string().optional(),
  contentLanguage: z.string().optional(),
  githubUrl: z.string().optional(),
  skillUrl: z.string().optional(),
  stars: z.number().int().optional(),
  updatedAt: z.number().int().optional(),
  // Ne pas accepter de champs non documentés/observés
});

const skillsMpPaginationSchema = z.object({
  page: z.number().int().min(1),
  limit: z.number().int().min(1),
  total: z.number().int().min(0).optional(),
  totalPages: z.number().int().min(0).optional(),
  hasNext: z.boolean(),
  hasPrev: z.boolean(),
  totalIsExact: z.boolean().optional(),
  isCapped: z.boolean().optional(),
});

const skillsMpDataSchema = z.object({
  skills: z.array(skillsMpSkillSchema),
  pagination: skillsMpPaginationSchema,
  filters: z.record(z.string(), z.unknown()).optional(),
});

const skillsMpMetaSchema = z.object({
  requestId: z.string().optional(),
  responseTimeMs: z.number().optional(),
});

const skillsMpResponseSchema = z.object({
  success: z.boolean(),
  data: skillsMpDataSchema.optional(),
  meta: skillsMpMetaSchema.optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

/**
 * Configuration du provider SkillsMP.
 */
export interface SkillsMpConfig {
  /** Clé API (injectée, jamais lue directement depuis process.env dans l'adaptateur) */
  apiKey: string;
  /** URL de base de l'API (permet l'injection pour tests) */
  baseUrl: string;
  /** Timeout en millisecondes */
  timeoutMs: number;
  /** Clé HTTP client injectée (permet mock fetch) */
  fetch: typeof fetch;
  /** Horloge injectée (permet temps déterministe) */
  clock: () => Date;
}

/**
 * Résultat de recherche SkillsMP.
 */
export interface SkillsMpSearchResult {
  candidates: SkillCandidate[];
  pagination: {
    page: number;
    limit: number;
    total: number | undefined;
    totalPages: number | undefined;
    hasNext: boolean;
    hasPrev: boolean;
    totalIsExact: boolean | undefined;
    isCapped: boolean | undefined;
  };
  rateLimit: {
    dailyLimit: number | null;
    dailyRemaining: number | null;
    minuteRemaining: number | null;
  };
}

/**
 * Codes d'erreur SkillsMP typés.
 */
export const SKILLSMP_ERROR_CODES = {
  CREDENTIAL_UNAVAILABLE: "SKILLSMP_CREDENTIAL_UNAVAILABLE" as SkillsMpErrorCode,
  RATE_LIMITED: "SKILLSMP_RATE_LIMITED" as SkillsMpErrorCode,
  UNAVAILABLE: "SKILLSMP_UNAVAILABLE" as SkillsMpErrorCode,
  AUTH_FAILED: "SKILLSMP_AUTH_FAILED" as SkillsMpErrorCode,
  INVALID_RESPONSE: "SKILLSMP_INVALID_RESPONSE" as SkillsMpErrorCode,
  TIMEOUT: "SKILLSMP_TIMEOUT" as SkillsMpErrorCode,
  CANDIDATE_INCOMPLETE: "SKILLSMP_CANDIDATE_INCOMPLETE" as SkillsMpErrorCode,
  SOURCE_UNAVAILABLE: "SKILLSMP_SOURCE_UNAVAILABLE" as SkillsMpErrorCode,
} as const;

/**
 * Extrait les en-têtes de rate-limit de la réponse (jamais loggés bruts).
 */
function extractRateLimitHeaders(headers: Headers): {
  dailyLimit: number | null;
  dailyRemaining: number | null;
  minuteRemaining: number | null;
} {
  const dailyLimit = headers.get("x-ratelimit-daily-limit");
  const dailyRemaining = headers.get("x-ratelimit-daily-remaining");
  const minuteRemaining = headers.get("x-ratelimit-minute-remaining");

  return {
    dailyLimit: dailyLimit ? parseInt(dailyLimit, 10) : null,
    dailyRemaining: dailyRemaining ? parseInt(dailyRemaining, 10) : null,
    minuteRemaining: minuteRemaining ? parseInt(minuteRemaining, 10) : null,
  };
}

/**
 * Mappe un statut HTTP + corps d'erreur vers un code d'erreur SkillsMP typé.
 */
function mapHttpErrorToSkillsMpError(
  status: number,
  body: z.infer<typeof skillsMpResponseSchema>,
  retryAfterHeader: string | null,
): SkillsMpError {
  const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;

  switch (status) {
    case 401:
    case 403:
      return new SkillsMpError(
        SKILLSMP_ERROR_CODES.AUTH_FAILED,
        "Authentification SkillsMP échouée",
        retryAfterSeconds,
      );
    case 429:
      return new SkillsMpError(
        SKILLSMP_ERROR_CODES.RATE_LIMITED,
        "Limite de taux SkillsMP atteinte",
        retryAfterSeconds ?? 60,
      );
    case 503:
    case 502:
    case 504:
      return new SkillsMpError(
        SKILLSMP_ERROR_CODES.UNAVAILABLE,
        "Service SkillsMP indisponible",
        retryAfterSeconds ?? 30,
      );
    case 400:
      return new SkillsMpError(
        SKILLSMP_ERROR_CODES.INVALID_RESPONSE,
        body?.error?.message ?? "Requête invalide",
        retryAfterSeconds,
      );
    default:
      return new SkillsMpError(
        SKILLSMP_ERROR_CODES.INVALID_RESPONSE,
        `Erreur HTTP ${status}`,
        retryAfterSeconds,
      );
  }
}

/**
 * Normalise un skill SkillsMP brut en candidat ICOS (fail-closed).
 * Retourne null si le skill est incomplet (champs obligatoires manquants).
 */
function normalizeSkillsMpSkill(
  rawSkill: z.infer<typeof skillsMpSkillSchema>,
  discoveredAt: string,
): SkillCandidate | null {
  // Validation défensive : champs obligatoires
  if (!rawSkill.id || !rawSkill.name) {
    return null;
  }

  const normalizedRawSkill = {
  id: String(rawSkill.id),
  githubUrl: rawSkill.githubUrl ?? undefined,
  skillUrl: rawSkill.skillUrl ?? undefined,
  updatedAt: rawSkill.updatedAt ?? undefined
};
const provenance = buildCandidateProvenanceFromSkillsMp(normalizedRawSkill, discoveredAt);
  const capabilityClaims = extractCapabilityClaimsFromSkillsMp(rawSkill);
  const compatibilityHints = extractCompatibilityHintsFromSkillsMp(rawSkill);

  const candidate: Omit<
    SkillCandidate,
    "rawMetadataHash" | "verificationState" | "trustState" | "securityState" | "compatibilityState"
  > = {
    candidateId: `cand-skillsmp-${String(rawSkill.id)}`,
    providerId: "skillsmp",
    externalId: String(rawSkill.id),
    name: sanitizeString(rawSkill.name),
    description: rawSkill.description ? sanitizeString(rawSkill.description) : undefined,
    sourceUrl: sanitizeUrl(rawSkill.skillUrl) ?? undefined,
    sourceRepository: sanitizeUrl(rawSkill.githubUrl) ?? undefined,
    sourceCommitOrVersion: rawSkill.updatedAt ? String(rawSkill.updatedAt) : undefined,
    maintainer: rawSkill.author ? sanitizeString(rawSkill.author) : undefined,
    tags: rawSkill.contentLanguage ? [sanitizeString(rawSkill.contentLanguage)] : [],
    capabilityClaims,
    compatibilityHints,
    provenance,
  };

  // Construire le candidat complet avec hash et états fail-closed
  const fullCandidate: SkillCandidate = {
    ...candidate,
    rawMetadataHash: computeCandidateHash({
      ...candidate,
      rawMetadataHash: "",
      verificationState: "verified",
      trustState: "untrusted",
      securityState: "pending",
      compatibilityState: "unknown",
    }),
    verificationState: "verified",
    trustState: "untrusted",
    securityState: "pending",
    compatibilityState: "unknown",
  };

  return fullCandidate;
}

/**
 * Provider SkillsMP read-only.
 * Ne fait QUE de la découverte — AUCUN téléchargement, installation, import, approbation, activation, exécution.
 */
export class SkillsMpProvider {
  private readonly config: SkillsMpConfig;

  constructor(config: SkillsMpConfig) {
    this.config = config;
  }

  /**
   * Recherche des compétences sur SkillsMP.
   * Lecture seule, pagination via hasNext, validation défensive.
   */
  async search(query: string, page = 1, limit = 20): Promise<SkillsMpSearchResult> {
    // Vérification de credential
    if (!this.config.apiKey || this.config.apiKey.length === 0) {
      throw new SkillsMpError(
        SKILLSMP_ERROR_CODES.CREDENTIAL_UNAVAILABLE,
        "Clé API SkillsMP non disponible",
      );
    }

    // Validation des paramètres
    if (page < 1) page = 1;
    if (limit < 1) limit = 50; // Max observé dans OpenAPI
    if (limit > 50) limit = 50;

    const url = new URL(`${this.config.baseUrl}/api/v1/skills/search`);
    url.searchParams.set("q", sanitizeString(query, 200));
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(limit));
    // sortBy, category, occupation, language — non supportés pour l'instant (UNKNOWN)

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let response: Response;
    try {
      response = await this.config.fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          Accept: "application/json",
        },
        signal: controller.signal,
        redirect: "error",
      });
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new SkillsMpError(SKILLSMP_ERROR_CODES.TIMEOUT, "Timeout SkillsMP", undefined);
      }
      throw new SkillsMpError(
        SKILLSMP_ERROR_CODES.UNAVAILABLE,
        "Échec de connexion SkillsMP",
        undefined,
      );
    } finally {
      clearTimeout(timeoutId);
    }

    // Rate limit headers (sanitized)
    const rateLimit = extractRateLimitHeaders(response.headers);

    // Parse body
    let body: z.infer<typeof skillsMpResponseSchema>;
    try {
      body = await response.json();
    } catch {
      throw new SkillsMpError(SKILLSMP_ERROR_CODES.INVALID_RESPONSE, "Réponse SkillsMP non-JSON");
    }

    // Validation défensive de l'enveloppe
    const parseResult = skillsMpResponseSchema.safeParse(body);
    if (!parseResult.success) {
      throw new SkillsMpError(
        SKILLSMP_ERROR_CODES.INVALID_RESPONSE,
        "Structure de réponse SkillsMP invalide",
      );
    }

    const validated = parseResult.data;

    // Gestion erreurs HTTP + enveloppe
    if (!response.ok || validated.success === false) {
      const retryAfter = response.headers.get("retry-after");
      throw mapHttpErrorToSkillsMpError(response.status, validated, retryAfter);
    }

    if (!validated.data) {
      throw new SkillsMpError(
        SKILLSMP_ERROR_CODES.INVALID_RESPONSE,
        "Données de réponse SkillsMP manquantes",
      );
    }

    const discoveredAt = this.config.clock().toISOString();
    const candidates: SkillCandidate[] = [];

    for (const rawSkill of validated.data.skills) {
      const normalized = normalizeSkillsMpSkill(rawSkill, discoveredAt);
      if (normalized) {
        candidates.push(normalized);
      }
      // Skills incomplets sont silencieusement ignorés (fail-closed)
    }

    return {
      candidates,
      pagination: {
        page: validated.data.pagination.page,
        limit: validated.data.pagination.limit,
        total: validated.data.pagination.total,
        totalPages: validated.data.pagination.totalPages,
        hasNext: validated.data.pagination.hasNext,
        hasPrev: validated.data.pagination.hasPrev,
        totalIsExact: validated.data.pagination.totalIsExact,
        isCapped: validated.data.pagination.isCapped,
      },
      rateLimit,
    };
  }

  /**
   * Recherche itérative toutes les pages (jusqu'à hasNext = false).
   * Attention : peut faire plusieurs requêtes — utiliser avec modération.
   */
  async searchAllPages(query: string, maxPages = 10): Promise<SkillCandidate[]> {
    const allCandidates: SkillCandidate[] = [];
    let page = 1;
    let hasNext = true;

    while (hasNext && page <= maxPages) {
      const result = await this.search(query, page, 50);
      allCandidates.push(...result.candidates);
      hasNext = result.pagination.hasNext;
      page++;
    }

    return allCandidates;
  }
}

/**
 * Crée une configuration par défaut pour le provider (utilise process.env en prod).
 * Pour les tests, injecter fetch/clock mock.
 */
export function createSkillsMpConfig(overrides?: Partial<SkillsMpConfig>): SkillsMpConfig {
  return {
    apiKey: process.env.SKILLSMP_API_KEY ?? "",
    baseUrl: "https://skillsmp.com",
    timeoutMs: 10_000,
    fetch: globalThis.fetch.bind(globalThis),
    clock: () => new Date(),
    ...overrides,
  };
}
