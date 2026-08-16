import type { MissionContext } from "@/core/context/contract";

import type {
  MissionContextRepository,
  SaveContextResult,
  SaveMissionContextInput,
} from "../ports";
import { validateSaveInput } from "../validate-save";

/**
 * MissionContextRepository in-memory (tests + dev). Reproduit fidèlement la
 * sémantique du backend PostgreSQL :
 * - snapshots versionnés immuables (append-only) ;
 * - latest dérivé de `MAX(version)` ;
 * - concurrence optimiste FAIL-CLOSED via `expectedVersion` ;
 * - isolation stricte par `(tenantId, missionId)`.
 *
 * La section critique de `save` ne contient AUCUN `await` entre la lecture du
 * latest et l'écriture : sous le modèle mono-thread de Node, cela reproduit
 * l'atomicité check-then-insert que PostgreSQL obtient via la clé primaire
 * composite (même discipline que `InMemoryMissionUnitOfWork`).
 */
export class InMemoryMissionContextRepository implements MissionContextRepository {
  /** Clé dérivée de `(tenantId, missionId)` → versions triées par `version`. */
  private readonly byMission = new Map<string, MissionContext[]>();

  private key(tenantId: string, missionId: string): string {
    // Encodage préfixé par longueur : injectif pour des chaînes ARBITRAIRES
    // (aucun séparateur ambigu), donc aucune collision possible même hors du
    // charset d'id validé. Reste de l'ASCII pur (fichier source non binaire).
    return `${tenantId.length}:${tenantId}:${missionId}`;
  }

  async save(input: SaveMissionContextInput): Promise<SaveContextResult> {
    const pre = validateSaveInput(input.context, input.expectedVersion);
    if (!pre.ok) {
      return pre;
    }
    const context = pre.context;

    // ── Début section critique : aucun await jusqu'à l'insertion. ──
    const key = this.key(context.tenantId, context.missionId);
    const versions = this.byMission.get(key);
    const currentLatest =
      versions && versions.length > 0 ? versions[versions.length - 1].version : null;

    // Le latest attendu par l'appelant doit correspondre au latest réel.
    if (input.expectedVersion !== currentLatest) {
      return { ok: false, reason: "stale_version" };
    }

    // Course concurrente : la version cible existe déjà → conflit d'unicité.
    if (versions?.some((v) => v.version === context.version)) {
      return { ok: false, reason: "version_conflict" };
    }

    // Copie défensive : l'artefact stocké est immuable, insensible aux mutations
    // ultérieures de l'objet appelant.
    const stored = structuredClone(context);
    if (versions) {
      versions.push(stored);
    } else {
      this.byMission.set(key, [stored]);
    }
    // ── Fin section critique. ──

    return { ok: true, context: structuredClone(stored) };
  }

  async findLatest(tenantId: string, missionId: string): Promise<MissionContext | null> {
    const versions = this.byMission.get(this.key(tenantId, missionId));
    if (!versions || versions.length === 0) {
      return null;
    }
    return structuredClone(versions[versions.length - 1]);
  }

  async findVersion(
    tenantId: string,
    missionId: string,
    version: number,
  ): Promise<MissionContext | null> {
    const versions = this.byMission.get(this.key(tenantId, missionId));
    const found = versions?.find((v) => v.version === version);
    return found ? structuredClone(found) : null;
  }

  /** Réinitialise le store (tests). */
  reset(): void {
    this.byMission.clear();
  }
}
