import { createHash } from "node:crypto";

import type { Skill } from "@/core/contracts/skill";

/**
 * Sérialisation canonique déterministe pour le contentHash.
 *
 * Propriétés :
 * - Clés triées alphabétiquement à chaque niveau
 * - Tableaux triés selon des règles stables
 * - `null` pour les absents, jamais `undefined`
 * - Pas d'espaces superflus
 * - Ordre JSON d'entrée n'affecte pas le résultat
 */
function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalStringify(item));
    return `[${items.join(",")}]`;
  }

  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys.map((key) => {
      const val = (value as Record<string, unknown>)[key];
      // Skip undefined values — treat as absent
      if (val === undefined) {
        return "";
      }
      return `${canonicalStringify(key)}:${canonicalStringify(val)}`;
    });
    return `{${pairs.filter(Boolean).join(",")}}`;
  }

  return String(value);
}

/**
 * Helper pour trier un tableau de façon stable par une clé donnée.
 */
function sortByKey<T>(arr: T[], keyFn: (item: T) => string): T[] {
  return [...arr].sort((a, b) => keyFn(a).localeCompare(keyFn(b)));
}

/**
 * Prépare le payload canonique pour le hash d'un skill.
 * N'inclut que les champs content-relevant de la spec §9.
 *
 * Champs exclus (ne participent PAS au hash) :
 * - id, tenantId, createdAt, updatedAt
 * - trustState, activationState
 * - dataCategory, sensitivityLevel
 * - provenance (sauf originalManifest)
 * - securityScans, findings, evaluations
 */
export function buildHashPayload(skill: Omit<Skill, "id" | "tenantId" | "createdAt" | "updatedAt">): Record<string, unknown> {
  return {
    skillKey: skill.skillKey,
    version: skill.version,
    name: skill.name,
    description: skill.description ?? null,
    category: skill.category,
    capabilityKeys: sortByKey(skill.capabilityKeys ?? [], (k) => k),
    scripts: sortByKey(skill.scripts ?? [], (s) => s.name),
    resources: sortByKey(skill.resources ?? [], (r) => r.path),
    references: sortByKey(skill.references ?? [], (r) => r.url),
    dependencyDeclarations: sortByKey(skill.dependencyDeclarations ?? [], (d) => d.dependencySkillKey),
    networkRequirements: sortByKey(skill.networkRequirements ?? [], (n) => `${n.requiredDomain}:${n.purpose}`),
    credentialRequirements: sortByKey(skill.credentialRequirements ?? [], (c) => c.requiredCredentialKind),
    executionIsolationRequirement: skill.executionIsolationRequirement ?? null,
    toolRequirements: sortByKey(skill.toolRequirements ?? [], (t) => t.requiredTool),
    inputSchema: skill.inputSchema ?? null,
    outputSchema: skill.outputSchema ?? null,
    // originalManifest: inclus car security/content relevant
    originalManifest: skill.provenance?.originalManifest ?? null,
  };
}

/**
 * Calcule le contentHash SHA-256 canonique pour un skill.
 * Déterministe : même entrée → même hash.
 */
export function computeSkillHash(
  skill: Omit<Skill, "id" | "tenantId" | "createdAt" | "updatedAt">,
): string {
  const payload = buildHashPayload(skill);
  const serialized = canonicalStringify(payload);
  return createHash("sha256").update(serialized, "utf-8").digest("hex");
}

/**
 * Vérifie si le hash d'un skill correspond au hash attendu.
 */
export function verifySkillHash(
  skill: Omit<Skill, "id" | "tenantId" | "createdAt" | "updatedAt">,
  expectedHash: string,
): boolean {
  return computeSkillHash(skill) === expectedHash;
}
