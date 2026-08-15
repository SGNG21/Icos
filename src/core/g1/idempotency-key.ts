import { createHash } from "node:crypto";

import type { IdempotencyKey } from "@/core/contracts/g1";

/**
 * Canonical identity data for IdempotencyKey derivation.
 */
export interface IdempotencyKeyInput {
  tenant: string;
  mission: string;
  toolId: string;
  capability: string;
  operation: string;
  resource: string;
  canonicalArguments: Record<string, unknown>;
}

/**
 * Canonical deterministic JSON serialization (sorted keys, no undefined).
 */
function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalStringify(item));
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys
      .map((key) => {
        const val = (value as Record<string, unknown>)[key];
        if (val === undefined) return "";
        return `${canonicalStringify(key)}:${canonicalStringify(val)}`;
      })
      .filter(Boolean);
    return `{${pairs.join(",")}}`;
  }
  return String(value);
}

/**
 * Derives a deterministic IdempotencyKey from the stable business identity
 * of an invocation: tenant, mission, toolId, capability, operation,
 * resource, and canonical arguments.
 *
 * `AttemptNumber` is distinct from `IdempotencyKey`: a technical retry
 * preserves the same key, only incrementing the attempt counter.
 *
 * Deterministic: same input → same key (always).
 */
export function deriveIdempotencyKey(input: IdempotencyKeyInput): IdempotencyKey {
  const payload: Record<string, unknown> = {
    tenant: input.tenant,
    mission: input.mission,
    toolId: input.toolId,
    capability: input.capability,
    operation: input.operation,
    resource: input.resource,
    canonicalArguments: input.canonicalArguments,
  };

  const serialized = canonicalStringify(payload);
  return createHash("sha256").update(serialized, "utf-8").digest("hex") as IdempotencyKey;
}
