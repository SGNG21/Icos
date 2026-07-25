import { z } from "zod";

import { idSchema, isoDateTimeSchema } from "./common";
import { dataCategorySchema, sensitivityLevelSchema } from "./tenant";

// ─────────────────────────────────────
// TrustState — confiance dans le contenu
// ─────────────────────────────────────

export const trustStateSchema = z.enum([
  "untrusted",
  "quarantined",
  "reviewed",
  "approved",
  "rejected",
]);

export type TrustState = z.infer<typeof trustStateSchema>;

// ─────────────────────────────────────
// ActivationState — disponibilité à l'exécution
// ─────────────────────────────────────

export const activationStateSchema = z.enum([
  "inactive",
  "active",
  "suspended",
  "revoked",
]);

export type ActivationState = z.infer<typeof activationStateSchema>;

// ─────────────────────────────────────
// SkillProvenance — traçabilité d'origine
// ─────────────────────────────────────

export const skillSourceSchema = z.enum([
  "internal",
  "local_file",
  "git_repo",
  "url",
  "marketplace",
]);

export type SkillSource = z.infer<typeof skillSourceSchema>;

export const skillWriteOriginSchema = z.enum([
  "human",
  "agent",
  "system",
  "migration",
]);

export type SkillWriteOrigin = z.infer<typeof skillWriteOriginSchema>;

export const skillProvenanceSchema = z.object({
  source: skillSourceSchema,
  origin: skillWriteOriginSchema,
  contentHash: z.string().min(1),
  importedAt: isoDateTimeSchema,
  importedByUserId: idSchema.optional(),
  sourceUrl: z.string().optional(),
  sourceVersion: z.string().optional(),
  sourceRef: z.string().optional(),
  /** Manifest original de la source, opaque JSON. Jamais interprété comme autorité runtime. */
  originalManifest: z.record(z.string(), z.unknown()).optional(),
});

export type SkillProvenance = z.infer<typeof skillProvenanceSchema>;

// ─────────────────────────────────────
// Requirements déclaratifs
// ─────────────────────────────────────

export const skillNetworkRequirementSchema = z.object({
  requiredDomain: z.string().min(1),
  purpose: z.string().min(1),
  required: z.boolean(),
  dataSentDescription: z.string().optional(),
});

export type SkillNetworkRequirement = z.infer<typeof skillNetworkRequirementSchema>;

export const skillCredentialRequirementSchema = z.object({
  requiredCredentialKind: z.string().min(1),
  purpose: z.string().min(1),
  requiredScope: z.string().min(1),
  required: z.boolean(),
});

export type SkillCredentialRequirement = z.infer<typeof skillCredentialRequirementSchema>;

export const skillExecutionIsolationRequirementSchema = z.object({
  requiredIsolationLevel: z.enum(["none", "process", "container", "sandbox"]),
  requiredFsReadPaths: z.array(z.string()),
  requiredFsWritePaths: z.array(z.string()),
  requiredNetworkMode: z.enum(["none", "outbound", "inbound", "both"]),
  justification: z.string().min(1),
});

export type SkillExecutionIsolationRequirement = z.infer<
  typeof skillExecutionIsolationRequirementSchema
>;

export const skillToolRequirementSchema = z.object({
  requiredTool: z.string().min(1),
  required: z.boolean(),
  purpose: z.string().min(1),
});

export type SkillToolRequirement = z.infer<typeof skillToolRequirementSchema>;

export const skillDependencyDeclarationSchema = z.object({
  dependencySkillKey: z.string().min(1),
  versionConstraint: z.string().optional(),
  optional: z.boolean(),
});

export type SkillDependencyDeclaration = z.infer<typeof skillDependencyDeclarationSchema>;

// ─────────────────────────────────────
// Contenu du skill
// ─────────────────────────────────────

export const skillScriptSchema = z.object({
  name: z.string().min(1),
  language: z.string().min(1),
  entrypoint: z.boolean(),
  content: z.string(),
});

export type SkillScript = z.infer<typeof skillScriptSchema>;

export const skillResourceSchema = z.object({
  path: z.string().min(1),
  type: z.string().min(1),
  content: z.string().optional(),
});

export type SkillResource = z.infer<typeof skillResourceSchema>;

export const skillReferenceSchema = z.object({
  url: z.string().min(1),
  description: z.string().min(1),
  type: z.enum(["documentation", "source", "eval", "runtime"]),
});

export type SkillReference = z.infer<typeof skillReferenceSchema>;

// ─────────────────────────────────────
// Security Scans & Findings
// ─────────────────────────────────────

export const findingSeveritySchema = z.enum(["low", "medium", "high", "critical"]);

export type FindingSeverity = z.infer<typeof findingSeveritySchema>;

export const findingCategorySchema = z.enum([
  "prompt_injection",
  "exfiltration",
  "privilege_escalation",
  "dangerous_code",
  "supply_chain",
  "excessive_agency",
  "tool_poisoning",
]);

export type FindingCategory = z.infer<typeof findingCategorySchema>;

export const securityScanStatusSchema = z.enum(["running", "passed", "failed", "error"]);

export type SecurityScanStatus = z.infer<typeof securityScanStatusSchema>;

export const securityScanSchema = z.object({
  id: idSchema,
  tenantId: z.string().min(1),
  skillId: idSchema,
  evaluatedContentHash: z.string().min(1),
  scannerId: z.string().min(1),
  scannerVersion: z.string().optional(),
  status: securityScanStatusSchema,
  startedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: isoDateTimeSchema,
});

export type SecurityScan = z.infer<typeof securityScanSchema>;

export const securityFindingSchema = z.object({
  id: idSchema,
  scanId: idSchema,
  severity: findingSeveritySchema,
  category: findingCategorySchema,
  code: z.string().optional(),
  message: z.string().min(1),
  location: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: isoDateTimeSchema,
});

export type SecurityFinding = z.infer<typeof securityFindingSchema>;

// ─────────────────────────────────────
// Evaluations
// ─────────────────────────────────────

export const evalStatusSchema = z.enum(["running", "passed", "failed", "error"]);

export type EvalStatus = z.infer<typeof evalStatusSchema>;

export const evaluationSchema = z.object({
  id: idSchema,
  tenantId: z.string().min(1),
  skillId: idSchema,
  evaluatedContentHash: z.string().min(1),
  evaluatorType: z.string().min(1),
  evaluatorVersion: z.string().optional(),
  status: evalStatusSchema,
  score: z.record(z.string(), z.unknown()).optional(),
  startedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: isoDateTimeSchema,
});

export type Evaluation = z.infer<typeof evaluationSchema>;

// ─────────────────────────────────────
// Skill (entité principale)
// ─────────────────────────────────────

export const skillSchema = z.object({
  id: idSchema,
  tenantId: z.string().min(1),
  skillKey: z.string().min(1),
  version: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  capabilityKeys: z.array(z.string()).default([]),
  category: z.string().min(1),
  trustState: trustStateSchema,
  activationState: activationStateSchema,
  scripts: z.array(skillScriptSchema).optional(),
  resources: z.array(skillResourceSchema).optional(),
  references: z.array(skillReferenceSchema).optional(),
  dependencyDeclarations: z.array(skillDependencyDeclarationSchema).optional(),
  networkRequirements: z.array(skillNetworkRequirementSchema).optional(),
  credentialRequirements: z.array(skillCredentialRequirementSchema).optional(),
  executionIsolationRequirement: skillExecutionIsolationRequirementSchema.optional(),
  toolRequirements: z.array(skillToolRequirementSchema).optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  dataCategory: dataCategorySchema.optional(),
  sensitivityLevel: sensitivityLevelSchema.optional(),
  contentHash: z.string().min(1),
  provenance: skillProvenanceSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type Skill = z.infer<typeof skillSchema>;

/**
 * Filtres optionnels pour la liste des skills.
 */
export interface SkillListFilters {
  trustState?: string;
  activationState?: string;
  capabilityKey?: string;
  skillKey?: string;
}

/**
 * Liste des champs de Skill qui participent au contentHash.
 * Utilisée par le helper de hash canonique et par les guards d'immutabilité.
 */
export const CONTENT_HASH_FIELDS = [
  "skillKey",
  "version",
  "name",
  "description",
  "category",
  "capabilityKeys",
  "scripts",
  "resources",
  "references",
  "dependencyDeclarations",
  "networkRequirements",
  "credentialRequirements",
  "executionIsolationRequirement",
  "toolRequirements",
  "inputSchema",
  "outputSchema",
  "provenance.originalManifest",
] as const;

/**
 * États dans lesquels le contenu du skill peut être modifié.
 */
export const CONTENT_MUTABLE_TRUST_STATES: readonly TrustState[] = [
  "untrusted",
  "quarantined",
  "reviewed",
];

/**
 * États dans lesquels le contenu du skill est IMMUTABLE.
 */
export const CONTENT_IMMUTABLE_TRUST_STATES: readonly TrustState[] = [
  "approved",
  "rejected",
];
