import { auditEntrySchema, type AuditEntry, type AuditEventType } from "@/core/contracts";
import { compareAuditEntries } from "@/core/ordering";

export interface AuditQuery {
  eventType?: AuditEventType;
  actorId?: string;
  taskId?: string;
  actionId?: string;
}

/**
 * Journal d'audit append-only : l'interface publique ne permet ni
 * modification ni suppression d'une entrée enregistrée.
 */
export interface AuditLog {
  append(entry: AuditEntry): AuditEntry;
  /**
   * Ajoute plusieurs entrées de façon atomique : toutes les entrées sont
   * validées avant qu'aucune ne soit écrite. Si l'une est invalide, aucune
   * n'est enregistrée.
   */
  appendMany(entries: readonly AuditEntry[]): readonly AuditEntry[];
  list(): readonly AuditEntry[];
  query(filter: AuditQuery): readonly AuditEntry[];
}

/**
 * AVERTISSEMENT — implémentation temporaire en mémoire :
 * - aucune persistance : tout est perdu au redémarrage du processus ;
 * - non fiable entre plusieurs instances ou processus (état local uniquement) ;
 * - non adapté à la production et ne constitue AUCUNE garantie d'audit ;
 * - remplacement prévu par un journal persistant PostgreSQL (roadmap phase 1),
 *   qui apportera aussi la véritable atomicité transactionnelle
 *   mutation + audit, impossible à garantir ici.
 */
export class InMemoryAuditLog implements AuditLog {
  private readonly entries: AuditEntry[] = [];

  /** Valide puis enregistre une copie de l'entrée. Lève si l'entrée est invalide. */
  append(entry: AuditEntry): AuditEntry {
    const validated = auditEntrySchema.parse(entry);
    this.entries.push(structuredClone(validated));
    return structuredClone(validated);
  }

  /**
   * Ajoute plusieurs entrées de façon atomique : toutes sont d'abord validées ;
   * ce n'est qu'ensuite qu'elles sont écrites. Une entrée invalide fait lever
   * avant toute écriture, de sorte qu'aucune entrée partielle ne subsiste.
   */
  appendMany(entries: readonly AuditEntry[]): readonly AuditEntry[] {
    const validated = entries.map((entry) => auditEntrySchema.parse(entry));
    const stored = validated.map((entry) => structuredClone(entry));
    this.entries.push(...stored);
    return stored.map((entry) => structuredClone(entry));
  }

  list(): readonly AuditEntry[] {
    return this.entries.map((entry) => structuredClone(entry)).sort(compareAuditEntries);
  }

  query(filter: AuditQuery): readonly AuditEntry[] {
    return this.entries
      .filter(
        (entry) =>
          (filter.eventType === undefined || entry.eventType === filter.eventType) &&
          (filter.actorId === undefined || entry.actor.id === filter.actorId) &&
          (filter.taskId === undefined || entry.taskId === filter.taskId) &&
          (filter.actionId === undefined || entry.actionId === filter.actionId),
      )
      .map((entry) => structuredClone(entry))
      .sort(compareAuditEntries);
  }
}
