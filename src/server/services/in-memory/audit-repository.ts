import type { AuditEntry } from "@/core/contracts";

import type { AuditQuery, InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import type { AuditRepository } from "@/server/repositories/ports";

/**
 * Adaptateur asynchrone au-dessus de la primitive synchrone `InMemoryAuditLog`.
 * Destiné aux lectures (routes) et aux usages repository ordinaires. L'unité de
 * travail mémoire utilise, elle, la primitive synchrone directement afin de
 * préserver sa section critique non interruptible.
 */
export class InMemoryAuditRepository implements AuditRepository {
  constructor(private readonly log: InMemoryAuditLog) {}

  async append(entry: AuditEntry): Promise<AuditEntry> {
    return this.log.append(entry);
  }

  async appendMany(entries: readonly AuditEntry[]): Promise<AuditEntry[]> {
    return [...this.log.appendMany(entries)];
  }

  async list(): Promise<AuditEntry[]> {
    return [...this.log.list()];
  }

  async query(filter: AuditQuery): Promise<AuditEntry[]> {
    return [...this.log.query(filter)];
  }
}
