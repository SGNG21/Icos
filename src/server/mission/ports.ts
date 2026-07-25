import type { AuditEntry } from "@/core/contracts";
import type {
  Mission,
  MissionResult,
  MissionStatus,
} from "@/core/mission";

/**
 * Repository de missions — accès persistant aux missions.
 * L'implémentation en mémoire est suffisante pour D2 ;
 * PostgreSQL sera ajouté quand la persistance durable sera requise.
 */
export interface MissionRepository {
  create(mission: Mission): Promise<Mission>;
  update(mission: Mission): Promise<Mission>;
  findById(id: string): Promise<Mission | null>;
  findByStatus(status: MissionStatus): Promise<Mission[]>;
  /** Retourne toutes les missions non terminales. */
  findActive(): Promise<Mission[]>;
  /** Retourne les missions dans un état donné depuis plus longtemps que `olderThanMs`. */
  findStaleBefore(olderThanMs: number): Promise<Mission[]>;
}

/**
 * Unité de travail transactionnelle pour les mutations critiques de mission.
 */
export interface MissionUnitOfWork {
  /**
   * Transitionne l'état d'une mission avec vérification de l'état source
   * attendu et écriture atomique de l'audit.
   */
  transitionStatus(input: {
    missionId: string;
    fromStatus: MissionStatus;
    toStatus: MissionStatus;
    auditEntry: AuditEntry;
  }): Promise<MissionResult<{ mission: Mission }>>;
}
