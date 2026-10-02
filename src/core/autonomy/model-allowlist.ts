/**
 * Per-mission model/provider restriction.
 *
 * All registered compute workers currently expose identical capabilities, so
 * "only these models may be used for this mission" is inexpressible through
 * capabilities alone. This module expresses it as an explicit bounded value
 * attached to one mission.
 *
 * Fail-closed design, deliberately THREE distinguishable situations:
 *   - `{ mode: "unrestricted" }` — an explicit, named decision to allow any
 *     model. This is today's behaviour and the ONLY way to get it;
 *   - `{ mode: "allowlist", modelIds: [] }` — an explicit empty allowlist:
 *     nothing is allowed. Never conflated with "unrestricted";
 *   - a missing/malformed value — refused as MODEL_ALLOWLIST_MISSING.
 *
 * A two-state selector whose fallback is permissive is the exact fail-open
 * defect this repository has already shipped once (probe selector fail-open).
 * `decideModel` therefore never falls back to permissive; absence is converted
 * to the explicit unrestricted state only by `resolveModelAllowlist`.
 */
export interface UnrestrictedModelAllowlist {
  mode: "unrestricted";
}

export interface BoundedModelAllowlist {
  mode: "allowlist";

  /** Permitted model ids, compared EXACTLY. Empty means nothing is permitted. */
  modelIds: readonly string[];

  /**
   * Optional provider restriction. Absent means providers are unrestricted;
   * present means the caller must supply a provider id that is listed.
   */
  providerIds?: readonly string[];
}

export type MissionModelAllowlist = UnrestrictedModelAllowlist | BoundedModelAllowlist;

export const MODEL_ALLOWLIST_UNRESTRICTED: UnrestrictedModelAllowlist = Object.freeze({
  mode: "unrestricted",
});

export type ModelDecisionReason =
  | "MODEL_ALLOWED"
  | "MODEL_ALLOWLIST_UNRESTRICTED"
  | "MODEL_ALLOWLIST_EMPTY"
  | "MODEL_ALLOWLIST_MISSING"
  | "MODEL_NOT_IN_ALLOWLIST"
  | "PROVIDER_NOT_IN_ALLOWLIST"
  | "MODEL_ID_INVALID";

export interface ModelDecision {
  allowed: boolean;
  reason: ModelDecisionReason;
}

export interface ModelCandidate {
  modelId: string;
  providerId?: string;
}

/**
 * Builds a bounded allowlist. An EMPTY list is legal and means "deny all" —
 * it is not rejected, because an operator pausing a mission's compute is a
 * valid intent. Blank/non-string entries are rejected instead of stored.
 */
export function modelAllowlist(
  modelIds: readonly string[],
  providerIds?: readonly string[],
): BoundedModelAllowlist {
  return Object.freeze({
    mode: "allowlist" as const,
    modelIds: Object.freeze(frozenIds(modelIds, "modelIds")),
    ...(providerIds === undefined
      ? {}
      : { providerIds: Object.freeze(frozenIds(providerIds, "providerIds")) }),
  });
}

/**
 * The ONE boundary where "the caller asked for no restriction" becomes the
 * explicit unrestricted state. Keep it here so no decision path needs a
 * permissive `??` fallback of its own.
 */
export function resolveModelAllowlist(
  requested: MissionModelAllowlist | null | undefined,
): MissionModelAllowlist {
  return requested ?? MODEL_ALLOWLIST_UNRESTRICTED;
}

export function decideModel(
  allowlist: MissionModelAllowlist,
  candidate: ModelCandidate,
): ModelDecision {
  if (!isAllowlist(allowlist)) {
    return { allowed: false, reason: "MODEL_ALLOWLIST_MISSING" };
  }

  const modelId = candidate?.modelId;

  if (typeof modelId !== "string" || modelId.trim().length === 0) {
    return { allowed: false, reason: "MODEL_ID_INVALID" };
  }

  if (allowlist.mode === "unrestricted") {
    return { allowed: true, reason: "MODEL_ALLOWLIST_UNRESTRICTED" };
  }

  if (allowlist.modelIds.length === 0 || allowlist.providerIds?.length === 0) {
    return { allowed: false, reason: "MODEL_ALLOWLIST_EMPTY" };
  }

  if (!allowlist.modelIds.includes(modelId)) {
    return { allowed: false, reason: "MODEL_NOT_IN_ALLOWLIST" };
  }

  if (allowlist.providerIds && !allowlist.providerIds.includes(candidate.providerId as string)) {
    return { allowed: false, reason: "PROVIDER_NOT_IN_ALLOWLIST" };
  }

  return { allowed: true, reason: "MODEL_ALLOWED" };
}

export function isModelAllowed(
  allowlist: MissionModelAllowlist,
  modelId: string,
  providerId?: string,
): boolean {
  return decideModel(allowlist, { modelId, providerId }).allowed;
}

function isAllowlist(value: unknown): value is MissionModelAllowlist {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const mode = (value as { mode?: unknown }).mode;

  if (mode === "unrestricted") {
    return true;
  }

  return mode === "allowlist" && Array.isArray((value as { modelIds?: unknown }).modelIds);
}

function frozenIds(ids: readonly string[], field: string): string[] {
  if (!Array.isArray(ids)) {
    throw new Error(`MODEL_ALLOWLIST_INVALID:${field} must be an array`);
  }

  return ids.map((id, index) => {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Error(`MODEL_ALLOWLIST_INVALID:${field}[${index}] must be a non-blank string`);
    }

    return id;
  });
}
