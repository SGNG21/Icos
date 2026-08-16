import type { MissionContext } from "@/core/context/contract";

/**
 * CTX-SUP-1B — Port de persistance du MissionContext.
 *
 * INVARIANTS DE FRONTIÈRE (voir spec CTX-SUP-1 §6.1) :
 *   Persistance ≠ Authorization
 *   Stored Context ≠ Approval
 *   Stored Context ≠ ExecutionGrant
 *   Memory ≠ Audit Log
 *
 * Ce port ne transporte QUE de l'information de lecture versionnée. Il n'expose
 * ni n'accepte aucun champ d'autorité (grant, décision allow, approbation,
 * credential, token) — cette garantie est structurelle : le payload est un
 * `MissionContext` `.strict()` (CTX-SUP-1A).
 *
 * Modèle canonique (validé) :
 * - snapshots versionnés IMMUABLES (append-only, jamais de mutation en place) ;
 * - « latest » DÉRIVÉ de l'ordre des versions ;
 * - identité ET concurrence portées par `(tenantId, missionId, version)` ;
 * - concurrence optimiste FAIL-CLOSED via `expectedVersion` (aucun
 *   last-write-wins silencieux, aucun trou, aucune régression).
 */

/** Raison d'échec d'un `save` — toujours explicite, jamais un silence. */
export type SaveConflictReason =
  /** `expectedVersion` ne correspond pas au latest actuel (writer périmé/régressif). */
  | "stale_version"
  /** Violation d'unicité à l'INSERT : une course concurrente a gagné la version. */
  | "version_conflict"
  /** `context.version` ≠ `(expectedVersion ?? -1) + 1` (intégrité du payload). */
  | "version_mismatch"
  /** Schéma strict / bornes / champ d'autorité / entrée non sérialisable. */
  | "invalid_context";

export type SaveContextResult =
  { ok: true; context: MissionContext } | { ok: false; reason: SaveConflictReason };

export interface SaveMissionContextInput {
  context: MissionContext;
  /**
   * Version latest attendue AVANT ce write. `null` = aucun contexte préexistant
   * attendu (le premier write doit porter `version = 0`). Le nouveau `context`
   * doit porter `(expectedVersion ?? -1) + 1`.
   */
  expectedVersion: number | null;
}

export interface MissionContextRepository {
  /**
   * Ajoute une nouvelle version immuable (append). Fail-closed : refuse plutôt
   * que d'écraser ou de deviner. Voir `SaveConflictReason`.
   */
  save(input: SaveMissionContextInput): Promise<SaveContextResult>;

  /** Dernière version connue pour `(tenant, mission)`, ou `null`. */
  findLatest(tenantId: string, missionId: string): Promise<MissionContext | null>;

  /** Version exacte pour `(tenant, mission)`, ou `null` si absente. */
  findVersion(tenantId: string, missionId: string, version: number): Promise<MissionContext | null>;
}

/**
 * Référence bornée vers un MissionContext persisté — À DESTINATION d'une
 * éventuelle émission d'audit PAR L'APPELANT. Cette couche n'écrit AUCUN audit
 * elle-même et ne duplique JAMAIS le payload complet (`Memory ≠ Audit Log`).
 */
export interface MissionContextRef {
  tenantId: string;
  missionId: string;
  version: number;
  builtAt: string;
}

/** Extrait une référence bornée (jamais le payload complet). Pur, sans effet. */
export function missionContextRef(context: MissionContext): MissionContextRef {
  return {
    tenantId: context.tenantId,
    missionId: context.missionId,
    version: context.version,
    builtAt: context.builtAt,
  };
}
