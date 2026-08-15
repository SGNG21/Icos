import { readFile } from "node:fs/promises";

import { z } from "zod";

/**
 * F5.2 (Phase 2 hardening) — Approbation humaine explicite des effets
 * externes autonomes (git push, création de PR).
 *
 * INVARIANT (fail-closed) : aucun effet externe autonome sans approbation
 * humaine explicite, vérifiable et non expirée. Toute condition anormale —
 * approbation absente, illisible, malformée, refusée, hors périmètre ou
 * périmée — BLOQUE l'effet externe. Il n'existe aucun chemin par défaut
 * vers l'autorisation.
 *
 * L'approbation est un artefact JSON créé par un humain (jamais par le
 * script lui-même), par exemple `.icos/approvals/<mission>.json` :
 * ```json
 * {
 *   "approved": true,
 *   "scope": "git-push+pr-create",
 *   "branch": "integration/*",
 *   "approvedBy": "owner@icos",
 *   "approvedAt": "2026-08-15T10:00:00.000Z",
 *   "expiresAt": "2026-08-15T18:00:00.000Z"
 * }
 * ```
 */

export const EXTERNAL_EFFECT_SCOPE_PUSH_PR = "git-push+pr-create";

export const externalEffectApprovalSchema = z.object({
  /** Doit être le booléen littéral true — toute autre valeur = refus. */
  approved: z.boolean(),
  /** Périmètre exact de l'effet externe approuvé. */
  scope: z.string().min(1),
  /**
   * Branche autorisée : correspondance exacte, ou motif préfixe explicite
   * terminé par `/*` (ex. `integration/*`) — jamais de joker implicite.
   */
  branch: z.string().min(1),
  /** Identité humaine de l'approbateur. */
  approvedBy: z.string().min(1),
  /** Horodatage ISO de l'approbation. */
  approvedAt: z.string().datetime(),
  /** Expiration ISO — une approbation sans expiration valide est rejetée. */
  expiresAt: z.string().datetime(),
});

export type ExternalEffectApproval = z.infer<typeof externalEffectApprovalSchema>;

export type ApprovalDenialCode =
  | "missing"
  | "unavailable"
  | "malformed"
  | "denied"
  | "scope_mismatch"
  | "branch_mismatch"
  | "stale";

export type ExternalEffectApprovalDecision =
  | { granted: true; approval: ExternalEffectApproval }
  | { granted: false; code: ApprovalDenialCode; reason: string };

export interface ExpectedExternalEffect {
  scope: string;
  branch: string;
}

function blocked(code: ApprovalDenialCode, reason: string): ExternalEffectApprovalDecision {
  return { granted: false, code, reason };
}

/** Correspondance de branche : exacte, ou motif préfixe explicite `prefix/*`. */
export function branchMatches(pattern: string, branch: string): boolean {
  if (pattern === branch) return true;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1); // conserve le "/" final
    // Le motif doit couvrir un espace de noms non vide et la branche doit
    // avoir un segment non vide après le préfixe.
    return prefix.length > 1 && branch.startsWith(prefix) && branch.length > prefix.length;
  }
  return false;
}

/**
 * Évalue une approbation brute (déjà parsée depuis JSON) contre l'effet
 * externe attendu. Fonction pure — testable exhaustivement.
 */
export function evaluateExternalEffectApproval(
  raw: unknown,
  expected: ExpectedExternalEffect,
  now: Date = new Date(),
): ExternalEffectApprovalDecision {
  if (raw === null || raw === undefined) {
    return blocked("missing", "Aucune approbation fournie");
  }

  const parsed = externalEffectApprovalSchema.safeParse(raw);
  if (!parsed.success) {
    return blocked(
      "malformed",
      `Approbation malformée : ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(racine)"} — ${issue.message}`)
        .join("; ")}`,
    );
  }

  const approval = parsed.data;

  if (approval.approved !== true) {
    return blocked("denied", `Approbation refusée par ${approval.approvedBy}`);
  }

  if (approval.scope !== expected.scope) {
    return blocked(
      "scope_mismatch",
      `Périmètre approuvé « ${approval.scope} » ≠ périmètre requis « ${expected.scope} »`,
    );
  }

  if (!branchMatches(approval.branch, expected.branch)) {
    return blocked(
      "branch_mismatch",
      `Branche approuvée « ${approval.branch} » ne couvre pas « ${expected.branch} »`,
    );
  }

  const expiresAtMs = Date.parse(approval.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) {
    return blocked(
      "stale",
      `Approbation expirée (expiresAt=${approval.expiresAt}, now=${now.toISOString()})`,
    );
  }

  return { granted: true, approval };
}

/**
 * Charge et évalue un artefact d'approbation depuis le disque.
 * Fail-closed : fichier absent → `missing` ; erreur de lecture →
 * `unavailable` ; JSON invalide → `malformed`.
 */
export async function loadExternalEffectApproval(
  filePath: string,
  expected: ExpectedExternalEffect,
  now: Date = new Date(),
): Promise<ExternalEffectApprovalDecision> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return blocked("missing", `Artefact d'approbation absent : ${filePath}`);
    }
    return blocked(
      "unavailable",
      `Artefact d'approbation illisible (${code ?? "erreur inconnue"}) : ${filePath}`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return blocked("malformed", `Artefact d'approbation non-JSON : ${filePath}`);
  }

  return evaluateExternalEffectApproval(raw, expected, now);
}
