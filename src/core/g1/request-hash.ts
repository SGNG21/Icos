import { createHash } from "node:crypto";

import type { RequestHash } from "@/core/contracts/g1";

/**
 * Canonical invocation data that participates in requestHash.
 */
export interface RequestHashInput {
  tenant: string;
  principal: string;
  toolId: string;
  toolDefinitionHash: string;
  toolVersion?: string;
  capability: string;
  operation: string;
  resource: string;
  canonicalArguments: Record<string, unknown>;
  externalEffectScope?: string[];
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
 * Computes a deterministic requestHash SHA-256 over the canonical invocation
 * identity. The hash covers all fields that identify the invocation
 * unambiguously: tenant, principal, toolId, toolDefinitionHash, capability,
 * operation, resource, canonical arguments, and external-effect scope.
 *
 * Any mismatch between expected and actual requestHash → FAIL CLOSED.
 */
export function computeRequestHash(input: RequestHashInput): RequestHash {
  const payload: Record<string, unknown> = {
    tenant: input.tenant,
    principal: input.principal,
    toolId: input.toolId,
    toolDefinitionHash: input.toolDefinitionHash,
    toolVersion: input.toolVersion ?? null,
    capability: input.capability,
    operation: input.operation,
    resource: input.resource,
    canonicalArguments: input.canonicalArguments,
    externalEffectScope: input.externalEffectScope
      ? [...input.externalEffectScope].sort()
      : null,
  };

  const serialized = canonicalStringify(payload);
  return createHash("sha256").update(serialized, "utf-8").digest("hex") as RequestHash;
}

/**
 * Verifies that a requestHash matches the canonical invocation input.
 */
export function verifyRequestHash(
  input: RequestHashInput,
  expectedHash: RequestHash,
): boolean {
  return computeRequestHash(input) === expectedHash;
}
