import { createHash } from "node:crypto";

import type { SkillCandidate, CapabilityClaimEvidence, CompatibilityHint, CandidateProvenance } from "@/core/contracts/skill-candidate";

/**
 * Sérialisation canonique déterministe pour le hash de métadonnées candidat.
 * Mêmes règles que le skill canonicalStringify mais appliqué aux métadonnées candidat.
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
 * Trie stable par clé.
 */
function sortByKey<T>(arr: T[], keyFn: (item: T) => string): T[] {
  return [...arr].sort((a, b) => keyFn(a).localeCompare(keyFn(b)));
}

/**
 * Prépare le payload canonique pour le hash d'un candidat.
 * N'inclut que les métadonnées normalisées, pas les métadonnées brutes du provider.
 */
export function buildCandidateHashPayload(candidate: SkillCandidate): Record<string, unknown> {
  return {
    candidateId: candidate.candidateId,
    providerId: candidate.providerId,
    externalId: candidate.externalId,
    name: candidate.name,
    description: candidate.description ?? null,
    sourceUrl: candidate.sourceUrl ?? null,
    sourceRepository: candidate.sourceRepository ?? null,
    sourceCommitOrVersion: candidate.sourceCommitOrVersion ?? null,
    maintainer: candidate.maintainer ?? null,
    tags: sortByKey(candidate.tags ?? [], (t) => t),
    capabilityClaims: sortByKey(candidate.capabilityClaims ?? [], (c) => c.capabilityKey).map((c) => ({
      capabilityKey: c.capabilityKey,
      evidenceType: c.evidenceType,
      description: c.description,
      confidence: c.confidence ?? 0.5,
      sourceRef: c.sourceRef ?? null,
    })),
    compatibilityHints: sortByKey(candidate.compatibilityHints ?? [], (h) => h.target).map((h) => ({
      target: h.target,
      hintType: h.hintType,
      description: h.description,
      version: h.version ?? null,
    })),
    provenance: {
      providerId: candidate.provenance.providerId,
      externalId: candidate.provenance.externalId,
      discoveryUrl: candidate.provenance.discoveryUrl ?? null,
      sourceRepository: candidate.provenance.sourceRepository ?? null,
      sourceCommitOrVersion: candidate.provenance.sourceCommitOrVersion ?? null,
      maintainer: candidate.provenance.maintainer ?? null,
      discoveredAt: candidate.provenance.discoveredAt,
      sourceUpdatedAt: candidate.provenance.sourceUpdatedAt ?? null,
    },
  };
}

/**
 * Calcule le hash déterministe SHA-256 des métadonnées normalisées du candidat.
 */
export function computeCandidateHash(candidate: SkillCandidate): string {
  const payload = buildCandidateHashPayload(candidate);
  const serialized = canonicalStringify(payload);
  return createHash("sha256").update(serialized, "utf-8").digest("hex");
}

/**
 * Vérifie si le hash d'un candidat correspond au hash attendu.
 */
export function verifyCandidateHash(candidate: SkillCandidate, expectedHash: string): boolean {
  return computeCandidateHash(candidate) === expectedHash;
}

/**
 * Clé de déduplication stable : providerId + externalId.
 * Deux candidats avec le même provider et le même externalId sont le même candidat.
 */
export function getDeduplicationKey(candidate: SkillCandidate): string {
  return `${candidate.providerId}:${candidate.externalId}`;
}

/**
 * Déduplique une liste de candidats par clé stable.
 * Garde le candidat avec la provenance la plus récente (sourceUpdatedAt puis discoveredAt).
 */
export function deduplicateCandidates(candidates: SkillCandidate[]): SkillCandidate[] {
  const map = new Map<string, SkillCandidate>();
  for (const c of candidates) {
    const key = getDeduplicationKey(c);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, c);
      continue;
    }
    // Comparer sourceUpdatedAt puis discoveredAt (ISO strings sont comparables lexicographiquement)
    const existingUpdated = existing.provenance.sourceUpdatedAt ?? existing.provenance.discoveredAt;
    const candidateUpdated = c.provenance.sourceUpdatedAt ?? c.provenance.discoveredAt;
    if (candidateUpdated > existingUpdated) {
      map.set(key, c);
    }
  }
  return Array.from(map.values());
}

/**
 * Rangement stable des candidats : par hash pour reproductibilité.
 */
export function sortCandidatesStable(candidates: SkillCandidate[]): SkillCandidate[] {
  return [...candidates].sort((a, b) => a.rawMetadataHash.localeCompare(b.rawMetadataHash));
}

/**
 * Mappe les revendications de capacité vers des clés de capacité ICOS canoniques.
 * Ne retourne QUE les clés pour lesquelles il existe au moins une preuve explicite.
 * Le titre/nom seul NE suffit pas.
 */
export function mapCapabilityClaimsToCanonical(
  claims: CapabilityClaimEvidence[],
  canonicalCapabilityKeys: Set<string>,
): string[] {
  const matched = new Set<string>();
  for (const claim of claims) {
    if (canonicalCapabilityKeys.has(claim.capabilityKey)) {
      matched.add(claim.capabilityKey);
    }
  }
  return Array.from(matched).sort();
}

/**
 * Calcule un score de confiance agrégé pour les capacités revendiquées.
 * Ne considère que les preuves explicites.
 */
export function computeCapabilityConfidence(
  claims: CapabilityClaimEvidence[],
  canonicalCapabilityKeys: Set<string>,
): Map<string, number> {
  const confidence = new Map<string, number>();
  for (const claim of claims) {
    if (canonicalCapabilityKeys.has(claim.capabilityKey)) {
      const current = confidence.get(claim.capabilityKey) ?? 0;
      confidence.set(claim.capabilityKey, Math.max(current, claim.confidence ?? 0.5));
    }
  }
  return confidence;
}

/**
 * Normalise et sanitisce une chaîne pour le stockage sûr.
 * Tronque à 2000 caractères, retire les caractères de contrôle.
 */
export function sanitizeString(value: string, maxLength = 2000): string {
  return value
    .replace(/[\x00-\x1F\x7F]/g, "") // caractères de contrôle
    .trim()
    .slice(0, maxLength);
}

/**
 * Sanitise une URL — retourne null si invalide ou absente.
 */
export function sanitizeUrl(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return sanitizeString(url.toString());
  } catch {
    return null;
  }
}

/**
 * Extrait les claims de capacité depuis les métadonnées brutes SkillsMP.
 * CRITIQUE : Ne crée PAS de claim sans preuve explicite.
 * Les champs SkillsMP (name, description, tags) NE sont PAS des preuves.
 */
export function extractCapabilityClaimsFromSkillsMp(skill: {
  name: string;
  description?: string;
  tags?: string[];
  githubUrl?: string;
  skillUrl?: string;
}): CapabilityClaimEvidence[] {
  // Aucun claim n'est créé ici — le titre/description/tags ne sont PAS des preuves
  // Cette fonction retourne un tableau vide pour forcer l'absence de claims
  // sans preuve. L'appelant DOIT fournir des preuves explicites.
  return [];
}

/**
 * Extrait les hints de compatibilité depuis les métadonnées brutes SkillsMP.
 */
export function extractCompatibilityHintsFromSkillsMp(skill: {
  name: string;
  description?: string;
  contentLanguage?: string;
  tags?: string[];
}): CompatibilityHint[] {
  const hints: CompatibilityHint[] = [];

  if (skill.contentLanguage) {
    hints.push({
      target: skill.contentLanguage,
      hintType: "runtime",
      description: `Implementation language: ${skill.contentLanguage}`,
    });
  }

  // Tags SkillsMP comme indices (non décisifs)
  for (const tag of skill.tags ?? []) {
    hints.push({
      target: tag,
      hintType: "tooling",
      description: `SkillsMP tag: ${tag}`,
    });
  }

  return hints;
}

/**
 * Construit la provenance depuis les métadonnées brutes SkillsMP et le contexte de découverte.
 */
export function buildCandidateProvenanceFromSkillsMp(
  skill: { id: string; githubUrl?: string; skillUrl?: string; updatedAt?: number },
  discoveredAt: string,
): CandidateProvenance {
  return {
    providerId: "skillsmp",
    externalId: String(skill.id),
    discoveryUrl: skill.skillUrl ? sanitizeUrl(skill.skillUrl) ?? undefined : undefined,
    sourceRepository: skill.githubUrl ? sanitizeUrl(skill.githubUrl) ?? undefined : undefined,
    sourceCommitOrVersion: skill.updatedAt ? String(skill.updatedAt) : undefined,
    maintainer: undefined,
    discoveredAt,
    sourceUpdatedAt: skill.updatedAt ? new Date(skill.updatedAt * 1000).toISOString() : undefined,
  };
}